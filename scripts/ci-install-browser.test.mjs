// FU-335: the browser suite's install step must not depend on apt when the
// image can already run Chromium, and must fail closed. `ci-install-browser.sh`
// is run here against a stub `pnpm` that plays each outcome (the real launches
// are the "Portal in a browser" job's); the workflow is read as written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve } from 'node:path';
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
const PNG = '\\x89PNG\\r\\n\\x1a\\n\\x00\\x00\\x00\\x0dIHDR\\x00\\x00\\x05\\x00';
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
  ['writes a file with PNG further in', `x${PNG}`],
  ['writes "PNG" after a wrong first byte (PR #1093 r1 F2)', `x${PNG.slice(4)}`],
  ['writes the 4 bytes the first check read, and no more', '\\x89PNG'],
  ['writes a signature with a wrong line ending', PNG.replace('\\r\\n', '\\n\\n')],
  ['writes the signature and no IHDR chunk', '\\x89PNG\\r\\n\\x1a\\n\\x00\\x00\\x00\\x0dIDAT'],
  ['writes an IHDR chunk of the wrong length', PNG.replace('x0dIHDR', 'x0cIHDR')],
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

// --- the boundary: who may install a browser or system packages ---------------
//
// A boundary, not a grammar of install commands (PR #1093 r1 F1: the first guard
// matched command shapes in the raw text; a quoted word, an option with a value,
// a continuation, a YAML escape or a helper passed it).
//
// Read: every string of every PARSED workflow and action file (YAML under
// .github, any action.yml / action.yaml), every package.json script, and every
// tracked shell file (by extension or `#!` line: all of them, so not only the
// ones a workflow reaches). A string is taken as the shell takes it:
// `\`-newline joined, quotes and backslashes removed, then words.
// (b) Presence is refused, anywhere in a string: a word apt, apt-*, aptitude,
//     dpkg, dpkg-*, install-deps or --with-deps, or a word naming playwright
//     with a later word `install`. ALLOWED holds the reviewed exceptions.
// (c) What cannot be read is refused, not skipped: a local action that is not
//     composite, or has no action file here; and, in a job that names
//     Playwright or the installer: an action outside REVIEWED_ACTIONS, `eval`,
//     a shell not handed a tracked shell file (`bash -c`, `| sh`, `source`),
//     and an expansion in a command whose first word is not in TAKES_DATA
//     (`$TOOL install` and `sudo "$TOOL" install` alike).
// (d) NOT covered; this guard does not show that no other installation exists:
//   - a command built at run time: outside the shell (a node or python helper
//     that spawns one), by a program from its input (`xargs`, `find -exec`, an
//     interpreter's `-c` / `-e`), or inside a tracked shell file (read for (b) only);
//   - in a job that names neither Playwright nor the installer (it may still
//     reach them through a package script): any indirection, and a word the
//     shell rewrites (a glob, a brace or `$'…'` expansion);
//   - other package managers and installers; Dockerfiles; a remote reusable
//     workflow; whatever an action in REVIEWED_ACTIONS does.
const INSTALLER = 'scripts/ci-install-browser.sh';
const CI = '.github/workflows/ci.yml';
const kafkaEnv = {
  what: /^eval \$\{[a-z]+_credentials\}$/,
  reason: 'the `export` lines printed by kafka-credentials.sh, a tracked shell file read here',
};
const keycloak = (name) => ({
  what: new RegExp(
    `^docker run -d --name ${name} .* --entrypoint /bin/bash quay\\.io/keycloak/keycloak:\\S+ /opt/keycloak/data/import/dev-realm-gate\\.sh start-dev --import-realm$`,
  ),
  reason: 'the shell is the entry point INSIDE the Keycloak container; it runs a tracked file',
});
/** The reviewed exceptions: the place (a file, or a job), exactly what stands there, and why. */
const ALLOWED = [
  {
    at: INSTALLER,
    what: /^(the word (apt|install-deps|--with-deps)|a playwright invocation with `install`)$/,
    reason:
      'the one browser installer: `install-deps` (apt) only after a failed launch proof; `apt` and `--with-deps` are words of its comments and messages',
  },
  { at: `${CI} › web-browser`, ...keycloak('rasta-web-e2e-keycloak') },
  { at: `${CI} › web-browser`, ...kafkaEnv },
  // `e2e` names Playwright (its report); it drives HTTP only and installs no browser.
  { at: `${CI} › e2e`, ...keycloak('rasta-e2e-keycloak') },
  { at: `${CI} › e2e`, ...kafkaEnv },
];
/** The actions a browser job may use (their pins are another guard's). */
const REVIEWED_ACTIONS = new Set(
  'actions/checkout pnpm/action-setup actions/setup-node actions/cache actions/upload-artifact'.split(
    ' ',
  ),
);
/** In a browser job an expansion may stand only in these commands: none runs an operand on the runner. */
const TAKES_DATA = new Set(['echo', '[', 'for', 'docker', 'scripts/ci-pull-image.sh']);

