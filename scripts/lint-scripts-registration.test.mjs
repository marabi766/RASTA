import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Nothing that guards the lint rules may fall out of CI unnoticed.
 *
 * Two lists are kept by hand and each fails silently when a file is missing
 * from it:
 *
 *  1. root `package.json` `lint:scripts` — `node --test <files>`, an explicit
 *     list. A rule test that is not in it is never run: `pnpm lint` stays green
 *     and the rule it was written to hold can be disabled with no test failing.
 *  2. `turbo.json` `tasks.lint.inputs` — turbo hashes a workspace's `lint` from
 *     that workspace's files plus these. A rule file that eslint loads but that
 *     is not an input can change, and turbo replays a cached green for every
 *     workspace that rule applies to.
 *
 * The convention for (1) is derived, not remembered. Let a rule be
 * `scripts/<stem>-rule.mjs`. The tests that must be listed are
 * `scripts/<stem>-rule.test.mjs` and every sibling suite `scripts/<stem>-*.test.mjs`
 * (e.g. internal-token-transport-cache, -workspace), plus every
 * `scripts/*-rule.test.mjs` even when its rule file is gone. The convention for
 * (2) is: every `scripts/*-rule.mjs` that any tracked `eslint.config.*` imports,
 * and every local file such a rule imports in turn.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'scripts/lint-scripts-registration.test.mjs';

const readText = (path) => readFileSync(join(ROOT, path), 'utf8');

/** turbo.json is JSONC: drop `//` and block comments, never inside a string. */
export const parseJsonc = (text) => {
  let out = '';
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 2;
      assert.ok(i >= 2, 'unterminated block comment in JSONC');
    } else {
      out += c;
      i += 1;
    }
  }
  return JSON.parse(out);
};

/** The `.test.mjs` files `lint:scripts` passes to `node --test`, as written. */
export const registeredTests = (lintScripts) => {
  const tokens = lintScripts.split(/\s+/).filter(Boolean);
  const at = tokens.findIndex((t, i) => t === 'node' && tokens[i + 1] === '--test');
  assert.ok(at >= 0, 'package.json `lint:scripts` no longer runs `node --test <files>`');
  const files = [];
  for (const token of tokens.slice(at + 2)) {
    if (token === '&&' || token === ';' || token.startsWith('-')) break;
    files.push(token);
  }
  return files;
};

const listScripts = () => readdirSync(join(ROOT, 'scripts')).sort();
const ruleStems = (names) =>
  names.filter((n) => n.endsWith('-rule.mjs')).map((n) => n.slice(0, -'-rule.mjs'.length));

/** Every test the convention requires `lint:scripts` to run. */
export const requiredTests = (names) => {
  const tests = names.filter((n) => n.endsWith('.test.mjs'));
  const required = new Map();
  for (const name of tests) {
    if (name.endsWith('-rule.test.mjs')) {
      required.set(`scripts/${name}`, 'a `*-rule.test.mjs` rule test');
    }
  }
  for (const stem of ruleStems(names)) {
    for (const name of tests) {
      if (name.startsWith(`${stem}-`)) {
        required.set(`scripts/${name}`, `a test of the rule \`scripts/${stem}-rule.mjs\``);
      }
    }
  }
  required.set(SELF, 'the registration guard itself');
  return required;
};

export const unregisteredTests = (names, registered) =>
  [...requiredTests(names)]
    .filter(([file]) => !registered.includes(file))
    .map(
      ([file, why]) =>
        `${file} (${why}) is not in the root package.json \`lint:scripts\` list, so \`pnpm lint\` never runs it. ` +
        `Add it after \`node --test\`.`,
    );

export const staleRegistrations = (registered, exists) => {
  const problems = [];
  const seen = new Set();
  for (const file of registered) {
    if (seen.has(file)) problems.push(`${file} is listed twice in \`lint:scripts\`.`);
    seen.add(file);
    if (!/^scripts\/[^/]+\.test\.mjs$/.test(file)) {
      problems.push(`${file} in \`lint:scripts\` is not a scripts/*.test.mjs file.`);
    } else if (!exists(file)) {
      problems.push(
        `${file} is in \`lint:scripts\` but does not exist; \`node --test\` would fail.`,
      );
    }
  }
  return problems;
};

