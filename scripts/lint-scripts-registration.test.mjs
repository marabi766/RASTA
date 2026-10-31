import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Nothing that guards the lint rules may fall out of CI unnoticed.
 *
 * Two lists are kept by hand and each fails silently when a file is missing
 * from it:
 *
 *  1. root `package.json` `lint:scripts` — `node --test <files>`, an explicit
 *     list. A rule test that is not in it is never run: `pnpm lint` stays green
 *     and the rule it was written to hold can be disabled with no test failing.
 *  2. turbo's `lint` inputs — turbo hashes a workspace's `lint` from that
 *     workspace's files plus the task's `inputs`. Any file eslint loads for that
 *     workspace that the hash does not cover can change, and turbo replays a
 *     cached green.
 *
 * The convention for (1) is derived, not remembered. Let a rule be
 * `scripts/<stem>-rule.mjs`. The tests that must be listed are
 * `scripts/<stem>-rule.test.mjs` and every sibling suite `scripts/<stem>-*.test.mjs`
 * (e.g. internal-token-transport-cache, -workspace), plus every
 * `scripts/*-rule.test.mjs` even when its rule file is gone.
 *
 * (2) is checked per ACTUAL lint task, on turbo's effective inputs:
 *  - every workspace whose package.json has a `lint` script runs eslint with the
 *    nearest `eslint.config.{js,mjs,cjs,ts,mts,cts}` at or above it;
 *  - the files that config loads are discovered with a real parser (TypeScript's):
 *    static `import`/`export … from`, `require()`, literal `import()`, recursively
 *    through every local module, with cycle detection. A loading form the guard
 *    cannot follow (a non-literal specifier, `createRequire`, an aliased
 *    `require`, an import of a workspace package, a `#imports` alias, an
 *    unresolvable path) is a FAILURE, never a silent skip;
 *  - the task definition is resolved as turbo does (verified against
 *    `turbo run lint --dry=json`): the root `<pkg>#lint` if present, else the
 *    root `lint`; a workspace turbo.json `lint` overrides that, key by key
 *    (`$TURBO_EXTENDS$` splices the parent's inputs). `$TURBO_DEFAULT$` is the
 *    package's own files, `$TURBO_ROOT$/` anchors at the repo root, `!` excludes
 *    from everything including the default, and `globalDependencies` are hashed
 *    into every task;
 *  - coverage means every discovered file is matched by those effective inputs,
 *    by a real glob matcher (`path.posix.matchesGlob`), whatever the spelling.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'scripts/lint-scripts-registration.test.mjs';

const CONFIG_NAMES = ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].map((e) => `eslint.config.${e}`);
const CODE_EXT = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx'];
const CODE_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** turbo.json is JSONC: drop `//` and block comments, never inside a string. */
export const parseJsonc = (text) => {
  let out = '';
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      assert.ok(j < text.length, 'unterminated string in JSONC');
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

// ---------------------------------------------------------------------------
// (2a) The files a module loads.
// ---------------------------------------------------------------------------

const isLiteral = (node) =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

/**
 * Literal specifiers of every module `source` loads, plus every loading form
 * that cannot be followed. `errors` is never silently empty for an unknown form.
 */
export const analyzeModule = (path, source) => {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const specifiers = new Set();
  const errors = [];
  const at = (node) => `${path}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  const cannot = (node, what) =>
    errors.push(
      `${at(node)} ${what}: the lint-input guard cannot follow it. Load modules with a literal ` +
        `specifier (import/export … from, require('./x'), import('./x')).`,
    );
  const literalArg = (call, form) => {
    const [first] = call.arguments;
    if (isLiteral(first)) specifiers.add(first.text);
    else cannot(call, `${form} with a non-literal specifier`);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && isLiteral(node.moduleSpecifier)) {
        specifiers.add(node.moduleSpecifier.text);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        const { expression } = node.moduleReference;
        if (isLiteral(expression)) specifiers.add(expression.text);
        else cannot(node, '`import x = require(…)` with a non-literal specifier');
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) literalArg(node, 'import()');
      else if (ts.isIdentifier(callee) && callee.text === 'require') literalArg(node, 'require()');
      else if (ts.isPropertyAccessExpression(callee)) {
        const target = callee.expression.getText(sf);
        const member = callee.name.text;
        if (
          (target === 'require' && member === 'resolve') ||
          (target === 'module' && member === 'require') ||
          (target === 'import.meta' && member === 'resolve')
        ) {
          literalArg(node, `${target}.${member}()`);
        }
      }
    } else if (ts.isIdentifier(node)) {
      const { parent } = node;
      const isMemberName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (parent.name === node && !ts.isShorthandPropertyAssignment(parent));
      if (!isMemberName) {
        if (node.text === 'createRequire') cannot(node, '`createRequire` hides module loading');
        else if (node.text === 'eval') cannot(node, '`eval` hides module loading');
        else if (node.text === 'require') {
          const called = ts.isCallExpression(parent) && parent.expression === node;
          const resolved =
            ts.isPropertyAccessExpression(parent) &&
            parent.expression === node &&
            parent.name.text === 'resolve';
          if (!called && !resolved)
            cannot(node, '`require` used as a value (aliased or passed on)');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { specifiers, errors };
};

const resolveTracked = (base, tracked) =>
  [base, ...CODE_EXT.map((e) => `${base}${e}`), ...CODE_EXT.map((e) => `${base}/index${e}`)]
    .concat([`${base}.json`])
    .find((candidate) => tracked.has(candidate));

/**
 * Every tracked file `entries` load, directly or through other local modules.
 * A visited set makes import cycles terminate. Result: file → why it is there.
 */
export const dependencyClosure = (entries, { tracked, read, workspaceNames }) => {
  const files = new Map(entries.map((entry) => [entry, 'an eslint config']));
  const errors = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift();
    if (!CODE_RE.test(file)) continue;
    const source = read(file);
    if (source === undefined) {
      errors.push(`${file} cannot be read, so what it loads is unknown.`);
      continue;
    }
    const { specifiers, errors: found } = analyzeModule(file, source);
    errors.push(...found);
    for (const specifier of specifiers) {
      if (isBuiltin(specifier)) continue;
      if (specifier === '.' || specifier === '..' || /^\.\.?\//.test(specifier)) {
        const resolved = resolveTracked(
          posix.normalize(posix.join(posix.dirname(file), specifier)),
          tracked,
        );
        if (resolved === undefined) {
          errors.push(
            `${file} loads '${specifier}', which is not a tracked file the guard can resolve.`,
          );
        } else if (!files.has(resolved)) {
          files.set(resolved, `loaded by ${file}`);
          queue.push(resolved);
        }
      } else if (/^[#/]/.test(specifier) || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
        errors.push(
          `${file} loads '${specifier}' (an absolute path, URL or #alias): the lint-input guard cannot follow it.`,
        );
      } else {
        const name = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        if (workspaceNames.has(name)) {
          errors.push(
            `${file} loads the workspace package '${name}': its source is a lint input the guard does not follow. ` +
              `Import it by relative path or extend the guard.`,
          );
        }
      }
    }
  }
  return { files, errors };
};

