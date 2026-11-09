import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { authoredFiles } from './authored-source-inventory.cjs';
import { fixtureGitEnv } from './fixture-git-env.mjs';
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
test('corrupt cache is discarded and replaced only with verified bytes', (t) => {
  const h = harness(t, [{ status: 0 }]);
  writeFileSync(h.archive, 'corrupt cache');
  download(tool, h.archive, h.deps);
  assert.equal(h.calls(), 1);
  assert.equal(readFileSync(h.archive, 'utf8'), bytes);
});
test('corrupt cache and corrupt replacement leave no usable archive', (t) => {
  const h = harness(t, [{ status: 0, body: 'corrupt replacement' }]);
  writeFileSync(h.archive, 'corrupt cache');
  assert.throws(() => download(tool, h.archive, h.deps), /checksum mismatch/);
  assert.equal(h.calls(), 1);
  assert.equal(existsSync(h.archive), false);
  assert.equal(existsSync(`${h.archive}.partial`), false);
});
test('only recognized network results retry', () => {
  const transport = [5, 6, 7, 16, 18, 28, 35, 52, 55, 56, 80, 92, 95, 96];
  const retryHttp = ['408', '429', '500', '502', '503', '504'];
  for (const code of [...Array(101).keys(), null, undefined, 999])
    for (const http of [
      '000',
      '200',
      '206',
      '301',
      '302',
      '307',
      '308',
      '403',
      '404',
      ...retryHttp,
    ])
      assert.equal(
        transient(code, http),
        transport.includes(code) || (code === 22 && retryHttp.includes(http)),
      );
  for (const http of retryHttp) assert.equal(transient(22, http), true);
  for (const http of ['301', '302', '403', '404']) assert.equal(transient(22, http), false);
});
test('real curl: retry a failed redirect target, refuse a redirected 404', async (t) => {
  const closed = createServer().listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const port = closed.address().port;
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/404' ? 404 : 302, {
      location: req.url === '/broken' ? `http://127.0.0.1:${port}` : '/404',
    });
    res.end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  await new Promise((resolve) => closed.close(resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const [path, status, http] of [
    ['/broken', 7, '302'],
    ['/missing', 22, '404'],
  ]) {
    const child = spawn('curl', [
      '-fsSL',
      '--max-time',
      '3',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      `http://127.0.0.1:${server.address().port}${path}`,
    ]);
    let stdout = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    const [code] = await once(child, 'close');
    assert.equal(code, status);
    assert.equal(stdout, http);
    const h = harness(t, [{ status: code, stdout }, { status: 0 }]);
    if (code === 7) download(tool, h.archive, h.deps);
    else assert.throws(() => download(tool, h.archive, h.deps));
    assert.equal(h.calls(), code === 7 ? 2 : 1);
  }
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
  assert.ok(source.includes('ci-tool-v2-linux-x64-${name}-${tool.version}-${tool.sha256}'));
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
    /--verbose --redact --exit-code=2 --log-opts="--full-history --diff-merges=remerge \$SCAN_BASE\.\.\$SCAN_HEAD"/,
  );
  assert.deepEqual(jobs.security.permissions, { contents: 'read' });
  const topologyAt = jobs.security.steps.findIndex(
    (s) => s.name === 'Test pinned Gitleaks scan topologies',
  );
  assert.ok(topologyAt > jobs.security.steps.findIndex((s) => s.with?.tool === 'gitleaks'));
  assert.match(
    jobs.security.steps[topologyAt].run,
    /GITLEAKS_TEST_BINARY="\$\(command -v gitleaks\)"/,
  );
  assert.match(jobs.security.steps[topologyAt].run, /export GITLEAKS_TEST_BINARY/);
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

// Execute the exact workflow shell against real Git topologies. The default
// scanner exposes its input patch; set GITLEAKS_TEST_BINARY for the pinned CLI.
const topologyTest = (name, body) =>
  test(name, { skip: !!process.env.CI && !process.env.GITLEAKS_TEST_BINARY }, body);
