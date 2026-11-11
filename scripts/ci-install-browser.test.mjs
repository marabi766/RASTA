// FU-335: the browser suite's install step must not depend on apt when the
// image can already run Chromium, and must fail closed. `ci-install-browser.sh`
// is run here against a stub `pnpm` that plays each outcome (the real launches
// are the "Portal in a browser" job's); the workflow is read as written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { authoredFiles } from './authored-source-inventory.cjs';
import { VersionRefusal, lockedPlaywrightVersion } from './ci-playwright-version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts/ci-install-browser.sh');
const HELPER = resolve(ROOT, 'scripts/ci-playwright-version.mjs');
const read = (file) => readFileSync(resolve(ROOT, file), 'utf8');

const NO_LIBRARY =
  'Error: chrome-headless-shell: error while loading shared libraries: libnspr4.so: cannot open shared object file';
const OK = [0, ''];
const APT_DOWN = [
  1,
  "E: Failed to fetch ...  Temporary failure resolving 'azure.archive.ubuntu.com'",
];
// What a `playwright screenshot` call leaves behind: [exit status, output, seconds, file].
const PNG = '\\x89PNG\\r\\n\\x1a\\n....';
const LAUNCHED = [0, 'Capturing screenshot into launch-proof.png', 0, PNG];
const NOT_LAUNCHED = [1, NO_LIBRARY];

/**
 * Runs the script against a stub `pnpm`. Each of `download`, `prove` and `deps`
 * is the list of [exit status, output, seconds to take, file] that kind of call
 * answers with, in order; the last entry repeats. `file` is what a `prove` call
 * writes where the script asked for the screenshot (printf format; left out =
 * writes nothing). A kind left out of the plan fails the run if it is called.
 */
function run(plan, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-install-browser-'));
  for (const [kind, steps] of Object.entries(plan)) {
    steps.forEach(([rc, out, seconds = 0, file], i) => {
      writeFileSync(join(dir, `${kind}.${i + 1}.rc`), String(rc));
      writeFileSync(join(dir, `${kind}.${i + 1}.out`), out);
      writeFileSync(join(dir, `${kind}.${i + 1}.sleep`), String(seconds));
      if (file !== undefined) writeFileSync(join(dir, `${kind}.${i + 1}.file`), file);
    });
    writeFileSync(join(dir, `${kind}.last`), String(steps.length));
  }
  const stub = join(dir, 'pnpm');
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
d="${dir}"
case "$*" in
  "--filter @rasta/web exec playwright install chromium") kind=download ;;
  "--filter @rasta/web exec playwright install-deps chromium") kind=deps ;;
  "--filter @rasta/web exec playwright screenshot --browser chromium data:text/html,"*" /"*"/launch-proof.png") kind=prove ;;
  *) echo "unexpected: $*" >> "$d/calls"; exit 97 ;;