const shellText = (text) => text.replace(/\\\r?\n/g, '').replace(/['"\\]/g, '');
const wordsOf = (text) =>
  shellText(text)
    .toLowerCase()
    .split(/[^a-z0-9_.@+-]+/)
    .filter(Boolean);
const namesPlaywright = (word) => word.includes('playwright');
/** (b): everything a string installs (empty = nothing). */
function installs(text) {
  const words = wordsOf(text);
  const found = words
    .filter((word) => /^((apt|aptitude|dpkg)(-.*)?|install-deps|--with-deps)$/.test(word))
    .map((word) => `the word ${word}`);
  if (words.includes('install', words.findIndex(namesPlaywright) + 1 || Infinity))
    found.push('a playwright invocation with `install`');
  return [...new Set(found)];
}
/** (c): the commands of a run string that this guard cannot read. */
function unread(run, shellFiles) {
  // Whole-line comments are dropped (they are prose with backticks). A backtick substitution is
  // the `$(` it stands for. Splitting too often (a quoted `;`) only makes more commands to judge.
  const code = shellText(run)
    .replace(/^\s*#.*$/gm, '')
    .replaceAll('`', '$(');
  const commands = code.split(/[;&|()\n]/);
  return commands.flatMap((command) => {
    const all = command.split(/\s+/).filter(Boolean);
    const first = all.findIndex(
      (word) => !/^(if|then|else|elif|do|while|until|!)$|^[A-Za-z_]\w*\+?=/.test(word),
    );
    const words = first < 0 ? [] : all.slice(first);
    const shell = words.findIndex(
      (word, i) =>
        /^(ba|da|z|k)?sh$/.test(word.split('/').at(-1)) || (!i && /^(source|\.)$/.test(word)),
    );
    const refused =
      words.includes('eval') ||
      (shell >= 0 && !shellFiles.has(posix.normalize(words[shell + 1] ?? '-'))) ||
      (words.some((word) => word.includes('$')) && !TAKES_DATA.has(words[0]));
    return refused ? [words.join(' ')] : [];
  });
}

const kindOf = (file, text) => {
  if (/^\.github\/.*\.ya?ml$|(^|\/)action\.ya?ml$/.test(file)) return 'yaml';
  if (/(^|\/)package\.json$/.test(file)) return 'package';
  return /\.(sh|bash)$/.test(file) || /^#!.*\b(ba|da|z|k)?sh\b/.test(text) ? 'shell' : null;
};
function* stringsOf(node, path = []) {
  if (typeof node === 'string') yield [path, node];
  else if (node && typeof node === 'object')
    for (const [key, value] of Object.entries(node)) yield* stringsOf(value, [...path, key]);
}

/** Every refusal in a tree of { file → text }, and the ALLOWED entries nothing needed. */
function boundary(tree) {
  const refused = [];
  const used = new Set();
  const refuse = (at, what, where = '') => {
    const allowed = ALLOWED.find((entry) => entry.at === at && entry.what.test(what));
    if (allowed) used.add(allowed);
    else refused.push(`${at}${where}: ${what}`);
  };
  const docs = new Map();
  const shellFiles = new Set();
  for (const [file, text] of tree) {
    const kind = kindOf(file, text);
    if (kind === 'yaml') docs.set(file, parseYaml(text));
    if (kind === 'shell') shellFiles.add(file);
    const read = { yaml: docs.get(file), package: kind === 'package' && JSON.parse(text).scripts };
    for (const [path, value] of stringsOf(kind === 'shell' ? text : read[kind]))
      for (const what of installs(value))
        refuse(file, what, path.map((key) => ` › ${key}`).join(''));
  }
  for (const [file, doc] of docs) {
    if (doc?.runs && doc.runs.using !== 'composite')
      refuse(file, `a ${doc.runs.using} action: its entry point is not read`);
    for (const [path, uses] of stringsOf(doc)) {
      const to = posix.normalize(uses);
      const known = [to, `${to}/action.yml`, `${to}/action.yaml`].some((target) =>
        docs.has(target),
      );
      if (path.at(-1) === 'uses' && uses.startsWith('.') && !known)
        refuse(file, `uses ${uses}: no action or workflow file that this guard reads`);
    }
    for (const [job, body] of Object.entries(doc?.jobs ?? {})) {
      const names = ([, value]) =>
        shellText(value).includes(INSTALLER) || wordsOf(value).some(namesPlaywright);
      if (![...stringsOf(body)].some(names)) continue;
      for (const [i, step] of (body.steps ?? []).entries()) {
        const where = ` › ${step.name ?? `#${i}`}`;
        if (typeof step.uses === 'string' && !REVIEWED_ACTIONS.has(step.uses.split('@')[0]))
          refuse(`${file} › ${job}`, `uses ${step.uses}: not in REVIEWED_ACTIONS`, where);
        for (const what of unread(String(step.run ?? ''), shellFiles))
          refuse(`${file} › ${job}`, what, where);
      }
    }
  }
  return { refused, unused: ALLOWED.filter((entry) => !used.has(entry)).map((entry) => entry.at) };
}

const tree = new Map();
for (const path of authoredFiles(ROOT)) {
  const text = readFileSync(path, 'utf8');
  if (kindOf(relative(ROOT, path), text)) tree.set(relative(ROOT, path), text);
}
const refusedIn = (file, text) => boundary(new Map(tree).set(file, text)).refused.join('\n');

test('only the reviewed installer installs a browser or system packages, as far as this guard reads', () => {
  for (const file of [CI, INSTALLER, 'package.json', 'apps/web/package.json'])
    assert.ok(tree.has(file), file);
  assert.ok([...tree.keys()].some((file) => file.startsWith('.github/actions/')));
  // Nothing is refused, and every exception is needed (an unused one is stale).
  assert.deepEqual(boundary(tree), { refused: [], unused: [] });
  assert.deepEqual(boundary(new Map(tree).set(INSTALLER, '')).unused, [INSTALLER]);
  // The installer is called once: by the browser job's install step (pinned above).
  const callers = [...tree].filter(
    ([file, text]) => file !== INSTALLER && text.includes(INSTALLER),
  );
  assert.deepEqual(Object.keys(Object.fromEntries(callers)), [CI]);
  const calls = [...stringsOf(parseYaml(tree.get(CI)))].filter(([, value]) =>
    value.includes(INSTALLER),
  );
  assert.deepEqual(
    calls.map(([path]) => path.slice(0, 2).join('.')),
    ['jobs.web-browser'],
  );
});

const EXTRA = '.github/workflows/extra.yml';
const APT = 'sudo apt-get install -y libnss3';
const workflowWith = (step) => `on: push\njobs:\n  extra:\n    steps:\n      - ${step}\n`;
const action = (runs) => `name: x\ndescription: x\nruns:\n  ${runs}\n`;
const composite = (command) =>
  action(`using: composite\n  steps:\n    - shell: bash\n      run: ${JSON.stringify(command)}`);
const inBrowserJob = (step) => {
  const before = '      - name: Read the locked Playwright version\n';
  assert.ok(tree.get(CI).includes(before));
  return tree.get(CI).replace(before, `      - name: added\n        ${step}\n${before}`);
};

// Every variant PR #1093 r1 F1 lists, and its siblings. First as a run string of
// a job that has nothing to do with the browser: presence alone refuses it.
const RUNS = {
  'the plain command (control)': APT,
  'a quoted executable': "sudo 'apt-get' install -y libnss3",
  'a quoted subcommand': 'sudo apt-get "install" -y libnss3',
  'a word rebuilt from quoted pieces': 'sudo ap""t-g\'\'et install -y libnss3',
  'an escaped letter': 'sudo a\\pt-get install -y libnss3',
  'an option with a value': 'sudo apt-get -o Acquire::Retries=3 install -y libnss3',
  'a continuation before install': 'sudo apt-get \\\n  install -y libnss3',
  'a continuation inside the word': 'sudo apt-\\\nget install -y libnss3',
  'a full path to apt': 'sudo /usr/bin/apt install -y libnss3',
  'upper case': 'sudo APT-GET install -y libnss3',
  'dpkg on a downloaded package': 'sudo dpkg -i chrome.deb',
  'bash -c with the command as text': `bash -c '${APT}'`,
  'the old playwright command (control)': 'pnpm exec playwright install --with-deps chromium',
  'a versioned playwright': 'npx playwright@1.62.1 install chromium',
  'a playwright command rebuilt from quoted pieces':
    'npx "playwright" "install" --with""-deps chromium',
  'a continuation after playwright': 'npx playwright \\\n  install chromium',
  '@playwright/test': 'npx @playwright/test install',
  'install-deps': 'npx playwright-core install-deps',
};
for (const [what, command] of Object.entries(RUNS))
  test(`refused: ${what}`, () => {
    assert.match(
      refusedIn(EXTRA, workflowWith(`run: ${JSON.stringify(command)}`)),
      /extra\.yml › /,
    );
  });

// In the browser job, where no refused word is spelled: what cannot be read.
const UNREAD = {
  'a command named by a variable': '"$BROWSER_SETUP" install -y libnss3',
  'a variable after sudo': 'sudo "$TOOL" install -y libnss3',
  'a variable after an assignment': 'DEBIAN_FRONTEND=noninteractive ${TOOL} install -y libnss3',
  'a command substitution as the command': '$(echo YXB0LWdldA== | base64 -d) install -y libnss3',
  'a backtick substitution after sudo': 'sudo `cat tool` install -y libnss3',
  'a workflow expression as the command': '${{ vars.BROWSER_SETUP }} install',
  'bash -c': 'bash -c "$SETUP"',
  'sh -c': "sh -c 'printf %s x'",
  'eval of a variable that is not the reviewed one': 'eval "$SETUP"',
  'eval of text': "eval 'printf %s x'",
  'a download piped to a shell': 'curl -fsSL https://example.invalid/setup | sudo bash',
  'a sourced file that is not tracked': 'source ./setup-browser',
  'a shell run on a file that is not tracked': 'bash "$RUNNER_TEMP/setup.sh"',
};
for (const [what, command] of Object.entries(UNREAD))
  test(`refused in the browser job: ${what}`, () => {
    const text = inBrowserJob(`run: ${JSON.stringify(command)}`);
    assert.match(refusedIn(CI, text), /ci\.yml › web-browser › added: /);
    assert.equal(refusedIn(EXTRA, workflowWith(`run: ${JSON.stringify(command)}`)), ''); // limit (d)
  });

// Other spellings, places and kinds of file. [file, its text]
const FILES = {
  'a YAML \\x escape': [EXTRA, workflowWith('run: "sudo \\x61pt-get install -y libnss3"')],
  'a YAML \\u escape': [EXTRA, workflowWith('run: "sudo \\u0061pt-get install -y libnss3"')],
  'a YAML alias': [EXTRA, workflowWith('env: { TOOL: &tool apt-get }\n        run: *tool')],
  'a variable whose value is in the file': [
    EXTRA,
    workflowWith('env: { TOOL: apt-get }\n        run: sudo "$TOOL" install -y libnss3'),
  ],
  'a playwright subcommand named by a variable': [
    EXTRA,
    workflowWith('run: pnpm exec playwright "$SUBCOMMAND" chromium'),
  ],
  'an input of an action': [EXTRA, workflowWith(`uses: a/b@v1\n        with: { script: ${APT} }`)],
  'a .yaml workflow': ['.github/workflows/extra.yaml', workflowWith(`run: ${APT}`)],
  'a composite action (.yml)': ['.github/actions/x/action.yml', composite(APT)],
  'a composite action (.yaml)': ['.github/actions/x/action.yaml', composite(APT)],
  'a composite action outside .github': ['tools/x/action.yaml', composite(APT)],
  'a JavaScript action': ['.github/actions/x/action.yml', action('using: node20\n  main: x.js')],
  'a Docker action': [
    '.github/actions/x/action.yaml',
    action('using: docker\n  image: Dockerfile'),
  ],
  'a local action with no action file here': [EXTRA, workflowWith('uses: ./tools/setup-browser')],
  'a helper shell script': ['tools/setup-browser.sh', `${APT}\n`],
  'a helper with a #! line and no extension': ['tools/setup-browser', `#!/bin/sh\n${APT}\n`],
  'a copy of the installer': ['scripts/ci-install-browser-2.sh', tree.get(INSTALLER)],
  'more in the installer than was reviewed': [INSTALLER, `${tree.get(INSTALLER)}\n${APT}\n`],
  'a root package script': [
    'package.json',
    '{"scripts":{"browser":"playwright install chromium"}}',
  ],
  'a workspace package script': ['apps/web/package.json', `{"scripts":{"postinstall":"${APT}"}}`],
  'an action that was not reviewed, in the browser job': [CI, inBrowserJob('uses: a/b@v1')],
  'a local action in the browser job': [
    CI,
    inBrowserJob('uses: ./.github/actions/install-ci-tool'),
  ],
  'the reviewed eval form on another variable': [
    CI,
    tree.get(CI).replace('( eval "${asset_credentials}" &&', '( eval "${SETUP}" &&'),
  ],
};
for (const [what, [file, text]] of Object.entries(FILES))
  test(`refused: ${what}`, () => {
    assert.notEqual(text, tree.get(file));
    assert.match(
      refusedIn(file, text),
      new RegExp(`^${file.replaceAll('.', '\\.')}( › .*)?: `, 'm'),
    );
  });