// ---------------------------------------------------------------------------
// (2b) Workspaces, their eslint config, and turbo's effective inputs.
// ---------------------------------------------------------------------------

/** Workspaces with a `lint` script, and every workspace package name. */
export const workspaces = (tracked, read, problems) => {
  const lint = [];
  const names = new Set();
  for (const file of [...tracked].filter((f) => /(^|\/)package\.json$/.test(f))) {
    let pkg;
    try {
      pkg = JSON.parse(read(file));
    } catch (error) {
      problems.push(
        `${file} is not readable JSON (${error.message}); its lint task cannot be checked.`,
      );
      continue;
    }
    if (typeof pkg.name === 'string') names.add(pkg.name);
    if (file === 'package.json' || pkg.scripts?.lint === undefined) continue;
    const script = String(pkg.scripts.lint);
    if (!/\beslint\b/.test(script) || /(^|\s)(-c|--config)(\s|=)/.test(script)) {
      problems.push(
        `${file} \`lint\` is \`${script}\`: the guard only models plain \`eslint <paths>\` with the default config lookup.`,
      );
      continue;
    }
    lint.push({ name: pkg.name, dir: posix.dirname(file) });
  }
  return { lint, names };
};

/** ESLint's flat config lookup: the nearest directory at or above `dir` with one. */
export const nearestConfigs = (dir, tracked) => {
  for (let d = dir; ; d = posix.dirname(d)) {
    const found = CONFIG_NAMES.map((n) => (d === '.' ? n : `${d}/${n}`)).filter((f) =>
      tracked.has(f),
    );
    if (found.length > 0) return found;
    if (d === '.') return [];
  }
};

/** turbo's resolved `lint` definition for one workspace (see the header). */
export const effectiveLintTask = (turbos, { name, dir }) => {
  const root = turbos.get('turbo.json')?.tasks ?? {};
  const base = root[`${name}#lint`] ?? root.lint;
  const own = turbos.get(`${dir}/turbo.json`)?.tasks?.lint;
  if (base === undefined && own === undefined) return undefined;
  const task = { ...base };
  for (const [key, value] of Object.entries(own ?? {})) {
    task[key] =
      key === 'inputs' && Array.isArray(value)
        ? value.flatMap((input) =>
            input === '$TURBO_EXTENDS$' ? (base?.inputs ?? ['$TURBO_DEFAULT$']) : [input],
          )
        : value;
  }
  return task;
};