const IMPORT_RE = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g;

/** `scripts/*-rule.mjs` files a config imports, relative to the repo root. */
export const importedRuleFiles = (configPath, source) => {
  const found = new Set();
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2];
    if (!specifier.startsWith('.')) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(configPath), specifier));
    if (/^scripts\/[^/]+-rule\.mjs$/.test(resolved)) found.add(resolved);
  }
  return found;
};

/** Local files a rule imports (its helpers are lint inputs too). */
export const localImports = (rulePath, source) => {
  const found = new Set();
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2];
    if (specifier.startsWith('.')) {
      found.add(posix.normalize(posix.join(posix.dirname(rulePath), specifier)));
    }
  }
  return found;
};

const globToRegExp = (glob) =>
  new RegExp(
    `^${glob
      .split('**')
      .map((part) =>
        part
          .split('*')
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*'),
      )
      .join('.*')}$`,
  );

export const lintInputs = (turbo) =>
  (turbo.tasks?.lint?.inputs ?? [])
    .filter((input) => input.startsWith('$TURBO_ROOT$/'))
    .map((input) => input.slice('$TURBO_ROOT$/'.length));

export const missingTurboInputs = (turboPath, inputs, wanted) =>
  [...wanted]
    .filter(([file]) => !inputs.some((pattern) => globToRegExp(pattern).test(file)))
    .map(
      ([file, why]) =>
        `${file} (${why}) is not a \`lint\` input in ${turboPath}: a change to it would replay a cached lint ` +
        `green. Add "$TURBO_ROOT$/${file}" to tasks.lint.inputs.`,
    );

const trackedFiles = () =>
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 })
    .split('\0')
    .filter(Boolean);

/** Everything eslint is configured with: rule file → why it is wanted. */
const wantedRuleInputs = (files) => {
  const importers = new Map();
  const note = (file, why) => importers.set(file, [...(importers.get(file) ?? []), why]);
  for (const config of files.filter((f) => /(^|\/)eslint\.config\.m?js$/.test(f))) {
    for (const rule of importedRuleFiles(config, readText(config))) {
      note(rule, `a rule imported by ${config}`);
      for (const dep of localImports(rule, readText(rule)))
        note(dep, `imported by the rule ${rule}`);
    }
  }
  return new Map([...importers].map(([file, whys]) => [file, [...new Set(whys)].join('; ')]));
};

const loadState = () => {
  const files = trackedFiles();
  const pkg = JSON.parse(readText('package.json'));
  return {
    names: listScripts(),
    registered: registeredTests(pkg.scripts['lint:scripts'] ?? ''),
    wanted: wantedRuleInputs(files),
    turbos: files
      .filter((f) => /(^|\/)turbo\.json$/.test(f))
      .map((f) => [f, parseJsonc(readText(f))]),
  };
};

/** All problems of a state — what the checks below assert is empty. */
export const problemsOf = ({ names, registered, wanted, turbos }) => [
  ...unregisteredTests(names, registered),
  ...staleRegistrations(registered, (f) => names.includes(f.slice('scripts/'.length))),
  ...turbos.flatMap(([path, turbo]) => {
    if (path === 'turbo.json') return missingTurboInputs(path, lintInputs(turbo), wanted);
    // A workspace turbo.json that overrides `lint` inputs replaces the root's.
    return turbo.tasks?.lint?.inputs ? missingTurboInputs(path, lintInputs(turbo), wanted) : [];
  }),
];

const fail = (problems) => problems.join('\n');

test('every rule test the convention covers is run by lint:scripts, and the list is not stale', () => {
  const { names, registered } = loadState();
  const problems = [
    ...unregisteredTests(names, registered),
    ...staleRegistrations(registered, (f) => existsSync(join(ROOT, f))),
  ];
  assert.deepEqual(problems, [], fail(problems));
});

test('every eslint rule file is a turbo lint input', () => {
  const { wanted, turbos } = loadState();
  assert.ok(
    wanted.size >= 4,
    `expected the configs to import the known rules, found ${wanted.size}`,
  );
  const problems = problemsOf({ names: [], registered: [], wanted, turbos }).filter(
    (p) => !p.includes('lint:scripts'),
  );
  assert.deepEqual(problems, [], fail(problems));
});