function rangeHarness(t) {
  assert.ok(
    !process.env.CI || process.env.GITLEAKS_TEST_BINARY,
    'CI topologies require pinned Gitleaks',
  );
  const dir = mkdtempSync(join(tmpdir(), 'ci-range-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: fixtureGitEnv() });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'CI range fixture');
  git('config', 'user.email', 'ci-range@example.invalid');
  writeFileSync(
    join(dir, '.gitleaks.toml'),
    '[[rules]]\nid = "range-fixture"\ndescription = "Synthetic test marker"\nregex = "CI_RANGE_FIXTURE_[A-Z0-9]+"\n',
  );
  const commit = (name, body = name) => {
    writeFileSync(join(dir, name), body);
    git('add', '.');
    git('commit', '-m', name);
    return git('rev-parse', 'HEAD');
  };
  const base = commit('base');
  const bin = join(dir, '.git', 'test-bin');
  mkdirSync(bin);
  if (process.env.GITLEAKS_TEST_BINARY)
    symlinkSync(process.env.GITLEAKS_TEST_BINARY, join(bin, 'gitleaks'));
  else
    writeFileSync(
      join(bin, 'gitleaks'),
      `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const opts = process.argv.find(a => a.startsWith('--log-opts=')).slice(11);
const r = spawnSync('git', ['log', '-p', '-U0', ...opts.split(' ')], { encoding: 'utf8' });
console.error('INF scanned ~0 bytes (0) in 1ms');
process.exit(r.status || (r.stdout.includes('CI_RANGE_FIXTURE_') ? 2 : 0));
`,
      { mode: 0o755 },
    );
  const workflow = parse(read('.github/workflows/ci.yml'));
  const scan = (from, head) =>
    spawnSync(
      'bash',
      ['-c', workflow.jobs.security.steps.find((s) => s.name === 'Secret scan').run],
      {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...fixtureGitEnv(),
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: dir,
          SCAN_BASE: from,
          SCAN_HEAD: head,
        },
      },
    );
  return { git, commit, base, scan, bin, dir };
}
test(
  'configured scanner is the pinned Gitleaks version',
  { skip: !process.env.GITLEAKS_TEST_BINARY },
  () => {
    const result = spawnSync(process.env.GITLEAKS_TEST_BINARY, ['version'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), TOOLS.gitleaks.version);
  },
);
for (const firstParent of ['feature', 'main']) {
  topologyTest(
    `approved main finding is not re-attributed when merging with ${firstParent} first`,
    (t) => {
      const h = rangeHarness(t);
      h.git('checkout', '-b', 'feature');
      h.commit('feature');
      h.git('checkout', 'main');
      const approved = h.commit('approved', 'CI_RANGE_FIXTURE_APPROVED');
      const base = h.commit('.gitleaksignore', `${approved}:approved:range-fixture:1\n`);
      if (process.env.GITLEAKS_TEST_BINARY) assert.equal(h.scan(h.base, base).status, 0);
      h.git('checkout', firstParent);
      h.git('merge', '--no-ff', firstParent === 'feature' ? 'main' : 'feature', '-m', 'merge');
      const result = h.scan(base, h.git('rev-parse', 'HEAD'));
      assert.equal(result.status, 0, result.stdout + result.stderr);
    },
  );
}
topologyTest('conflict resolution introducing a secret fails with a redacted location', (t) => {
  const h = rangeHarness(t);
  h.git('checkout', '-b', 'side');
  h.commit('base', 'side conflict');
  h.git('checkout', 'main');
  const base = h.commit('base', 'main conflict');
  const merge = spawnSync('git', ['merge', '--no-ff', 'side', '-m', 'conflict'], {
    cwd: h.dir,
    env: fixtureGitEnv(),
  });
  assert.equal(merge.status, 1);
  const head = h.commit('base', 'CI_RANGE_FIXTURE_RESOLUTION');
  const result = h.scan(base, head);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  if (process.env.GITLEAKS_TEST_BINARY) {
    assert.match(result.stdout, /File:\s+b\/base(?:\r?\n|$)/);
    assert.match(result.stdout, /Line:\s+1/);
    assert.ok(result.stdout.includes(`${head}:b/base:range-fixture:1`));
    assert.ok(!result.stdout.includes('CI_RANGE_FIXTURE_RESOLUTION'));
  }
});
topologyTest('octopus merge content is refused because Git cannot remerge it', (t) => {
  const h = rangeHarness(t);
  for (const branch of ['side-a', 'side-b']) {
    h.git('checkout', '-b', branch, h.base);
    h.commit(branch);
  }
  h.git('checkout', 'main');
  h.commit('main-work');
  h.git('merge', '--no-ff', '--no-commit', 'side-a', 'side-b');
  const head = h.commit('merge-only', 'CI_RANGE_FIXTURE_OCTOPUS');
  assert.notEqual(h.scan(h.base, head).status, 0);
});
topologyTest('scan includes a second-parent secret even when removed before the merge', (t) => {
  const h = rangeHarness(t);
  h.git('checkout', '-b', 'side');
  h.commit('side', 'CI_RANGE_FIXTURE_SECONDPARENT');
  h.commit('side', 'removed');
  h.git('checkout', 'main');
  h.commit('main-work');
  h.git('merge', '--no-ff', 'side', '-m', 'merge');
  assert.equal(h.scan(h.base, h.git('rev-parse', 'HEAD')).status, 2);
});
topologyTest('scan includes secrets introduced inside a merge commit', (t) => {
  const h = rangeHarness(t);
  h.git('checkout', '-b', 'side');
  h.commit('side');
  h.git('checkout', 'main');
  h.commit('main-work');
  h.git('merge', '--no-ff', '--no-commit', 'side');
  const head = h.commit('merge-only', 'CI_RANGE_FIXTURE_MERGECONTENT');
  assert.equal(h.scan(h.base, head).status, 2);
});
topologyTest('force-push scans new reachable commits and refuses an empty unequal range', (t) => {
  const h = rangeHarness(t);
  const old = h.commit('old-tip');
  h.git('checkout', '-b', 'replacement', h.base);
  const head = h.commit('new-tip', 'CI_RANGE_FIXTURE_FORCEPUSH');
  assert.equal(h.scan(old, head).status, 2);
  assert.notEqual(h.scan(head, h.base).status, 0);
});
topologyTest('scan refuses unreadable or malformed refs and permits a valid clean range', (t) => {
  const h = rangeHarness(t);
  const head = h.commit('clean');
  assert.equal(h.scan(h.base, head).status, 0);
  assert.equal(h.scan(head, head).status, 0);
  for (const bad of ['0'.repeat(40), 'missing', `${head};exit 0`]) {
    assert.notEqual(h.scan(bad, head).status, 0);
    assert.notEqual(h.scan(h.base, bad).status, 0);
  }
});
test(
  'pinned scanner exits zero on an invalid range, but workflow refuses it',
  { skip: !process.env.GITLEAKS_TEST_BINARY },
  (t) => {
    const h = rangeHarness(t);
    const bad = '0'.repeat(40);
    const result = spawnSync(
      process.env.GITLEAKS_TEST_BINARY,
      ['detect', '--redact', `--log-opts=${bad}..${h.base}`],
      { cwd: h.dir, encoding: 'utf8', env: fixtureGitEnv() },
    );
    assert.equal(result.status, 0); // Pinned upstream behavior: preflight is mandatory.
    assert.match(result.stderr, /Invalid revision range/);
    assert.notEqual(h.scan(bad, h.base).status, 0);
  },
);
for (const failure of ['rev-list', 'log']) {
  topologyTest(
    `scan refuses a failed ${failure} read even if Git emitted a positive count`,
    (t) => {
      const h = rangeHarness(t);
      const head = h.commit('clean');
      writeFileSync(
        join(h.bin, 'git'),
        `#!/usr/bin/env node
if (process.argv[2] === '${failure}') { process.stdout.write('1\\n'); process.exit(128); }
const { spawnSync } = require('node:child_process');
const r = spawnSync('git', process.argv.slice(2), {
  env: { ...process.env, PATH: process.env.PATH.split(':').slice(1).join(':') }, stdio: 'inherit',
});
process.exit(r.status ?? 1);
`,
        { mode: 0o755 },
      );
      assert.notEqual(h.scan(h.base, head).status, 0);
    },
  );
}
test('push ranges cannot cancel or displace one another; PR updates may supersede', () => {
  assert.deepEqual(parse(read('.github/workflows/ci.yml')).concurrency, {
    group: "ci-${{ github.event_name == 'push' && github.run_id || github.ref }}",
    'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
  });
});

for (const [label, output] of [
  ['ERR on stderr', 'ERR error="stderr is not empty"\nINF scanned ~0 bytes (0) in 1ms'],
  ['ERR on stdout', 'ERR parse failure\nINF scanned ~0 bytes (0) in 1ms'],
  ['partial scan', 'INF partial scan\nINF scanned ~0 bytes (0) in 1ms'],
  ['missing completion', 'INF no leaks found'],
]) {
  topologyTest(`exit-zero scanner refuses ${label}`, (t) => {
    const h = rangeHarness(t);
    unlinkSync(join(h.bin, 'gitleaks'));
    writeFileSync(
      join(h.bin, 'gitleaks'),
      `#!/usr/bin/env node\nconsole.${label.includes('stdout') ? 'log' : 'error'}(${JSON.stringify(output)});\n`,
      { mode: 0o755 },
    );
    const result = h.scan(h.base, h.commit('clean'));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /did not prove a complete scan/);
    assert.ok(result.stdout.includes(output)); // tee keeps both streams visible.
  });
}

