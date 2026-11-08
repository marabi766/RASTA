import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { authoredFiles } from './authored-source-inventory.cjs';
import { BACKOFF, TOOLS, download, transient } from './ci-tool-download.mjs';

const root = new URL('../', import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), 'utf8');
const bytes = 'verified archive';
const tool = {
  url: 'https://example.invalid/pinned',
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
function harness(t, results) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-tool-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const archive = join(dir, 'archive');
  let calls = 0;
  const delays = [];
  const deps = {
    curl: (command, args, options) => {
      assert.equal(command, 'curl');
      assert.equal(options.timeout, 155_000);
      assert.ok(args.includes('--max-time'));
      assert.ok(args.includes('--proto-redir'));
      const result = results[Math.min(calls++, results.length - 1)];
      writeFileSync(`${archive}.partial`, result.body ?? bytes);
      return result;
    },
    sleep: (s) => {
      delays.push(s);
      return { status: 0 };
    },
  };
  return { archive, deps, delays, calls: () => calls };
}
test('retry network errors, verify, then reuse cache without network', (t) => {
  const h = harness(t, [
    { status: 22, stdout: '504' },
    { status: 28, stdout: '000' },
    { status: 0 },
  ]);
  download(tool, h.archive, h.deps);
  download(tool, h.archive, h.deps);
  assert.equal(h.calls(), 3);
  assert.deepEqual(h.delays, [5, 15]);
  assert.equal(readFileSync(h.archive, 'utf8'), bytes);
});
test('exhausted retries leave neither cache nor partial file', (t) => {
  const h = harness(t, [{ status: 22, stdout: '503' }]);
  assert.throws(() => download(tool, h.archive, h.deps));
  assert.equal(h.calls(), 4);
  assert.deepEqual(h.delays, BACKOFF);
  assert.equal(existsSync(h.archive), false);
  assert.equal(existsSync(`${h.archive}.partial`), false);
});
for (const result of [
  { status: 0, body: 'corrupt' },
  { status: 22, stdout: '404' },
  { status: 60 },
  { status: null },
]) {
  test(`permanent/unverified result fails once: ${JSON.stringify(result)}`, (t) => {
    const h = harness(t, [result]);
    assert.throws(() => download(tool, h.archive, h.deps));
    assert.equal(h.calls(), 1);
    assert.deepEqual(h.delays, []);
    assert.equal(existsSync(h.archive), false);
    assert.equal(existsSync(`${h.archive}.partial`), false);
  });
}
test('corrupt cache is refused without fetching a replacement', (t) => {
  const h = harness(t, [{ status: 0 }]);
  writeFileSync(h.archive, 'corrupt cache');
  assert.throws(() => download(tool, h.archive, h.deps), /checksum mismatch/);
  assert.equal(h.calls(), 0);
});
test('only recognized network results retry', () => {
  for (const code of [5, 6, 7, 18, 28, 52, 55, 56]) assert.equal(transient(code, '000'), true);
  for (const http of ['408', '429', '500', '502', '503', '504'])
    assert.equal(transient(22, http), true);
  for (const code of [1, 23, 35, 60, null]) assert.equal(transient(code, '000'), false);
  assert.equal(transient(28, '403'), false);
  assert.equal(transient(28, '200'), true);
});
test('helper caches by exact version and checksum, with no fallback key or skipped install', () => {
  const steps = parse(read('.github/actions/install-ci-tool/action.yml')).runs.steps;
  assert.equal(steps[1].uses, 'actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830');
  assert.deepEqual(Object.keys(steps[1].with).sort(), ['key', 'path']);
  assert.match(steps[2].run, /ci-tool-download.mjs install/);
  for (const step of steps) {
    assert.equal(step.if, undefined);
    assert.equal(step['continue-on-error'], undefined);
  }
  const source = read('scripts/ci-tool-download.mjs');
  assert.ok(source.includes('${name}-${tool.version}-${tool.sha256}'));
  for (const pin of Object.values(TOOLS)) {
    assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    assert.ok(pin.url.includes(pin.version));
    assert.ok(!pin.url.includes('latest'));
  }
});
// Slice A covers release archives. Existing setup/DB/package/image downloads remain
// explicit follow-up work; adding another release installer here must use the helper.
function releaseCoverage(source) {
  for (const match of source.matchAll(/uses:\s*([^\s#]+)/g)) {
    const action = match[1];
    assert.ok(
      !/setup-go@|gitleaks-action@/.test(action),
      `unverified release installer: ${action}`,
    );
  }
  assert.ok(
    !/(?:curl|wget)[^\n]*(?:releases\/download|go\.dev\/dl)/.test(source),
    'raw release fetch',
  );
}
test('every workflow and composite rejects release downloads outside the helper', () => {
  for (const file of authoredFiles(join(root, '.github')))
    if (/\.ya?ml$/.test(file)) releaseCoverage(readFileSync(file, 'utf8'));
  const jobs = parse(read('.github/workflows/ci.yml')).jobs;
  for (const [job, name] of [
    ['security', 'gitleaks'],
    ['trivy-db', 'go'],
  ]) {
    const setup = jobs[job].steps.find((s) => s.with?.tool === name);
    assert.equal(setup.uses, './.github/actions/install-ci-tool');
    assert.ok(setup['timeout-minutes'] * 60 >= 4 * 155 + 50 + 60);
  }
  assert.match(
    jobs.security.steps.find((s) => s.name === 'Secret scan').run,
    /--redact --exit-code=2 --log-opts="--no-merges --first-parent \$SCAN_BASE\^\.\.\$SCAN_HEAD"/,
  );
});
test('coverage refuses reintroduced Go/Gitleaks installers and raw release fetches', () => {
  for (const source of [
    'uses: actions/setup-go@abc',
    'uses: gitleaks/gitleaks-action@abc',
    'run: curl https://github.com/x/releases/download/v1/tool',
    'run: wget https://go.dev/dl/tool',
  ])
    assert.throws(() => releaseCoverage(source));
});