test('the rules discovered are the ones eslint.config.mjs and the portal load', () => {
  const { wanted } = loadState();
  for (const rule of [
    'scripts/exchange-deadline-rule.mjs',
    'scripts/internal-token-transport-rule.mjs',
    'scripts/no-zod-default-rule.mjs',
    'scripts/raw-http-boundary-rule.mjs',
  ]) {
    assert.ok(wanted.has(rule), `${rule} is no longer discovered as an eslint rule import`);
  }
  assert.ok(
    [...wanted.values()].some((why) => why.includes('apps/web/eslint.config.mjs')),
    'the portal config is no longer scanned',
  );
});

// Mutants: each takes the real state, removes ONE entry, and the guard must
// fail naming exactly that file.
test('mutant: dropping any one lint:scripts registration fails naming the file', () => {
  const state = loadState();
  assert.deepEqual(problemsOf(state), []);
  const required = [...requiredTests(state.names).keys()];
  assert.ok(required.length >= 7, `expected the known rule tests, found ${required.length}`);
  for (const file of required) {
    const problems = problemsOf({
      ...state,
      registered: state.registered.filter((f) => f !== file),
    });
    assert.equal(problems.length, 1, `${file}: ${problems.join(' | ')}`);
    assert.ok(problems[0].startsWith(`${file} `), problems[0]);
  }
});

test('mutant: dropping any one turbo lint input fails naming the file', () => {
  const state = loadState();
  const root = state.turbos.find(([path]) => path === 'turbo.json')[1];
  const inputs = root.tasks.lint.inputs;
  for (const [file] of state.wanted) {
    const dropped = JSON.parse(JSON.stringify(root));
    dropped.tasks.lint.inputs = inputs.filter((i) => i !== `$TURBO_ROOT$/${file}`);
    assert.equal(
      dropped.tasks.lint.inputs.length,
      inputs.length - 1,
      `${file} is not listed verbatim`,
    );
    const problems = problemsOf({
      ...state,
      turbos: state.turbos.map(([path, t]) => [path, path === 'turbo.json' ? dropped : t]),
    });
    assert.equal(problems.length, 1, `${file}: ${problems.join(' | ')}`);
    assert.ok(problems[0].startsWith(`${file} `), problems[0]);
  }
});

test('mutant: a new rule, sibling suite or stale entry is caught', () => {
  const names = [
    ...listScripts(),
    'brand-new-rule.mjs',
    'brand-new-rule.test.mjs',
    'brand-new-extra.test.mjs',
  ];
  const registered = [
    ...loadState().registered,
    'scripts/ghost.test.mjs',
    'scripts/ghost.test.mjs',
  ];
  const problems = [
    ...unregisteredTests(names, registered),
    ...staleRegistrations(registered, (f) => names.includes(f.slice(8))),
  ];
  assert.ok(
    problems.some((p) => p.startsWith('scripts/brand-new-rule.test.mjs ')),
    fail(problems),
  );
  assert.ok(
    problems.some((p) => p.startsWith('scripts/brand-new-extra.test.mjs ')),
    fail(problems),
  );
  assert.ok(
    problems.some((p) => p.startsWith('scripts/ghost.test.mjs is listed twice')),
    fail(problems),
  );
  assert.ok(
    problems.some((p) => p.startsWith('scripts/ghost.test.mjs is in')),
    fail(problems),
  );
});

test('the guard registers itself', () => {
  assert.ok(
    registeredTests(JSON.parse(readText('package.json')).scripts['lint:scripts']).includes(SELF),
  );
  assert.ok(
    relative(ROOT, fileURLToPath(import.meta.url))
      .split(sep)
      .join('/') === SELF,
  );
});

test('the JSONC reader keeps strings that look like comments', () => {
  assert.deepEqual(parseJsonc('{ // c\n "a": "x // y /* z */", /* b */ "b": 1 }'), {
    a: 'x // y /* z */',
    b: 1,
  });
});