esac
echo "$kind" >> "$d/calls"
[ -f "$d/$kind.last" ] || { echo "unplanned $kind" >> "$d/calls"; exit 98; }
n=$(grep -cx "$kind" "$d/calls")
last=$(cat "$d/$kind.last")
[ "$n" -gt "$last" ] && n=$last
sleep "$(cat "$d/$kind.$n.sleep")"
[ -f "$d/$kind.$n.file" ] && printf "$(cat "$d/$kind.$n.file")" > "\${!#}"
cat "$d/$kind.$n.out"
exit "$(cat "$d/$kind.$n.rc")"
`,
  );
  chmodSync(stub, 0o755);
  const result = spawnSync('bash', [SCRIPT], {
    env: { PATH: `${dir}:${process.env.PATH}`, CI_BROWSER_BACKOFF: '0 0', ...env },
    encoding: 'utf8',
  });
  const calls = existsSync(join(dir, 'calls'))
    ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').filter(Boolean)
    : [];
  return { ...result, calls };
}

const notRun = (r) => assert.match(r.stderr, /::error::.*The browser suite was NOT run\./);

test('a browser that starts needs no system packages: download, one proof, no apt', () => {
  const r = run({ download: [OK], prove: [LAUNCHED] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, ['download', 'prove']);
  assert.match(r.stdout, /no system packages were installed/);
});

test('the download is retried a bounded number of times, then the browser is proven', () => {
  const r = run({ download: [[1, 'ECONNRESET'], [1, 'ECONNRESET'], OK], prove: [LAUNCHED] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, ['download', 'download', 'download', 'prove']);
});

test('a download that keeps failing fails the step: three attempts, no proof, no apt', () => {
  const r = run({ download: [[1, 'ECONNRESET']] });
  assert.equal(r.status, 1);
  assert.deepEqual(r.calls, ['download', 'download', 'download']);
  notRun(r);
});

test('only a failed proof installs system packages, and the browser is proven again', () => {
  const r = run({
    download: [OK],
    prove: [NOT_LAUNCHED, LAUNCHED],
    deps: [OK],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, ['download', 'prove', 'deps', 'prove']);
  assert.match(r.stderr, /::warning::Chromium did not start with the libraries on this image/);
  assert.match(r.stdout, /libnspr4\.so/, "the browser's own message is in the log");
  assert.match(r.stderr, /browser-launch-proof: FAILED/);
});

test('apt is retried a bounded number of times', () => {
  const r = run({
    download: [OK],
    prove: [NOT_LAUNCHED, LAUNCHED],
    deps: [APT_DOWN, OK],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, ['download', 'prove', 'deps', 'deps', 'prove']);
});

test('the 2026-11-11 outage on an image that cannot start Chromium: three apt attempts, then red', () => {
  const r = run({ download: [OK], prove: [NOT_LAUNCHED], deps: [APT_DOWN] });
  assert.equal(r.status, 1);
  assert.deepEqual(r.calls, ['download', 'prove', 'deps', 'deps', 'deps']);
  notRun(r);
});

test('system packages installed but the browser still does not start: red', () => {
  const r = run({ download: [OK], prove: [NOT_LAUNCHED], deps: [OK] });
  assert.equal(r.status, 1);
  assert.deepEqual(r.calls, ['download', 'prove', 'deps', 'prove']);
  notRun(r);
});

for (const [name, file] of [
  ['writes no screenshot', undefined],
  ['writes an empty file', ''],
  ['writes a file that is not a PNG', 'Capturing screenshot'],
  ['writes a file with PNG further in', 'x\\x89PNG'],
]) {
  test(`exit 0 is not a proof: a screenshot command that exits 0 and ${name} is a failed proof`, () => {
    const r = run({ download: [OK], prove: [[0, '', 0, file]], deps: [OK] });
    assert.equal(r.status, 1);
    assert.deepEqual(r.calls, ['download', 'prove', 'deps', 'prove']);
    notRun(r);
  });
}

test('a screenshot from a command that exits non-zero is a failed proof', () => {
  const r = run({ download: [OK], prove: [[1, '', 0, PNG]], deps: [OK] });
  assert.equal(r.status, 1);
  assert.deepEqual(r.calls, ['download', 'prove', 'deps', 'prove']);
});

test('a proof that hangs is a failed proof, and a hanging apt is an attempt that failed', () => {
  const r = run(
    { download: [OK], prove: [[0, '', 20, PNG]], deps: [[0, '', 20]] },
    { CI_BROWSER_PROOF_SECONDS: '1', CI_BROWSER_ATTEMPT_SECONDS: '1' },
  );
  assert.equal(r.status, 1);
  assert.deepEqual(r.calls, ['download', 'prove', 'deps', 'deps', 'deps']);
  notRun(r);
});

test('arguments are refused before anything runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-install-browser-'));
  const r = spawnSync('bash', [SCRIPT, 'chromium'], {
    env: { PATH: `${dir}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  assert.equal(r.status, 2);
});

// --- scripts/ci-playwright-version.mjs ----------------------------------------

const lock = (entry) =>
  `importers:\n  apps/web:\n    devDependencies:\n      '@playwright/test':\n${entry}\n  tests/e2e:\n    devDependencies:\n      '@playwright/test':\n        specifier: ^1.51.1\n        version: 1.51.1\n`;

test("the cache key's version is the one exact version the lockfile pins for apps/web", () => {
  const text = lock('        specifier: ^1.62.1\n        version: 1.62.1');
  assert.equal(lockedPlaywrightVersion(text, '1.62.1'), '1.62.1');
  for (const [entry, installed, why] of [
    [
      '        specifier: ^1.62.1\n        version: 1.62.1',
      '1.62.0',
      /installed, pnpm-lock.yaml pins 1\.62\.1/,
    ],
    [
      '        specifier: ^1.62.1\n        version: 1.62.1',
      undefined,
      /installed, pnpm-lock.yaml pins/,
    ],
    ['        specifier: ^1.62.1\n        version: 1.62.1(react@19.0.0)', '1.62.1', /one exact/],
    ['        specifier: ^1.62.1\n        version: ^1.62.1', '^1.62.1', /one exact/],
    ['        specifier: ^1.62.1\n        version: 1.62', '1.62', /one exact/],
    ['        specifier: ^1.62.1', '1.62.1', /one exact/],
  ])
    assert.throws(
      () => lockedPlaywrightVersion(lock(entry), installed),
      (error) => {
        assert.ok(error instanceof VersionRefusal);
        assert.match(error.message, why);
        return true;
      },
    );
  assert.throws(() => lockedPlaywrightVersion('importers: {}\n', '1.62.1'), VersionRefusal);
  assert.throws(() => lockedPlaywrightVersion('importers: [\n', '1.62.1'), VersionRefusal);
});