topologyTest('scan refuses a failed log capture even after a completed clean scan', (t) => {
  const h = rangeHarness(t);
  writeFileSync(join(h.bin, 'tee'), '#!/bin/sh\ncat\nexit 1\n', { mode: 0o755 });
  assert.notEqual(h.scan(h.base, h.commit('clean')).status, 0);
});

test(
  'pinned scanner Git attribute warning exits zero but the workflow refuses the partial scan',
  { skip: !process.env.GITLEAKS_TEST_BINARY },
  (t) => {
    const h = rangeHarness(t);
    // Git exits zero with this diagnostic; Gitleaks does not whitelist it.
    const base = h.commit('.gitattributes', '* invalid/name\n');
    h.git('checkout', '-b', 'side');
    h.commit('side');
    h.git('checkout', 'main');
    h.commit('main-work');
    h.git('merge', '--no-ff', 'side', '-m', 'merge');
    const head = h.git('rev-parse', 'HEAD');
    const range = `--full-history --diff-merges=remerge ${base}..${head}`;
    const git = spawnSync('git', ['log', '-p', '-U0', ...range.split(' ')], {
      cwd: h.dir,
      encoding: 'utf8',
      env: fixtureGitEnv(),
    });
    assert.equal(git.status, 0);
    assert.match(git.stderr, /not a valid attribute name/);
    const raw = spawnSync(
      process.env.GITLEAKS_TEST_BINARY,
      ['detect', '--redact', '--no-color', `--log-opts=${range}`],
      { cwd: h.dir, encoding: 'utf8', env: fixtureGitEnv() },
    );
    assert.equal(raw.status, 0, raw.stderr);
    assert.match(raw.stderr, /ERR.*stderr is not empty/);
    const result = h.scan(base, head);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /did not prove a complete scan/);
    t.diagnostic(
      `Git exit ${git.status}: ${git.stderr}Gitleaks exit ${raw.status}: ${raw.stderr}Workflow exit ${result.status}: ${result.stdout}`,
    );
  },
);