const matches = (file, glob) => posix.matchesGlob(file, glob);
const underRoot = (entry) => (entry.startsWith('$TURBO_ROOT$/') ? entry.slice(13) : undefined);

/** Is `file` hashed by the task's inputs (or by globalDependencies)? */
export const covers = ({ task, globals }, { dir }, file) => {
  const entries =
    Array.isArray(task.inputs) && task.inputs.length > 0 ? task.inputs : ['$TURBO_DEFAULT$'];
  const globalEntries = globals ?? [];
  const resolve = (entry, anchor) => underRoot(entry) ?? posix.normalize(posix.join(anchor, entry));
  const scan = (list, anchor) => {
    let included = false;
    let excluded = false;
    for (const raw of list) {
      const negated = raw.startsWith('!');
      const entry = negated ? raw.slice(1) : raw;
      if (entry === '$TURBO_DEFAULT$') {
        if (!negated && file.startsWith(`${dir}/`)) included = true;
      } else if (matches(file, resolve(entry, anchor))) {
        if (negated) excluded = true;
        else included = true;
      }
    }
    return included && !excluded;
  };
  return scan(entries, dir) || scan(globalEntries, '.');
};

const LEGACY_CONFIG = /(^|\/)\.eslintrc(\.[a-z]+)?$/;

/** Every problem with what turbo's lint tasks hash versus what eslint loads. */
export const inputProblems = ({ tracked, read, turbos }) => {
  const problems = [];
  const { lint, names } = workspaces(tracked, read, problems);
  for (const file of tracked) {
    if (LEGACY_CONFIG.test(file)) {
      problems.push(`${file} is a legacy eslint config the guard does not model.`);
    }
  }
  const globals = (turbos.get('turbo.json')?.globalDependencies ?? []).map((g) =>
    g.startsWith('!') ? `!${underRoot(g.slice(1)) ?? g.slice(1)}` : (underRoot(g) ?? g),
  );
  const missing = new Map();
  const used = new Set();
  for (const workspace of lint) {
    const configs = nearestConfigs(workspace.dir, tracked);
    if (configs.length === 0) {
      problems.push(
        `${workspace.name} runs eslint but no eslint.config.* exists at or above ${workspace.dir}.`,
      );
      continue;
    }
    const task = effectiveLintTask(turbos, workspace);
    if (task === undefined) {
      problems.push(
        `${workspace.name} has a lint script but turbo defines no \`lint\` task for it.`,
      );
      continue;
    }
    const { files, errors } = dependencyClosure(configs, { tracked, read, workspaceNames: names });
    for (const config of configs) used.add(config);
    for (const error of errors) if (!problems.includes(error)) problems.push(error);
    if (task.cache === false) continue;
    for (const [file, why] of files) {
      if (covers({ task, globals }, workspace, file)) continue;
      const entry = missing.get(file) ?? { why, packages: [] };
      entry.packages.push(workspace.name);
      missing.set(file, entry);
    }
  }
  for (const file of tracked) {
    if (/^eslint\.config\./.test(file) || !/(^|\/)eslint\.config\.[cm]?[jt]s$/.test(file)) continue;
    if (!used.has(file)) {
      problems.push(
        `${file} is an eslint config no workspace lint task uses; the guard cannot say what it loads.`,
      );
    }
  }
  for (const [file, { why, packages }] of missing) {
    problems.push(
      `${file} (${why}) is loaded by eslint for ${packages.join(', ')} but is not covered by that task's effective ` +
        `turbo \`lint\` inputs: a change to it would replay a cached lint green. Add "$TURBO_ROOT$/${file}" to the ` +
        `task that applies (root \`lint\`, a root \`<pkg>#lint\`, or the workspace turbo.json) and remove any "!" exclusion of it.`,
    );
  }
  return problems;
};

// ---------------------------------------------------------------------------
// State: the real repository, or an in-memory one for fixtures and mutants.
// ---------------------------------------------------------------------------

const trackedFiles = () =>
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 })
    .split('\0')
    .filter(Boolean);

const readDisk = (path) => {
  try {
    return readFileSync(join(ROOT, path), 'utf8');
  } catch {
    return undefined;
  }
};

const turbosOf = (tracked, read) =>
  new Map(
    [...tracked].filter((f) => /(^|\/)turbo\.json$/.test(f)).map((f) => [f, parseJsonc(read(f))]),
  );