test('on this tree the helper prints the installed version, and writes the step output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-playwright-version-'));
  const output = join(dir, 'output');
  writeFileSync(output, '');
  const r = spawnSync(process.execPath, [HELPER], {
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: output },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const installed = JSON.parse(read('apps/web/node_modules/@playwright/test/package.json')).version;
  assert.equal(r.stdout, `version=${installed}\n`);
  assert.equal(readFileSync(output, 'utf8'), `version=${installed}\n`);
});

test('the helper takes no arguments', () => {
  for (const args of [['version'], ['--force'], ['1.0.0']]) {
    const r = spawnSync(process.execPath, [HELPER, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 1, args.join(' '));
    assert.equal(r.stdout, '');
  }
});

// --- the workflow -------------------------------------------------------------

const CACHE = 'actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830';
const workflow = parseYaml(read('.github/workflows/ci.yml'));
const steps = workflow.jobs['web-browser'].steps;
const named = (name) => {
  const found = steps.filter((step) => step.name === name);
  assert.equal(found.length, 1, name);
  return found[0];
};

test('the suite runs directly after a proven install, and neither step can be skipped', () => {
  const install = named('Install the browser');
  const suite = named('Run the browser suite');
  assert.equal(steps.indexOf(suite), steps.indexOf(install) + 1);
  assert.deepEqual(install, { name: 'Install the browser', run: 'scripts/ci-install-browser.sh' });
  assert.deepEqual(Object.keys(suite).sort(), ['env', 'name', 'run']);
  assert.equal(suite.run, 'pnpm --filter @rasta/web exec playwright test');
  // Neither step sets where browsers live, so the suite finds the proven build.
  assert.ok(!('PLAYWRIGHT_BROWSERS_PATH' in suite.env));
  assert.ok(!('PLAYWRIGHT_BROWSERS_PATH' in (workflow.env ?? {})));
  assert.ok(!('continue-on-error' in workflow.jobs['web-browser']));
  assert.ok(!('if' in workflow.jobs['web-browser']));
  // Nothing before the install is allowed to fail quietly either.
  for (const step of steps.slice(0, steps.indexOf(install)))
    assert.ok(!('continue-on-error' in step) && !('if' in step), step.name ?? step.uses);
});

test('the Chromium cache is keyed on the locked version only, and restores nothing else', () => {
  const version = named('Read the locked Playwright version');
  const cache = named('Cache the Chromium build');
  const install = named('Install the browser');
  assert.deepEqual(version, {
    name: 'Read the locked Playwright version',
    id: 'playwright',
    run: 'node scripts/ci-playwright-version.mjs',
  });
  assert.equal(steps.indexOf(cache), steps.indexOf(version) + 1);
  assert.equal(steps.indexOf(install), steps.indexOf(cache) + 1);
  assert.deepEqual(cache, {
    name: 'Cache the Chromium build',
    uses: CACHE,
    with: {
      path: '~/.cache/ms-playwright',
      key: 'playwright-chromium-${{ runner.os }}-${{ runner.arch }}-${{ steps.playwright.outputs.version }}',
    },
  });
});

test('no workflow or composite action installs a browser or its system packages by itself', () => {
  const files = authoredFiles(resolve(ROOT, '.github'))
    .map((path) => relative(ROOT, path))
    .filter((file) => /\.ya?ml$/.test(file));
  assert.ok(files.includes('.github/workflows/ci.yml'));
  assert.ok(files.some((file) => file.startsWith('.github/actions/')));
  // Comments are prose; what runs is what is left.
  const code = (file) =>
    read(file)
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
  for (const file of files) {
    assert.doesNotMatch(code(file), /playwright\s+install|install-deps|--with-deps/, file);
    assert.doesNotMatch(code(file), /\bapt(-get)?\s+(-\S+\s+)*(install|update)\b/, file);
  }
  const callers = files.filter((file) => code(file).includes('ci-install-browser.sh'));
  assert.deepEqual(callers, ['.github/workflows/ci.yml']);
  assert.equal(code('.github/workflows/ci.yml').split('ci-install-browser.sh').length, 2);
});