const realState = () => {
  const tracked = new Set(trackedFiles());
  const read = (path) => (tracked.has(path) ? readDisk(path) : undefined);
  return {
    names: readdirSync(join(ROOT, 'scripts')).sort(),
    registered: registeredTests(JSON.parse(read('package.json')).scripts['lint:scripts'] ?? ''),
    tracked,
    read,
    turbos: turbosOf(tracked, read),
  };
};

/** An in-memory repository: `files` maps tracked path → text. */
export const memoryState = (files) => {
  const tracked = new Set(Object.keys(files));
  const read = (path) => files[path];
  return { tracked, read, turbos: turbosOf(tracked, read) };
};

const withTurbos = (state, change) => {
  const turbos = new Map([...state.turbos].map(([p, doc]) => [p, structuredClone(doc)]));
  change(turbos);
  return { ...state, turbos };
};

/** Apply `change(inputs, owner)` to every lint definition and globalDependencies. */
const eachLintDefinition = (turbos, change) => {
  for (const [path, doc] of turbos) {
    for (const [key, def] of Object.entries(doc.tasks ?? {})) {
      if (key === 'lint' || key.endsWith('#lint')) {
        def.inputs = change(def.inputs ?? ['$TURBO_DEFAULT$']);
      }
    }
    if (path === 'turbo.json') doc.globalDependencies = change(doc.globalDependencies ?? []);
  }
};

const problemsOf = ({ names, registered, ...rest }) => [
  ...unregisteredTests(names, registered),
  ...staleRegistrations(registered, (f) => names.includes(f.slice('scripts/'.length))),
  ...inputProblems(rest),
];

const fail = (problems) => problems.join('\n');
const startsWith = (problems, prefix) => problems.filter((p) => p.startsWith(prefix));

// ---------------------------------------------------------------------------
// The checks.
// ---------------------------------------------------------------------------

test('every rule test the convention covers is run by lint:scripts, and the list is not stale', () => {
  const { names, registered, tracked } = realState();
  const problems = [
    ...unregisteredTests(names, registered),
    ...staleRegistrations(registered, (f) => tracked.has(f)),
  ];
  assert.deepEqual(problems, [], fail(problems));
});

test('every file eslint loads is hashed by the effective turbo lint inputs of each workspace', () => {
  const problems = inputProblems(realState());
  assert.deepEqual(problems, [], fail(problems));
});

test('the dependency graph found is the real one: configs, rules and the portal', () => {
  const { tracked, read } = realState();
  const problems = [];
  const { lint, names } = workspaces(tracked, read, problems);
  assert.deepEqual(problems, []);
  assert.ok(lint.length >= 20, `expected the known workspaces, found ${lint.length}`);
  const web = lint.find((w) => w.name === '@rasta/web');
  const { files, errors } = dependencyClosure(nearestConfigs(web.dir, tracked), {
    tracked,
    read,
    workspaceNames: names,
  });
  assert.deepEqual(errors, []);
  for (const rule of [
    'apps/web/eslint.config.mjs',
    'scripts/internal-token-transport-rule.mjs',
    'scripts/no-zod-default-rule.mjs',
    'scripts/raw-http-boundary-rule.mjs',
  ]) {
    assert.ok(files.has(rule), `${rule} is no longer discovered for @rasta/web`);
  }
});

// Mutants: each takes the real state, removes effective coverage of ONE thing
// (never just changes a spelling), and the guard must fail naming it.
test('mutant: dropping any one lint:scripts registration fails naming the file', () => {
  const state = realState();
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

const loadedFiles = (state) => {
  const problems = [];
  const { lint, names } = workspaces(state.tracked, state.read, problems);
  const all = new Map();
  for (const w of lint) {
    const { files } = dependencyClosure(nearestConfigs(w.dir, state.tracked), {
      tracked: state.tracked,
      read: state.read,
      workspaceNames: names,
    });
    for (const [file, why] of files) all.set(file, why);
  }
  return all;
};

test('mutant: excluding any one loaded file from every lint task (and the globals) fails naming it', () => {
  const state = realState();
  const loaded = [...loadedFiles(state).keys()];
  assert.ok(
    loaded.length >= 30,
    `expected every workspace config and the rules, found ${loaded.length}`,
  );
  for (const file of loaded) {
    const mutant = withTurbos(state, (turbos) =>
      eachLintDefinition(turbos, (inputs) => [...inputs, `!$TURBO_ROOT$/${file}`]),
    );
    const problems = inputProblems(mutant);
    assert.equal(startsWith(problems, `${file} `).length, 1, `${file}: ${problems.join(' | ')}`);
    assert.equal(problems.length, 1, `${file}: ${problems.join(' | ')}`);
  }
});

test('mutant: deleting every input that covers a shared file fails naming it', () => {
  const state = realState();
  const shared = [...loadedFiles(state).keys()].filter(
    (f) => f.startsWith('scripts/') || f === 'eslint.config.mjs',
  );
  assert.ok(shared.length >= 5, `expected the root config and the rules, found ${shared.length}`);
  for (const file of shared) {
    // Whatever the spelling (verbatim or a wildcard), remove the entries that match the file.
    const removed = [];
    const mutant = withTurbos(state, (turbos) =>
      eachLintDefinition(turbos, (inputs) =>
        inputs.filter((i) => {
          const glob = underRoot(i) ?? i;
          const drop = !i.startsWith('!') && i !== '$TURBO_DEFAULT$' && matches(file, glob);
          if (drop) removed.push(glob);
          return !drop;
        }),
      ),
    );
    assert.ok(removed.length > 0, `${file} is covered by no explicit input to delete`);
    const problems = inputProblems(mutant);
    assert.equal(startsWith(problems, `${file} `).length, 1, `${file}: ${problems.join(' | ')}`);
    // Only files the removed entries covered may newly fail (a wildcard covers several).
    for (const problem of problems) {
      const named = problem.split(' ')[0];
      assert.ok(
        removed.some((glob) => matches(named, glob)),
        `${file}: unrelated problem ${problem}`,
      );
    }
  }
});

test('mutant: a root <pkg>#lint or a workspace lint override that omits the shared inputs fails', () => {
  const state = realState();
  // @rasta/web loads three rules directly; @rasta/contracts loads the root config (all four).
  const webShared = [
    'scripts/internal-token-transport-rule.mjs',
    'scripts/no-zod-default-rule.mjs',
    'scripts/raw-http-boundary-rule.mjs',
  ];
  const contractsShared = ['eslint.config.mjs', 'scripts/exchange-deadline-rule.mjs', ...webShared];
  const rootOverride = withTurbos(state, (turbos) => {
    turbos.get('turbo.json').tasks['@rasta/web#lint'] = { inputs: ['$TURBO_DEFAULT$'] };
  });
  const rootProblems = inputProblems(rootOverride);
  for (const file of webShared)
    assert.equal(startsWith(rootProblems, `${file} `).length, 1, fail(rootProblems));
  assert.ok(
    rootProblems.every((p) => p.includes('@rasta/web') && !p.includes('@rasta/config')),
    fail(rootProblems),
  );
  const wsOverride = withTurbos(state, (turbos) => {
    turbos.set('packages/contracts/turbo.json', {
      extends: ['//'],
      tasks: { lint: { inputs: ['$TURBO_DEFAULT$'] } },
    });
  });
  const wsProblems = inputProblems(wsOverride);
  for (const file of contractsShared)
    assert.equal(startsWith(wsProblems, `${file} `).length, 1, fail(wsProblems));
  assert.ok(
    wsProblems.every((p) => p.includes('@rasta/contracts')),
    fail(wsProblems),
  );
});

test('wildcard coverage of the same files is accepted, whatever the spelling', () => {
  const state = realState();
  for (const inputs of [
    ['$TURBO_DEFAULT$', '$TURBO_ROOT$/eslint.config.mjs', '$TURBO_ROOT$/scripts/*-rule.mjs'],
    ['$TURBO_DEFAULT$', '$TURBO_ROOT$/{eslint.config.mjs,scripts/*-rule.mjs}'],
    ['$TURBO_DEFAULT$', '$TURBO_ROOT$/eslint.config.mjs', '$TURBO_ROOT$/scripts/**/*.mjs'],
    ['$TURBO_DEFAULT$', '$TURBO_ROOT$/eslint.config.mjs', '../../scripts/*.mjs'],
  ]) {
    const mutant = withTurbos(state, (turbos) => {
      turbos.get('turbo.json').tasks.lint.inputs = inputs;
    });
    assert.deepEqual(inputProblems(mutant), [], inputs.join(' '));
  }
  // …and a wildcard that excludes one still fails.
  const narrowed = withTurbos(state, (turbos) => {
    turbos.get('turbo.json').tasks.lint.inputs = [
      '$TURBO_DEFAULT$',
      '$TURBO_ROOT$/eslint.config.mjs',
      '$TURBO_ROOT$/scripts/*-rule.mjs',
      '!$TURBO_ROOT$/scripts/no-zod-*',
    ];
  });
  const problems = inputProblems(narrowed);
  assert.equal(problems.length, 1, fail(problems));
  assert.ok(problems[0].startsWith('scripts/no-zod-default-rule.mjs '), problems[0]);
});

test('mutant: a new rule, sibling suite or stale entry is caught', () => {
  const names = [
    ...realState().names,
    'brand-new-rule.mjs',
    'brand-new-rule.test.mjs',
    'brand-new-extra.test.mjs',
  ];
  const registered = [
    ...realState().registered,
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
    registeredTests(JSON.parse(readDisk('package.json')).scripts['lint:scripts']).includes(SELF),
  );
  assert.ok(
    relative(ROOT, fileURLToPath(import.meta.url))
      .split(sep)
      .join('/') === SELF,
  );
});

// ---------------------------------------------------------------------------
// Fixtures: a small repository, then the ways a lint dependency escaped.
// ---------------------------------------------------------------------------

const baseFiles = () => ({
  'package.json': '{"name":"root","scripts":{"lint":"turbo run lint"}}',
  'turbo.json': JSON.stringify({
    tasks: {
      lint: {
        inputs: [
          '$TURBO_DEFAULT$',
          '$TURBO_ROOT$/eslint.config.mjs',
          '$TURBO_ROOT$/scripts/a-rule.mjs',
          '$TURBO_ROOT$/scripts/helper-a.mjs',
          '$TURBO_ROOT$/scripts/helper-b.mjs',
        ],
      },
    },
  }),
  'eslint.config.mjs': "import a from './scripts/a-rule.mjs';\nexport default [a];\n",
  'scripts/a-rule.mjs': "import { x } from './helper-a.mjs';\nexport default x;\n",
  'scripts/helper-a.mjs': "import { y } from './helper-b.mjs';\nexport const x = y;\n",
  'scripts/helper-b.mjs': 'export const y = 1;\n',
  'apps/web/package.json': '{"name":"@rasta/web","scripts":{"lint":"eslint src"}}',
  'apps/web/eslint.config.mjs': "export { default } from '../../eslint.config.mjs';\n",
});

const WEB_CONFIG = 'apps/web/eslint.config.mjs';
const without = (files, ...paths) =>
  Object.fromEntries(Object.entries(files).filter(([path]) => !paths.includes(path)));

test('fixture: the baseline repository has no problems', () => {
  assert.deepEqual(inputProblems(memoryState(baseFiles())), []);
});

// The review's escape variants (each left every earlier guard test green).
const ESCAPES = {
  'a tracked .cjs config loading a rule with require()': {
    files: {
      ...without(baseFiles(), WEB_CONFIG),
      'apps/web/eslint.config.cjs': "module.exports = require('../../scripts/c-rule.js');\n",
      'scripts/c-rule.js': 'module.exports = {};\n',
    },
    missing: ['scripts/c-rule.js'],
  },
  'a .js config using require()': {
    files: {
      ...without(baseFiles(), WEB_CONFIG),
      'apps/web/eslint.config.js':
        "const rule = require('../../scripts/c-rule.cjs');\nmodule.exports = [rule];\n",
      'scripts/c-rule.cjs': 'module.exports = {};\n',
    },
    missing: ['scripts/c-rule.cjs'],
  },
  'a .mjs config using a literal import()': {
    files: {
      ...baseFiles(),
      [WEB_CONFIG]:
        "const rule = await import('../../scripts/c-rule.mjs');\nexport default [rule];\n",
      'scripts/c-rule.mjs': 'export default {};\n',
    },
    missing: ['scripts/c-rule.mjs'],
  },
  'a .ts config loading a rule': {
    files: {
      ...without(baseFiles(), WEB_CONFIG),
      'apps/web/eslint.config.ts':
        "import rule from '../../scripts/c-rule.ts';\nexport default [rule];\n",
      'scripts/c-rule.ts': 'export default {};\n',
    },
    missing: ['scripts/c-rule.ts'],
  },
  'a config importing a local plugin barrel that imports the rule': {
    files: {
      ...baseFiles(),
      [WEB_CONFIG]:
        "import plugin from '../../tools/plugin/index.mjs';\nexport default [plugin];\n",
      'tools/plugin/index.mjs': "export { default } from './rules.mjs';\n",
      'tools/plugin/rules.mjs':
        "import rule from '../../scripts/c-rule.mjs';\nexport default { rule };\n",
      'scripts/c-rule.mjs': 'export default {};\n',
    },
    missing: ['scripts/c-rule.mjs', 'tools/plugin/index.mjs', 'tools/plugin/rules.mjs'],
  },
  'a rule importing helper A that imports helper B, only A listed': {
    files: {
      ...baseFiles(),
      'turbo.json': JSON.stringify({
        tasks: {
          lint: {
            inputs: [
              '$TURBO_DEFAULT$',
              '$TURBO_ROOT$/eslint.config.mjs',
              '$TURBO_ROOT$/scripts/a-rule.mjs',
              '$TURBO_ROOT$/scripts/helper-a.mjs',
            ],
          },
        },
      }),
    },
    missing: ['scripts/helper-b.mjs'],
  },
  'a root <pkg>#lint task whose inputs omit the shared rules': {
    files: {
      ...baseFiles(),
      'turbo.json': JSON.stringify({
        tasks: {
          ...JSON.parse(baseFiles()['turbo.json']).tasks,
          '@rasta/web#lint': { inputs: ['$TURBO_DEFAULT$'] },
        },
      }),
    },
    missing: [
      'eslint.config.mjs',
      'scripts/a-rule.mjs',
      'scripts/helper-a.mjs',
      'scripts/helper-b.mjs',
    ],
  },
  'a "!" exclusion of one rule next to its positive input': {
    files: {
      ...baseFiles(),
      'turbo.json': JSON.stringify({
        tasks: {
          lint: {
            inputs: [
              ...JSON.parse(baseFiles()['turbo.json']).tasks.lint.inputs,
              '!$TURBO_ROOT$/scripts/a-rule.mjs',
            ],
          },
        },
      }),
    },
    missing: ['scripts/a-rule.mjs'],
  },
  'a workspace turbo.json lint override that omits the shared rules': {
    files: {
      ...baseFiles(),
      'apps/web/turbo.json': JSON.stringify({
        extends: ['//'],
        tasks: { lint: { inputs: ['$TURBO_DEFAULT$'] } },
      }),
    },
    missing: [
      'eslint.config.mjs',
      'scripts/a-rule.mjs',
      'scripts/helper-a.mjs',
      'scripts/helper-b.mjs',
    ],
  },
};

for (const [name, { files, missing }] of Object.entries(ESCAPES)) {
  test(`escape: ${name} is caught`, () => {
    const problems = inputProblems(memoryState(files));
    for (const file of missing) {
      assert.equal(startsWith(problems, `${file} `).length, 1, `${file}: ${fail(problems)}`);
    }
    assert.equal(problems.length, missing.length, fail(problems));
  });
}

test('fixture: $TURBO_EXTENDS$, cache:false and negation-only inputs resolve as turbo does', () => {
  const base = baseFiles();
  const turboWith = (tasks) =>
    JSON.stringify({ tasks: { ...JSON.parse(base['turbo.json']).tasks, ...tasks } });
  const web = (tasks) => ({ 'apps/web/turbo.json': JSON.stringify({ extends: ['//'], tasks }) });
  // Extending the parent keeps its coverage; adding an exclusion removes exactly that.
  assert.deepEqual(
    inputProblems(
      memoryState({ ...base, ...web({ lint: { inputs: ['$TURBO_EXTENDS$', 'extra/**'] } }) }),
    ),
    [],
  );
  const negated = inputProblems(
    memoryState({
      ...base,
      ...web({ lint: { inputs: ['$TURBO_EXTENDS$', '!$TURBO_ROOT$/scripts/helper-b.mjs'] } }),
    }),
  );
  assert.equal(negated.length, 1, fail(negated));
  assert.ok(negated[0].startsWith('scripts/helper-b.mjs '), negated[0]);
  // An uncached task has no stale green to replay.
  assert.deepEqual(
    inputProblems(
      memoryState({
        ...base,
        'turbo.json': turboWith({ lint: { cache: false, inputs: ['$TURBO_DEFAULT$'] } }),
      }),
    ),
    [],
  );
  // Only negations: turbo drops the default, so the package's own config is no longer hashed.
  const onlyNegations = inputProblems(
    memoryState({ ...base, 'turbo.json': turboWith({ lint: { inputs: ['!nothing/**'] } }) }),
  );
  assert.ok(startsWith(onlyNegations, `${WEB_CONFIG} `).length === 1, fail(onlyNegations));
  // No lint task at all for a workspace that lints.
  assert.ok(
    inputProblems(memoryState({ ...base, 'turbo.json': JSON.stringify({ tasks: {} }) })).some((p) =>
      p.includes('defines no `lint` task'),
    ),
  );
  // globalDependencies are hashed into every task.
  assert.deepEqual(
    inputProblems(
      memoryState({
        ...base,
        'turbo.json': JSON.stringify({
          globalDependencies: ['scripts/helper-*.mjs'],
          tasks: {
            lint: {
              inputs: [
                '$TURBO_DEFAULT$',
                '$TURBO_ROOT$/eslint.config.mjs',
                '$TURBO_ROOT$/scripts/a-rule.mjs',
              ],
            },
          },
        }),
      }),
    ),
    [],
  );
});

// Loading forms the guard cannot analyse fail closed, with a clear message.
const UNANALYSABLE = {
  'a non-literal require()': "const n = './x';\nmodule.exports = require(n);\n",
  'a non-literal import()': "const n = './x.mjs';\nexport default await import(n);\n",
  'an import() of a template with a substitution':
    'const n = "x";\nexport default await import(`./${n}.mjs`);\n',
  createRequire:
    "import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nexport default r('./x.cjs');\n",
  'an aliased require': "const load = require;\nmodule.exports = load('./a.cjs');\n",
  eval: "export default eval('1');\n",
  'a non-literal import.meta.resolve': 'export default import.meta.resolve(process.env.X);\n',
  'a #alias import': "import x from '#rules/x';\nexport default x;\n",
  'an absolute path': "import x from '/etc/x.mjs';\nexport default x;\n",
  'an unresolvable relative import': "import x from './missing.mjs';\nexport default x;\n",
  'an import of a workspace package': "import x from '@rasta/web/rule';\nexport default x;\n",
};

for (const [name, config] of Object.entries(UNANALYSABLE)) {
  for (const holder of ['config', 'rule', 'helper']) {
    test(`fail closed: ${name} in a ${holder} is an error`, () => {
      const files = baseFiles();
      if (holder === 'config') files[WEB_CONFIG] = config;
      else if (holder === 'rule') files['scripts/a-rule.mjs'] = config;
      else files['scripts/helper-b.mjs'] = config;
      const problems = inputProblems(memoryState(files));
      assert.ok(problems.length >= 1, `${name}: not rejected`);
      assert.ok(
        problems.some((p) =>
          /cannot follow|cannot read|not a tracked file|workspace package/.test(p),
        ),
        fail(problems),
      );
    });
  }
}

test('fixture: forms that are not loads are not mistaken for them', () => {
  const files = baseFiles();
  files['scripts/helper-b.mjs'] =
    "// require(computed) and import(x) in a comment, createRequire too\nexport const y = 'require(n) eval import(m)';\nexport const o = { require: 1 }.require;\n";
  assert.deepEqual(inputProblems(memoryState(files)), []);
});

test('fixture: an import cycle terminates and every member is covered', () => {
  const files = baseFiles();
  files['scripts/helper-b.mjs'] = "import { x } from './helper-a.mjs';\nexport const y = x;\n";
  files['scripts/a-rule.mjs'] = "import { x } from './helper-a.mjs';\nexport default x;\n";
  assert.deepEqual(inputProblems(memoryState(files)), []);
  const turbo = JSON.parse(files['turbo.json']);
  turbo.tasks.lint.inputs = turbo.tasks.lint.inputs.filter((i) => !i.endsWith('helper-b.mjs'));
  const problems = inputProblems(memoryState({ ...files, 'turbo.json': JSON.stringify(turbo) }));
  assert.equal(problems.length, 1, fail(problems));
  assert.ok(problems[0].startsWith('scripts/helper-b.mjs '), problems[0]);
});

test('fixture: a legacy eslintrc, an unused config and a non-eslint lint script are errors', () => {
  const base = baseFiles();
  assert.ok(
    inputProblems(memoryState({ ...base, 'apps/web/.eslintrc.json': '{}' })).some((p) =>
      p.includes('legacy'),
    ),
  );
  assert.ok(
    inputProblems(memoryState({ ...base, 'tools/eslint.config.mjs': 'export default [];\n' })).some(
      (p) => p.includes('no workspace lint task uses'),
    ),
  );
  assert.ok(
    inputProblems(
      memoryState({
        ...base,
        'apps/web/package.json': '{"name":"@rasta/web","scripts":{"lint":"tsc --noEmit"}}',
      }),
    ).some((p) => p.includes('only models plain `eslint')),
  );
  assert.ok(
    inputProblems(
      memoryState({
        ...base,
        'apps/web/package.json': '{"name":"@rasta/web","scripts":{"lint":"eslint -c x.mjs src"}}',
      }),
    ).some((p) => p.includes('only models plain `eslint')),
  );
});

// ---------------------------------------------------------------------------
// The JSONC reader.
// ---------------------------------------------------------------------------

test('the JSONC reader keeps strings that look like comments', () => {
  assert.deepEqual(parseJsonc('{ // c\n "a": "x // y /* z */", /* b */ "b": 1 }'), {
    a: 'x // y /* z */',
    b: 1,
  });
});

test('the JSONC reader rejects unterminated input instead of hanging', () => {
  for (const text of ['{"unfinished":"', '{"a":"x\\', '{"a": "b"', '{ /* open', '"']) {
    assert.throws(() => parseJsonc(text), undefined, text);
  }
});
