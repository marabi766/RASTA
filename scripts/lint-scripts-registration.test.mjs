import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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
 * (2) has two halves, each closed at a boundary instead of by modelling:
 *
 *  - COVERAGE is asked of turbo, never computed. The test runs
 *    `turbo run lint --dry=json` (turbo is a devDependency; no build is needed),
 *    takes each lint task's resolved, hashed input file list plus the global
 *    hash inputs, and asserts every file the guard discovered is in it. Turbo's
 *    own matcher decides what a glob, `@(…)`, `!(…)`, a hidden path or an
 *    exclusion means, so the guard has no glob semantics to get wrong. If turbo
 *    cannot run the test FAILS; it never skips.
 *  - DISCOVERY is a supported GRAMMAR, failing closed. In an eslint config and
 *    every module it loads, the only loading forms are a static `import`,
 *    `export … from`, a literal `import()` or a literal `require()` of (a) a
 *    relative path to an existing tracked file with an explicit JS/TS extension
 *    or (b) a bare package that is not a workspace package, a workspace alias
 *    or a `link:`/`file:`/`portal:` dependency (or a node built-in from a short
 *    allow-list). Anything else — any other use of require/module/Module/
 *    createRequire/_load/Function/eval, a filesystem read, `.call/.apply/.bind`,
 *    a directory or extensionless or `.json` path — is a problem with a message,
 *    not something the guard tries to resolve. Lint scripts must be exactly
 *    `eslint <paths>`.
 *
 * Mutants run against the real repository through turbo too (a mutated copy of
 * turbo.json passed with `--root-turbo-json`), so no test agrees with itself.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'scripts/lint-scripts-registration.test.mjs';

const CONFIG_NAMES = ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].map((e) => `eslint.config.${e}`);
/** The only extensions a loaded file may carry: node/jiti execute these as code. */
const KNOWN_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** Extensions whose module format comes from the nearest package.json `type`. */
const TYPED_EXT = /\.(?:[jt]sx?)$/;

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
// (2a) The supported loading grammar.
// ---------------------------------------------------------------------------

const GRAMMAR =
  'is outside the supported grammar of the lint-input guard (static import, export … from, ' +
  'literal import() or require() of a relative path with an explicit JS/TS extension, or a bare, non-workspace package)';

/** Node built-ins an eslint config or rule may import: none of them loads code or reads files. */
export const ALLOWED_BUILTINS = new Set([
  'path',
  'path/posix',
  'url',
  'util',
  'assert',
  'assert/strict',
]);

/** Identifiers that reach the module loader, a code evaluator or the global object. */
const BANNED_NAMES = new Set([
  'require',
  'module',
  'Module',
  'createRequire',
  '_load',
  'Function',
  'eval',
  'globalThis',
  'global',
]);
/** Member names that reach them from some other value (`x.require`, `f.call`, `p.binding`). */
const BANNED_MEMBERS = new Set([
  'require',
  'Module',
  'createRequire',
  '_load',
  '_resolveFilename',
  '_extensions',
  'Function',
  'eval',
  'mainModule',
  'binding',
  'dlopen',
  'getBuiltinModule',
  'constructor',
  'call',
  'apply',
  'bind',
]);
const META_MEMBERS = new Set(['url', 'dirname', 'filename']);
const KEY_KINDS = new Set([
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.EnumMember,
]);

const isLiteral = (node) =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

/**
 * Literal specifiers of every module `source` loads, plus every use of the module
 * system, evaluator or global object that is not one of the supported forms.
 */
export const analyzeModule = (path, source) => {
  const key = `${path}\0${source}`;
  if (!analysisCache.has(key)) analysisCache.set(key, analyze(path, source));
  return analysisCache.get(key);
};
/** Parsing is the cost, and the same files are analysed for every workspace and mutant. */
const analysisCache = new Map();

const analyze = (path, source) => {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const specifiers = new Set();
  const errors = [];
  const at = (node) => `${path}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  const bad = (node, what) => errors.push(`${at(node)} ${what} ${GRAMMAR}.`);
  const literalArg = (call, form) => {
    const [first] = call.arguments;
    if (isLiteral(first)) specifiers.add(first.text);
    else bad(call, `${form} with a non-literal specifier`);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) {
        if (isLiteral(node.moduleSpecifier)) specifiers.add(node.moduleSpecifier.text);
        else bad(node, 'a module specifier that is not a literal');
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        const { expression } = node.moduleReference;
        if (isLiteral(expression)) specifiers.add(expression.text);
        else bad(node, '`import x = require(…)` with a non-literal specifier');
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) literalArg(node, 'import()');
      else if (ts.isIdentifier(callee) && callee.text === 'require') {
        if (node.arguments.length === 1) literalArg(node, 'require()');
        else bad(node, '`require` called with other than one argument');
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      const member = node.name.text;
      if (node.expression.kind === ts.SyntaxKind.MetaProperty) {
        if (!META_MEMBERS.has(member)) bad(node, `\`import.meta.${member}\``);
      } else if (BANNED_MEMBERS.has(member)) {
        bad(node.name, `the member \`.${member}\``);
      }
    } else if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      if (isLiteral(arg) && (BANNED_MEMBERS.has(arg.text) || BANNED_NAMES.has(arg.text))) {
        bad(node, `the computed member \`[${JSON.stringify(arg.text)}]\``);
      } else if (
        node.expression.kind === ts.SyntaxKind.MetaProperty ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'process')
      ) {
        bad(node, 'a computed member of `process` or `import.meta`');
      }
    } else if (ts.isMetaProperty(node)) {
      const { parent } = node;
      if (
        node.keywordToken === ts.SyntaxKind.ImportKeyword &&
        !(ts.isPropertyAccessExpression(parent) && parent.expression === node)
      ) {
        bad(node, '`import.meta` used as a value');
      }
    } else if (ts.isIdentifier(node) && BANNED_NAMES.has(node.text)) {
      const { parent } = node;
      const isKey = KEY_KINDS.has(parent.kind) && parent.name === node;
      const isMember = ts.isPropertyAccessExpression(parent) && parent.name === node;
      const isRequireCall =
        node.text === 'require' && ts.isCallExpression(parent) && parent.expression === node;
      const isModuleExports =
        node.text === 'module' &&
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.name.text === 'exports';
      if (!isKey && !isMember && !isRequireCall && !isModuleExports) {
        bad(
          node,
          `\`${node.text}\` used other than as a literal \`require('./x')\` or \`module.exports\``,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { specifiers, errors };
};

/**
 * Package names and aliases that resolve to code in this repository (or on disk):
 * every package.json `name`, every dependency key whose spec is `workspace:`,
 * `link:`, `file:` or `portal:` (a `workspace:name@*` spec also names its target),
 * an `npm:` alias of a workspace package, and the same in pnpm-workspace.yaml.
 */
export const localPackageNames = (tracked, read, problems) => {
  const names = new Set();
  const aliases = [];
  const walk = (value, key) => {
    if (typeof value === 'string') {
      if (key !== undefined && /^(?:workspace|link|file|portal):/.test(value)) names.add(key);
      const target = /^workspace:((?:@[^/@]+\/)?[^/@]+)@/.exec(value);
      if (target) names.add(target[1]);
      const npm = /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@|$)/.exec(value);
      if (npm && key !== undefined) aliases.push([key, npm[1]]);
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  for (const file of tracked) {
    if (/(^|\/)package\.json$/.test(file)) {
      try {
        const pkg = JSON.parse(read(file));
        if (typeof pkg.name === 'string') names.add(pkg.name);
        walk(pkg);
      } catch (error) {
        problems.push(
          `${file} is not readable JSON (${error.message}); its lint task cannot be checked.`,
        );
      }
    } else if (/(^|\/)pnpm-workspace\.ya?ml$/.test(file)) {
      for (const line of String(read(file) ?? '').split('\n')) {
        const m = /^\s*['"]?([^'":\s]+)['"]?\s*:\s*['"]?(?:workspace|link|file|portal):/.exec(line);
        if (m) names.add(m[1]);
      }
    }
  }
  for (const [alias, target] of aliases) if (names.has(target)) names.add(alias);
  return names;
};

/** The nearest tracked package.json at or above `file` (it sets the module type of `.js`/`.ts`). */
const nearestPackageJson = (file, tracked) => {
  for (let d = posix.dirname(file); ; d = posix.dirname(d)) {
    const candidate = d === '.' ? 'package.json' : `${d}/package.json`;
    if (tracked.has(candidate)) return candidate;
    if (d === '.') return undefined;
  }
};

/**
 * Every tracked file `entries` load, directly or through other local modules, and
 * every loading form outside the grammar. A visited set makes cycles terminate.
 * Result: file → why it is there.
 */
export const dependencyClosure = (entries, { tracked, read, localNames }) => {
  const files = new Map(entries.map((entry) => [entry, 'an eslint config']));
  const errors = [];
  const queue = [...entries];
  const bare = (file, specifier) => {
    const name = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];
    if (localNames.has(name) || /(^|\/)\.\.?(\/|$)/.test(specifier)) {
      errors.push(
        `${file} loads '${specifier}', a workspace package, workspace alias or linked dependency: its source is a ` +
          `lint input the guard does not follow, so this ${GRAMMAR}. Import it by relative path.`,
      );
    }
  };
  while (queue.length > 0) {
    const file = queue.shift();
    const meta = TYPED_EXT.test(file) ? nearestPackageJson(file, tracked) : undefined;
    if (meta !== undefined && !files.has(meta)) {
      files.set(meta, `its \`type\` decides how ${file} loads`);
    }
    const source = read(file);
    if (source === undefined) {
      errors.push(`${file} cannot be read, so what it loads is unknown.`);
      continue;
    }
    const { specifiers, errors: found } = analyzeModule(file, source);
    errors.push(...found);
    for (const specifier of specifiers) {
      if (/^\.\.?(\/|$)/.test(specifier)) {
        const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
        if (!KNOWN_EXT.test(specifier)) {
          errors.push(
            `${file} loads '${specifier}', a relative path without an explicit JS/TS extension (a directory, ` +
              `extensionless, .json or unknown suffix), so this ${GRAMMAR}.`,
          );
        } else if (!tracked.has(resolved)) {
          errors.push(
            `${file} loads '${specifier}', which is not an existing tracked file, so this ${GRAMMAR}.`,
          );
        } else if (!files.has(resolved)) {
          files.set(resolved, `loaded by ${file}`);
          queue.push(resolved);
        }
      } else if (specifier.startsWith('node:') || isBuiltin(specifier)) {
        if (!ALLOWED_BUILTINS.has(specifier.replace(/^node:/, ''))) {
          errors.push(
            `${file} loads the built-in '${specifier}', which can load code or read files, so this ${GRAMMAR}.`,
          );
        }
      } else if (/^[#/]/.test(specifier) || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
        errors.push(
          `${file} loads '${specifier}' (an absolute path, URL or #alias), so this ${GRAMMAR}.`,
        );
      } else {
        bare(file, specifier);
      }
    }
  }
  return { files, errors };
};

// ---------------------------------------------------------------------------
// (2b) Workspaces and their lint commands.
// ---------------------------------------------------------------------------

/**
 * The only lint command the guard models: `eslint <paths>` — no flag, no
 * `-c/--config/--resolve-plugins-relative-to`, no `cd`, no `&&`, no environment
 * prefix. ESLint then looks its flat config up from the workspace directory.
 */
export const lintScriptProblem = (script) => {
  const tokens = script.trim().split(/\s+/);
  const path = /^[A-Za-z0-9_@./*{},+][A-Za-z0-9_@./*{},+-]*$/;
  if (tokens[0] !== 'eslint' || tokens.length < 2 || !tokens.slice(1).every((t) => path.test(t))) {
    return `\`lint\` is \`${script}\`: the guard only supports exactly \`eslint <paths>\` (no flag such as -c/--config, no cd, &&, ; or environment prefix), because it reads the default config lookup from the workspace directory.`;
  }
  return undefined;
};

/** Workspaces with a `lint` script (valid ones in `lint`), and every local package name. */
export const workspaces = (tracked, read, problems) => {
  const lint = [];
  const all = new Set();
  const localNames = localPackageNames(tracked, read, problems);
  for (const file of [...tracked].filter((f) => /(^|\/)package\.json$/.test(f))) {
    let pkg;
    try {
      pkg = JSON.parse(read(file));
    } catch {
      continue; // already reported by localPackageNames
    }
    if (file === 'package.json' || pkg.scripts?.lint === undefined) continue;
    all.add(pkg.name);
    const hooks = ['prelint', 'postlint'].filter((h) => pkg.scripts[h] !== undefined);
    const problem = lintScriptProblem(String(pkg.scripts.lint));
    if (hooks.length > 0) {
      problems.push(
        `${file} defines \`${hooks.join('`, `')}\`, which runs around \`lint\` and which the guard does not model.`,
      );
    } else if (problem !== undefined) {
      problems.push(`${file} ${problem}`);
    } else {
      lint.push({ name: pkg.name, dir: posix.dirname(file) });
    }
  }
  return { lint, all, localNames };
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

const LEGACY_CONFIG = /(^|\/)\.eslintrc(\.[a-z]+)?$/;

/**
 * What eslint loads for every lint workspace, and every problem with the way it
 * loads it. Needs no turbo: this half is the grammar.
 */
export const discover = ({ tracked, read }) => {
  const problems = [];
  const { lint, all, localNames } = workspaces(tracked, read, problems);
  for (const file of tracked) {
    if (LEGACY_CONFIG.test(file)) {
      problems.push(`${file} is a legacy eslint config the guard does not model.`);
    }
  }
  const found = [];
  const used = new Set();
  for (const workspace of lint) {
    const configs = nearestConfigs(workspace.dir, tracked);
    if (configs.length === 0) {
      problems.push(
        `${workspace.name} runs eslint but no eslint.config.* exists at or above ${workspace.dir}.`,
      );
      continue;
    }
    const { files, errors } = dependencyClosure(configs, { tracked, read, localNames });
    for (const config of configs) used.add(config);
    for (const error of errors) if (!problems.includes(error)) problems.push(error);
    found.push({ ...workspace, files });
  }
  for (const file of tracked) {
    if (/^eslint\.config\./.test(file) || !/(^|\/)eslint\.config\.[cm]?[jt]s$/.test(file)) continue;
    if (!used.has(file)) {
      problems.push(
        `${file} is an eslint config no workspace lint task uses; the guard cannot say what it loads.`,
      );
    }
  }
  return { problems, workspaces: found, all };
};

/**
 * Coverage, asked of turbo: `hashed` is `turboSnapshot()`'s resolved file lists.
 * A discovered file that is not in a lint task's hashed inputs (nor in the global
 * hash inputs) would change without invalidating that task.
 */
export const coverageProblems = ({ workspaces: found, all }, hashed) => {
  const problems = [];
  const missing = new Map();
  for (const workspace of found) {
    const task = hashed.tasks.get(`${workspace.name}#lint`);
    if (task === undefined) {
      problems.push(
        `${workspace.name} has a lint script but \`turbo run lint\` resolves no lint task for it.`,
      );
      continue;
    }
    if (!task.cache) continue;
    for (const [file, why] of workspace.files) {
      if (task.files.has(file) || hashed.global.has(file)) continue;
      const entry = missing.get(file) ?? { why, packages: [] };
      entry.packages.push(workspace.name);
      missing.set(file, entry);
    }
  }
  for (const name of hashed.tasks.keys()) {
    const pkg = name.slice(0, -'#lint'.length);
    if (pkg !== '//' && !all.has(pkg)) {
      problems.push(
        `turbo runs \`lint\` for ${pkg}, which the guard did not discover as a workspace with a lint script.`,
      );
    }
  }
  for (const [file, { why, packages }] of missing) {
    problems.push(
      `${file} (${why}) is loaded by eslint for ${packages.join(', ')} but is not in turbo's resolved hashed inputs ` +
        `for that task (\`turbo run lint --dry=json\`): a change to it would replay a cached lint green. Add ` +
        `"$TURBO_ROOT$/${file}" as a plain path to the task that applies (root \`lint\`, a root \`<pkg>#lint\`, or ` +
        `the workspace turbo.json), and remove any "!" exclusion that reaches it. Globs such as @(…), +(…) and !(…) ` +
        `are accepted by turbo without hashing anything.`,
    );
  }
  return problems;
};

/** Every problem with what turbo's lint tasks hash versus what eslint loads. */
export const inputProblems = ({ tracked, read, hashed }) => {
  const found = discover({ tracked, read });
  return [...found.problems, ...coverageProblems(found, hashed)];
};

// ---------------------------------------------------------------------------
// Turbo: the source of truth for what a lint task hashes.
// ---------------------------------------------------------------------------

/** Parse `turbo run lint --dry=json`: task → {cache, files (repo-relative)}, and the global files. */
export const parseDryRun = (json) => {
  const dry = JSON.parse(json);
  const tasks = new Map();
  for (const task of dry.tasks) {
    if (!task.taskId.endsWith('#lint') || task.command === '<NONEXISTENT>') continue;
    tasks.set(task.taskId, {
      cache: task.resolvedTaskDefinition?.cache !== false,
      files: new Set(
        Object.keys(task.inputs ?? {}).map((f) => posix.normalize(posix.join(task.directory, f))),
      ),
    });
  }
  return { tasks, global: new Set(Object.keys(dry.globalCacheInputs?.files ?? {})) };
};

/**
 * Run turbo for real. A missing binary, a non-zero exit or unreadable output
 * THROWS — a guard that cannot ask turbo has proved nothing, and must not pass.
 */
const turboCommand = ({
  cwd,
  rootTurboJson,
  bin = join(ROOT, 'node_modules', '.bin', 'turbo'),
}) => {
  if (!existsSync(bin)) {
    throw new Error(
      `turbo is not installed at ${bin} (it is a root devDependency: run \`pnpm install\`). ` +
        'The lint-input guard asks turbo what a lint task hashes and cannot pass without it.',
    );
  }
  const env = { ...process.env, TURBO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' };
  for (const key of Object.keys(env)) {
    if (/^TURBO_(TOKEN|TEAM|TEAMID|API|LOGIN|REMOTE|CACHE|FORCE)/.test(key)) delete env[key];
  }
  const args = [
    'run',
    'lint',
    '--dry=json',
    ...(rootTurboJson ? ['--root-turbo-json', rootTurboJson] : []),
  ];
  const options = { cwd, env, encoding: 'utf8', maxBuffer: 1 << 28 };
  const failed = (error) =>
    new Error(`\`turbo ${args.join(' ')}\` failed in ${cwd}: ${error.stderr || error.message}`);
  return { bin, args, options, failed };
};

export const turboSnapshot = (options) => {
  const { bin, args, options: run, failed } = turboCommand(options);
  try {
    return parseDryRun(execFileSync(bin, args, { ...run, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    throw failed(error);
  }
};

/** The same, without blocking: lets a loop of mutants run turbo in parallel. */
export const turboSnapshotAsync = async (options) => {
  const { bin, args, options: run, failed } = turboCommand(options);
  try {
    const { stdout } = await promisify(execFile)(bin, args, run);
    return parseDryRun(stdout);
  } catch (error) {
    throw failed(error);
  }
};

/** Materialise an in-memory repository as a real git repository for turbo to read. */
export const withFixtureRepo = (files, use) => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-input-guard-'));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const git = (...args) =>
      execFileSync(
        'git',
        ['-c', 'user.name=guard', '-c', 'user.email=guard@example.invalid', ...args],
        {
          cwd: dir,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Run the whole guard on an in-memory repository, with turbo reading a real copy. */
export const fixtureProblems = (files) =>
  withFixtureRepo(files, (dir) => {
    const state = memoryState(files);
    return inputProblems({ ...state, hashed: turboSnapshot({ cwd: dir }) });
  });

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

const realState = () => {
  const tracked = new Set(trackedFiles());
  const read = (path) => (tracked.has(path) ? readDisk(path) : undefined);
  return {
    names: readdirSync(join(ROOT, 'scripts')).sort(),
    registered: registeredTests(JSON.parse(read('package.json')).scripts['lint:scripts'] ?? ''),
    tracked,
    read,
  };
};

let cachedSnapshot;
/** turbo's answer for the repository as it is (one run, shared by the tests). */
const realHashed = () => (cachedSnapshot ??= turboSnapshot({ cwd: ROOT }));

/** An in-memory repository: `files` maps tracked path → text. */
export const memoryState = (files) => ({
  tracked: new Set(Object.keys(files)),
  read: (path) => files[path],
});

/** The real repository with some files' text replaced (in memory only). */
const withText = (state, replacements) => ({
  ...state,
  read: (path) => (path in replacements ? replacements[path](state.read(path)) : state.read(path)),
});

/** turbo's answer for the real repository with a changed copy of the root turbo.json. */
const mutatedSnapshot = async (change) => {
  const doc = parseJsonc(readDisk('turbo.json'));
  change(doc);
  const dir = mkdtempSync(join(tmpdir(), 'lint-input-guard-turbo-'));
  try {
    const path = join(dir, 'turbo.json');
    writeFileSync(path, JSON.stringify(doc));
    return await turboSnapshotAsync({ cwd: ROOT, rootTurboJson: path });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Run `task` for every item, a few turbo processes at a time; the first failure rejects. */
const inParallel = async (items, task, width = 6) => {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await task(item);
    }),
  );
};

/** Apply `change(inputs)` to every lint definition and to globalDependencies. */
const eachLintDefinition = (doc, change) => {
  for (const [key, def] of Object.entries(doc.tasks ?? {})) {
    if (key === 'lint' || key.endsWith('#lint'))
      def.inputs = change(def.inputs ?? ['$TURBO_DEFAULT$']);
  }
  doc.globalDependencies = change(doc.globalDependencies ?? []);
};

const registrationProblems = ({ names, registered, tracked }) => [
  ...unregisteredTests(names, registered),
  ...staleRegistrations(registered, (f) => tracked.has(f)),
];

const fail = (problems) => problems.join('\n');
const startsWith = (problems, prefix) => problems.filter((p) => p.startsWith(prefix));
const realProblems = (state = realState()) => inputProblems({ ...state, hashed: realHashed() });
const loadedFiles = (state) => new Map(discover(state).workspaces.flatMap((w) => [...w.files]));

// ---------------------------------------------------------------------------
// The checks on the real repository.
// ---------------------------------------------------------------------------

test('every rule test the convention covers is run by lint:scripts, and the list is not stale', () => {
  const problems = registrationProblems(realState());
  assert.deepEqual(problems, [], fail(problems));
});

test('every file eslint loads is in turbo’s resolved hashed inputs of each workspace lint task', () => {
  const problems = realProblems();
  assert.deepEqual(problems, [], fail(problems));
});

test('the dependency graph found is the real one: configs, rules and the portal', () => {
  const state = realState();
  const found = discover(state);
  assert.deepEqual(found.problems, []);
  assert.ok(
    found.workspaces.length >= 20,
    `expected the known workspaces, found ${found.workspaces.length}`,
  );
  assert.deepEqual(
    [...found.workspaces.map((w) => w.name)].sort(),
    [...realHashed().tasks.keys()].map((id) => id.slice(0, -'#lint'.length)).sort(),
    'the workspaces the guard discovered are not the lint tasks turbo runs',
  );
  const web = found.workspaces.find((w) => w.name === '@rasta/web');
  for (const rule of [
    'apps/web/eslint.config.mjs',
    'scripts/internal-token-transport-rule.mjs',
    'scripts/no-zod-default-rule.mjs',
    'scripts/raw-http-boundary-rule.mjs',
  ]) {
    assert.ok(web.files.has(rule), `${rule} is no longer discovered for @rasta/web`);
  }
});

test('turbo cannot be skipped: a missing binary or a failing run throws', () => {
  assert.throws(
    () => turboSnapshot({ cwd: ROOT, bin: join(tmpdir(), 'no-such-turbo-binary') }),
    /not installed/,
  );
  const empty = mkdtempSync(join(tmpdir(), 'lint-input-guard-empty-'));
  try {
    assert.throws(() => turboSnapshot({ cwd: empty }), /failed/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

// Mutants: each takes the real state, removes real coverage of ONE thing, and the
// guard must fail naming it. Coverage is turbo's answer for the mutated config.
test('mutant: dropping any one lint:scripts registration fails naming the file', () => {
  const state = realState();
  assert.deepEqual(registrationProblems(state), []);
  const required = [...requiredTests(state.names).keys()];
  assert.ok(required.length >= 7, `expected the known rule tests, found ${required.length}`);
  for (const file of required) {
    const problems = registrationProblems({
      ...state,
      registered: state.registered.filter((f) => f !== file),
    });
    assert.equal(problems.length, 1, `${file}: ${problems.join(' | ')}`);
    assert.ok(problems[0].startsWith(`${file} `), problems[0]);
  }
});

test('mutant: excluding any one loaded file from every lint task (and the globals) fails naming it', async () => {
  const state = realState();
  const found = discover(state);
  const loaded = [...loadedFiles(state).keys()];
  assert.ok(
    loaded.length >= 30,
    `expected every workspace config and the rules, found ${loaded.length}`,
  );
  await inParallel(loaded, async (file) => {
    const hashed = await mutatedSnapshot((doc) => {
      // A `$TURBO_ROOT$/…` exclusion reaches files outside the workspace; turbo applies a file
      // inside the workspace only through the workspace-relative spelling, so exclude that too,
      // in a `<pkg>#lint` copy of the root task (what a real override would look like).
      for (const { name, dir } of found.workspaces) {
        if (!file.startsWith(`${dir}/`)) continue;
        const inputs = doc.tasks[`${name}#lint`]?.inputs ?? doc.tasks.lint.inputs;
        doc.tasks[`${name}#lint`] = {
          ...doc.tasks.lint,
          ...doc.tasks[`${name}#lint`],
          inputs: [...inputs, `!${file.slice(dir.length + 1)}`],
        };
      }
      eachLintDefinition(doc, (inputs) => [...inputs, `!$TURBO_ROOT$/${file}`]);
    });
    const problems = inputProblems({ ...state, hashed });
    assert.equal(startsWith(problems, `${file} `).length, 1, `${file}: ${problems.join(' | ')}`);
    assert.equal(problems.length, 1, `${file}: ${problems.join(' | ')}`);
  });
});

test('mutant: deleting the input that covers a shared file fails naming it', async () => {
  const state = realState();
  const shared = [...loadedFiles(state).keys()].filter(
    (f) => f.startsWith('scripts/') || f === 'eslint.config.mjs',
  );
  assert.ok(shared.length >= 5, `expected the root config and the rules, found ${shared.length}`);
  await inParallel(shared, async (file) => {
    let removed = 0;
    const hashed = await mutatedSnapshot((doc) =>
      eachLintDefinition(doc, (inputs) =>
        inputs.filter((i) => {
          if (i !== `$TURBO_ROOT$/${file}`) return true;
          removed += 1;
          return false;
        }),
      ),
    );
    assert.ok(removed > 0, `${file} has no verbatim input to delete`);
    const problems = inputProblems({ ...state, hashed });
    assert.equal(problems.length, 1, `${file}: ${problems.join(' | ')}`);
    assert.ok(problems[0].startsWith(`${file} `), problems[0]);
  });
});

test('mutant: a root <pkg>#lint override that omits the shared inputs fails', async () => {
  const state = realState();
  const hashed = await mutatedSnapshot((doc) => {
    doc.tasks['@rasta/web#lint'] = { inputs: ['$TURBO_DEFAULT$'] };
  });
  const problems = inputProblems({ ...state, hashed });
  for (const file of [
    'scripts/internal-token-transport-rule.mjs',
    'scripts/no-zod-default-rule.mjs',
    'scripts/raw-http-boundary-rule.mjs',
  ]) {
    assert.equal(startsWith(problems, `${file} `).length, 1, fail(problems));
  }
  assert.ok(
    problems.every((p) => p.includes('@rasta/web')),
    fail(problems),
  );
  assert.ok(!problems.some((p) => p.includes('@rasta/config')), fail(problems));
});

// The review's extglob escapes: turbo ACCEPTS these inputs and hashes none of the
// files they were meant to name. Only asking turbo notices.
const RULES = [
  'internal-token-transport',
  'raw-http-boundary',
  'exchange-deadline',
  'no-zod-default',
].map((stem) => `scripts/${stem}-rule.mjs`);

const withRuleInputs = (replacement) =>
  mutatedSnapshot((doc) =>
    eachLintDefinition(doc, (inputs) => [
      ...inputs.filter((i) => !RULES.some((rule) => i === `$TURBO_ROOT$/${rule}`)),
      ...(inputs.includes('$TURBO_DEFAULT$') ? replacement : []),
    ]),
  );

for (const [name, glob] of Object.entries({
  '@(…)':
    '$TURBO_ROOT$/scripts/@(internal-token-transport|raw-http-boundary|exchange-deadline|no-zod-default)-rule.mjs',
  '+(…)':
    '$TURBO_ROOT$/scripts/+(internal-token-transport|raw-http-boundary|exchange-deadline|no-zod-default)-rule.mjs',
  '!(…)': '$TURBO_ROOT$/scripts/!(nothing-at-all)-rule.mjs',
})) {
  test(`mutant: the ${name} extglob spelling of the four rule inputs is caught on the real repository`, async () => {
    const state = realState();
    const problems = inputProblems({ ...state, hashed: await withRuleInputs([glob]) });
    for (const rule of RULES) {
      assert.equal(startsWith(problems, `${rule} `).length, 1, `${rule}: ${fail(problems)}`);
    }
    assert.equal(problems.length, RULES.length, fail(problems));
  });
}

test('control: wildcard spellings turbo does hash are accepted, and an exclusion of one is not', async () => {
  const state = realState();
  for (const glob of ['$TURBO_ROOT$/scripts/*-rule.mjs', '$TURBO_ROOT$/scripts/**/*-rule.mjs']) {
    const problems = inputProblems({ ...state, hashed: await withRuleInputs([glob]) });
    assert.deepEqual(problems, [], glob);
  }
  const problems = inputProblems({
    ...state,
    hashed: await withRuleInputs([
      '$TURBO_ROOT$/scripts/*-rule.mjs',
      '!$TURBO_ROOT$/scripts/no-zod-*',
    ]),
  });
  assert.equal(problems.length, 1, fail(problems));
  assert.ok(problems[0].startsWith('scripts/no-zod-default-rule.mjs '), problems[0]);
});

// Real-repository mutants of the grammar: a loader appended to a real rule, a
// lint command changed in a real package.json. Each was a zero-problem escape.
test('mutant: an unsupported loader appended to a real rule is rejected', () => {
  const state = realState();
  for (const [name, code] of Object.entries(LOADERS)) {
    const problems = discover(
      withText(state, {
        'scripts/no-zod-default-rule.mjs': (text) =>
          `${text}\n${code.replace('./x', './no-zod-default-rule.mjs')}\n`,
      }),
    ).problems;
    assert.ok(problems.length >= 1, `${name}: not rejected`);
  }
});

test('mutant: a lint command other than plain `eslint <paths>` in a real package.json is rejected', () => {
  const state = realState();
  const file = 'apps/web/package.json';
  const pkg = JSON.parse(state.read(file));
  for (const command of COMMANDS) {
    const text = JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, lint: command } });
    const problems = discover(withText(state, { [file]: () => text })).problems;
    assert.ok(
      problems.some((p) => p.startsWith(`${file} `)),
      `${command}: ${fail(problems)}`,
    );
  }
});

test('mutant: a workspace alias or linked dependency imported from a real config is rejected', () => {
  const state = realState();
  const file = 'apps/web/package.json';
  const pkg = JSON.parse(state.read(file));
  for (const spec of [
    'workspace:@rasta/contracts@*',
    'link:../../packages/contracts',
    'file:../../packages/contracts',
  ]) {
    const text = JSON.stringify({
      ...pkg,
      dependencies: { ...pkg.dependencies, 'plugin-alias': spec },
    });
    const problems = discover(
      withText(state, {
        [file]: () => text,
        'apps/web/eslint.config.mjs': (config) => `import alias from 'plugin-alias';\n${config}`,
      }),
    ).problems;
    assert.ok(
      problems.some((p) => p.includes("'plugin-alias'")),
      `${spec}: ${fail(problems)}`,
    );
  }
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

test('mutant: a new rule, sibling suite or stale entry is caught', () => {
  const state = realState();
  const names = [
    ...state.names,
    'brand-new-rule.mjs',
    'brand-new-rule.test.mjs',
    'brand-new-extra.test.mjs',
  ];
  const registered = [...state.registered, 'scripts/ghost.test.mjs', 'scripts/ghost.test.mjs'];
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

// ---------------------------------------------------------------------------
// Fixtures: a small repository (a real git repository for turbo), then the ways a
// lint dependency escaped.
// ---------------------------------------------------------------------------

const turboJson = (inputs, extra = {}) => JSON.stringify({ ...extra, tasks: { lint: { inputs } } });
const BASE_INPUTS = [
  '$TURBO_DEFAULT$',
  '$TURBO_ROOT$/eslint.config.mjs',
  '$TURBO_ROOT$/scripts/a-rule.mjs',
  '$TURBO_ROOT$/scripts/helper-a.mjs',
  '$TURBO_ROOT$/scripts/helper-b.mjs',
];

const baseFiles = () => ({
  'package.json':
    '{"name":"root","private":true,"packageManager":"pnpm@9.0.0","scripts":{"lint":"turbo run lint"}}',
  'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n',
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n  apps/web: {}\n",
  'turbo.json': turboJson(BASE_INPUTS),
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
const ALL_SHARED = [
  'eslint.config.mjs',
  'scripts/a-rule.mjs',
  'scripts/helper-a.mjs',
  'scripts/helper-b.mjs',
];

test('fixture: the baseline repository has no problems', () => {
  assert.deepEqual(fixtureProblems(baseFiles()), []);
});

// The review's escape variants (each left every earlier guard test green), now
// judged by turbo's resolved inputs.
const ESCAPES = {
  'a tracked .cjs config loading a rule with require()': {
    files: {
      ...without(baseFiles(), WEB_CONFIG),
      'apps/web/eslint.config.cjs': "module.exports = require('../../scripts/c-rule.cjs');\n",
      'scripts/c-rule.cjs': 'module.exports = {};\n',
    },
    missing: ['scripts/c-rule.cjs'],
  },
  'a .js config using require() of a .js rule (the root package.json sets its type)': {
    files: {
      ...without(baseFiles(), WEB_CONFIG),
      'apps/web/eslint.config.js':
        "const rule = require('../../scripts/c-rule.js');\nmodule.exports = [rule];\n",
      'scripts/c-rule.js': 'module.exports = {};\n',
    },
    missing: ['scripts/c-rule.js', 'package.json'],
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
  'a .mts config loading a rule': {
    files: {
      ...without(baseFiles(), WEB_CONFIG),
      'apps/web/eslint.config.mts':
        "import rule from '../../scripts/c-rule.mts';\nexport default [rule];\n",
      'scripts/c-rule.mts': 'export default {};\n',
    },
    missing: ['scripts/c-rule.mts'],
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
    files: { ...baseFiles(), 'turbo.json': turboJson(BASE_INPUTS.slice(0, 4)) },
    missing: ['scripts/helper-b.mjs'],
  },
  'a root <pkg>#lint task whose inputs omit the shared rules': {
    files: {
      ...baseFiles(),
      'turbo.json': JSON.stringify({
        tasks: {
          lint: { inputs: BASE_INPUTS },
          '@rasta/web#lint': { inputs: ['$TURBO_DEFAULT$'] },
        },
      }),
    },
    missing: ALL_SHARED,
  },
  'a "!" exclusion of one rule next to its positive input': {
    files: {
      ...baseFiles(),
      'turbo.json': turboJson([...BASE_INPUTS, '!$TURBO_ROOT$/scripts/a-rule.mjs']),
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
    missing: ALL_SHARED,
  },
  // The review's extglob escapes: accepted by turbo, hashing nothing.
  'the @(…) extglob in place of the helper inputs': {
    files: {
      ...baseFiles(),
      'turbo.json': turboJson([
        '$TURBO_DEFAULT$',
        '$TURBO_ROOT$/eslint.config.mjs',
        '$TURBO_ROOT$/scripts/@(a-rule|helper-a|helper-b).mjs',
      ]),
    },
    missing: ['scripts/a-rule.mjs', 'scripts/helper-a.mjs', 'scripts/helper-b.mjs'],
  },
  'the +(…) extglob in place of the helper inputs': {
    files: {
      ...baseFiles(),
      'turbo.json': turboJson([
        '$TURBO_DEFAULT$',
        '$TURBO_ROOT$/eslint.config.mjs',
        '$TURBO_ROOT$/scripts/+(a-rule|helper-a|helper-b).mjs',
      ]),
    },
    missing: ['scripts/a-rule.mjs', 'scripts/helper-a.mjs', 'scripts/helper-b.mjs'],
  },
  'the !(…) extglob in place of the helper inputs': {
    files: {
      ...baseFiles(),
      'turbo.json': turboJson([
        '$TURBO_DEFAULT$',
        '$TURBO_ROOT$/eslint.config.mjs',
        '$TURBO_ROOT$/scripts/!(nothing).mjs',
      ]),
    },
    missing: ['scripts/a-rule.mjs', 'scripts/helper-a.mjs', 'scripts/helper-b.mjs'],
  },
  // A hidden path component: listed exactly, then excluded by a wildcard turbo applies to it.
  'an exact hidden-path input followed by a "!" wildcard that turbo applies to hidden paths': {
    files: {
      ...baseFiles(),
      'eslint.config.mjs':
        "import a from './scripts/a-rule.mjs';\nimport h from './.config/h.mjs';\nexport default [a, h];\n",
      '.config/h.mjs': 'export default {};\n',
      'turbo.json': turboJson([
        ...BASE_INPUTS,
        '$TURBO_ROOT$/.config/h.mjs',
        '!$TURBO_ROOT$/**/h.mjs',
      ]),
    },
    missing: ['.config/h.mjs'],
  },
};

for (const [name, { files, missing }] of Object.entries(ESCAPES)) {
  test(`escape: ${name} is caught`, () => {
    const problems = fixtureProblems(files);
    for (const file of missing) {
      assert.equal(startsWith(problems, `${file} `).length, 1, `${file}: ${fail(problems)}`);
    }
    assert.equal(problems.length, missing.length, fail(problems));
  });
}

test('fixture: a wildcard over a hidden path turbo does hash is accepted (no false rejection)', () => {
  const files = {
    ...baseFiles(),
    'eslint.config.mjs':
      "import a from './scripts/a-rule.mjs';\nimport h from './.config/h.mjs';\nexport default [a, h];\n",
    '.config/h.mjs': 'export default {};\n',
    'turbo.json': turboJson([...BASE_INPUTS, '$TURBO_ROOT$/**/h.mjs']),
  };
  assert.deepEqual(fixtureProblems(files), []);
});

test('fixture: $TURBO_EXTENDS$, cache:false and negation-only inputs resolve as turbo does', () => {
  const base = baseFiles();
  const web = (tasks) => ({ 'apps/web/turbo.json': JSON.stringify({ extends: ['//'], tasks }) });
  // Extending the parent keeps its coverage; adding an exclusion removes exactly that.
  assert.deepEqual(
    fixtureProblems({ ...base, ...web({ lint: { inputs: ['$TURBO_EXTENDS$', 'extra/**'] } }) }),
    [],
  );
  const negated = fixtureProblems({
    ...base,
    ...web({ lint: { inputs: ['$TURBO_EXTENDS$', '!$TURBO_ROOT$/scripts/helper-b.mjs'] } }),
  });
  assert.equal(negated.length, 1, fail(negated));
  assert.ok(negated[0].startsWith('scripts/helper-b.mjs '), negated[0]);
  // An uncached task has no stale green to replay.
  assert.deepEqual(
    fixtureProblems({
      ...base,
      'turbo.json': JSON.stringify({
        tasks: { lint: { cache: false, inputs: ['$TURBO_DEFAULT$'] } },
      }),
    }),
    [],
  );
  // Only negations: turbo drops the default, so the package's own config is no longer hashed.
  const onlyNegations = fixtureProblems({ ...base, 'turbo.json': turboJson(['!nothing/**']) });
  assert.equal(startsWith(onlyNegations, `${WEB_CONFIG} `).length, 1, fail(onlyNegations));
  // globalDependencies are hashed into every task.
  assert.deepEqual(
    fixtureProblems({
      ...base,
      'turbo.json': turboJson(
        ['$TURBO_DEFAULT$', '$TURBO_ROOT$/eslint.config.mjs', '$TURBO_ROOT$/scripts/a-rule.mjs'],
        { globalDependencies: ['scripts/helper-a.mjs', 'scripts/helper-b.mjs'] },
      ),
    }),
    [],
  );
});

test('fixture: a workspace that lints but has no lint task is a problem; no lint task at all stops turbo', () => {
  const files = {
    ...baseFiles(),
    'pnpm-lock.yaml':
      "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n  apps/web: {}\n  apps/other: {}\n",
    'apps/other/package.json': '{"name":"@rasta/other","scripts":{"lint":"eslint src"}}',
    'turbo.json': JSON.stringify({ tasks: { '@rasta/other#lint': { inputs: BASE_INPUTS } } }),
  };
  const problems = fixtureProblems(files);
  assert.equal(problems.length, 1, fail(problems));
  assert.ok(problems[0].startsWith('@rasta/web has a lint script but'), problems[0]);
  // With no lint task anywhere turbo refuses to run: the guard throws instead of passing.
  assert.throws(
    () =>
      fixtureProblems({ ...baseFiles(), 'turbo.json': JSON.stringify({ tasks: { build: {} } }) }),
    /failed/,
  );
});

// ---------------------------------------------------------------------------
// Fixtures: the supported grammar and everything outside it.
// ---------------------------------------------------------------------------

// Each is a loader the review (or the sweep) showed escaping; `./x` is replaced by a real target.
export const LOADERS = {
  "module['require']()": "module['require']('./x');",
  'module.require.call': "module.require.call(module, './x');",
  'module.require.apply': "module.require.apply(module, ['./x']);",
  'module.require.bind': "module.require.bind(module)('./x');",
  'module.require()': "module.require('./x');",
  'require.call': "require.call(null, './x');",
  'require.apply': "require.apply(null, ['./x']);",
  'require.bind': "require.bind(null)('./x');",
  'Module.createRequire (namespace import)':
    "import * as M from 'node:module';\nM.default.createRequire(import.meta.url)('./x');",
  'Module.createRequire (default import)':
    "import Module from 'node:module';\nModule.createRequire(import.meta.url)('./x');",
  'a named createRequire import':
    "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('./x');",
  'Module._load': "import Module from 'module';\nModule._load('./x');",
  'process.getBuiltinModule':
    "const M = process.getBuiltinModule('node:module');\nM.createRequire(import.meta.url)('./x');",
  'process.mainModule.require': "process.mainModule.require('./x');",
  'Function()': 'new Function(\'return require("./x")\')();',
  'a Function reached through .constructor': "(() => {}).constructor('return 1')();",
  'globalThis.Function': "globalThis['Function']('return 1')();",
  eval: "eval('1');",
  'an indirect eval': "(0, eval)('1');",
  'an fs read of configuration data':
    "import { readFileSync } from 'node:fs';\nreadFileSync('./x.json', 'utf8');",
  'an fs/promises read': "import { readFile } from 'node:fs/promises';\nawait readFile('./x');",
  'a child_process': "import { execSync } from 'node:child_process';\nexecSync('cat x');",
  'a vm script': "import vm from 'node:vm';\nvm.runInThisContext('1');",
  'a non-literal require()': "const n = './x';\nrequire(n);",
  'a non-literal import()': "const n = './x.mjs';\nawait import(n);",
  'an import() of a template with a substitution': 'const n = "x";\nawait import(`./${n}.mjs`);',
  'an aliased require': "const load = require;\nload('./x');",
  'a non-literal import.meta.resolve': 'import.meta.resolve(process.env.X);',
  'a literal import.meta.resolve': "import.meta.resolve('./x');",
  'a computed member of process': "process['getBuiltinModule']('node:module');",
  'a #alias import': "import x from '#rules/x';",
  'an absolute path': "import x from '/etc/x.mjs';",
  'a data: URL': "await import('data:text/javascript,export default 1');",
  'a require() of a .json': "require('./x.json');",
  'a require() of an unknown suffix (.data)': "require('./x.data');",
  'a require() of an extensionless file': "require('./noext');",
  'a require() of a directory (index.js)': "require('./plugin');",
  'a require() of a directory with package.json main': "require('./pkgdir');",
  'a require() of ./helper (helper.json before helper/index.js)': "require('./helper');",
  'a static import of an extensionless path': "import x from './helper-b';",
  'an unresolvable relative import': "import x from './missing.mjs';",
  'a relative import with a query': "import x from './helper-b.mjs?v=1';",
  'a relative import escaping the repository': "import x from '../../../outside.mjs';",
};
const EXTRA_FILES = {
  'scripts/noext': 'module.exports = {};\n',
  'scripts/x.data': 'module.exports = {};\n',
  'scripts/x.json': '{}',
  'scripts/plugin/index.js': 'module.exports = {};\n',
  'scripts/pkgdir/package.json': '{"main":"./real.js"}',
  'scripts/pkgdir/real.js': 'module.exports = {};\n',
  'scripts/pkgdir/index.js': 'module.exports = {};\n',
  'scripts/helper.json': '{}',
  'scripts/helper/index.js': 'module.exports = {};\n',
};

// The review's command forms and the other ways a lint command stops being plain.
export const COMMANDS = [
  'eslint -c../../tools/alternate.mjs src',
  'eslint -c ../../tools/alternate.mjs src',
  'eslint --config ../../tools/alternate.mjs src',
  'eslint --config=../../tools/alternate.mjs src',
  'eslint --resolve-plugins-relative-to ../../tools src',
  'cd ../../apps/web && eslint src',
  'cd ../.. && eslint apps/web/src',
  'eslint src && node other.mjs',
  'eslint src; node other.mjs',
  'eslint src | cat',
  'eslint src || true',
  'ESLINT_USE_FLAT_CONFIG=false eslint src',
  'npx eslint src',
  'eslint',
  'eslint --fix src',
  'eslint src $(echo x)',
  'tsc --noEmit',
];

for (const [name, code] of Object.entries(LOADERS)) {
  for (const holder of ['config', 'rule', 'helper']) {
    test(`fail closed: ${name} in a ${holder} is an error`, () => {
      const files = { ...baseFiles(), ...EXTRA_FILES };
      const text = `${code.replace('./x', './helper-b.mjs')}\n`;
      // `./x` stands for a real target; the noext/.data/dir cases keep their own path.
      const body = /\.\/(noext|plugin|pkgdir|helper'|x\.)/.test(code) ? `${code}\n` : text;
      if (holder === 'config') files[WEB_CONFIG] = body;
      else if (holder === 'rule') files['scripts/a-rule.mjs'] = body;
      else files['scripts/helper-b.mjs'] = body;
      const problems = discover(memoryState(files)).problems;
      assert.ok(problems.length >= 1, `${name}: not rejected`);
      assert.ok(
        problems.some((p) => /outside the supported grammar|cannot be read/.test(p)),
        fail(problems),
      );
    });
  }
}

for (const command of COMMANDS) {
  test(`fail closed: the lint command \`${command}\` is an error`, () => {
    const files = {
      ...baseFiles(),
      'apps/web/package.json': JSON.stringify({ name: '@rasta/web', scripts: { lint: command } }),
    };
    const problems = discover(memoryState(files)).problems;
    assert.ok(
      problems.some((p) => p.startsWith('apps/web/package.json ')),
      fail(problems),
    );
  });
}

test('fail closed: prelint and postlint hooks are an error', () => {
  for (const hook of ['prelint', 'postlint']) {
    const files = {
      ...baseFiles(),
      'apps/web/package.json': JSON.stringify({
        name: '@rasta/web',
        scripts: { lint: 'eslint src', [hook]: 'node tweak.mjs' },
      }),
    };
    assert.ok(discover(memoryState(files)).problems.some((p) => p.includes(hook)));
  }
});

// A dependency that is workspace code under another name.
const LOCAL_SPECS = {
  'a workspace: alias of a workspace package': 'workspace:@rasta/local-plugin@*',
  'a workspace:* dependency by its own name': 'workspace:*',
  'a link: dependency': 'link:../../tools/local-plugin',
  'a file: dependency': 'file:../../tools/local-plugin',
  'a portal: dependency': 'portal:../../tools/local-plugin',
  'an npm: alias of a workspace package': 'npm:@rasta/local-plugin@*',
};
for (const [name, spec] of Object.entries(LOCAL_SPECS)) {
  test(`fail closed: ${name} imported from a config is an error`, () => {
    const files = {
      ...baseFiles(),
      'tools/local-plugin/package.json': '{"name":"@rasta/local-plugin"}',
      'apps/web/package.json': JSON.stringify({
        name: '@rasta/web',
        scripts: { lint: 'eslint src' },
        dependencies: { 'plugin-alias': spec },
      }),
      [WEB_CONFIG]: "import plugin from 'plugin-alias';\nexport default [plugin];\n",
    };
    const problems = discover(memoryState(files)).problems;
    assert.ok(
      problems.some((p) => p.includes("'plugin-alias'") && /workspace/.test(p)),
      fail(problems),
    );
  });
}

test('fail closed: a workspace alias declared in pnpm-workspace.yaml or an override is an error', () => {
  for (const [path, text] of [
    [
      'pnpm-workspace.yaml',
      'packages:\n  - "apps/*"\noverrides:\n  plugin-alias: "link:./tools/local-plugin"\n',
    ],
    [
      'package.json',
      '{"name":"root","pnpm":{"overrides":{"plugin-alias":"workspace:*"}},"scripts":{"lint":"turbo run lint"}}',
    ],
  ]) {
    const files = {
      ...baseFiles(),
      [path]: text,
      [WEB_CONFIG]: "import plugin from 'plugin-alias';\nexport default [plugin];\n",
    };
    assert.ok(
      discover(memoryState(files)).problems.some((p) => p.includes("'plugin-alias'")),
      path,
    );
  }
});

test('fixture: every supported loading form is followed and none is an error', () => {
  const files = {
    ...baseFiles(),
    [WEB_CONFIG]:
      "import a from './helper.mjs';\nexport { b } from './helper.mjs';\nimport 'eslint-plugin-foo';\nimport { join } from 'node:path';\nconst c = await import('./dyn.mjs');\nexport default [a, c, join];\n",
    'apps/web/helper.mjs': 'export default {};\nexport const b = 1;\n',
    'apps/web/dyn.mjs': 'export default {};\n',
    'apps/web/eslint.config.cjs':
      "module.exports = [require('./legacy.cjs'), require('eslint-plugin-foo')];\nexports.x = 1;\n",
    'apps/web/legacy.cjs': 'module.exports = {};\n',
  };
  const found = discover(memoryState(files));
  assert.deepEqual(found.problems, []);
  const loaded = [...found.workspaces[0].files.keys()];
  for (const f of ['apps/web/helper.mjs', 'apps/web/dyn.mjs', 'apps/web/legacy.cjs']) {
    assert.ok(loaded.includes(f), `${f} not followed: ${loaded.join(', ')}`);
  }
});

test('fixture: a .ts module loads with `import x = require()`; a .js module needs its package.json hashed', () => {
  const files = {
    ...baseFiles(),
    'apps/web/eslint.config.mts':
      "import r = require('./r.ts');\nimport rule from './rule.js';\nexport default [r, rule];\n",
    'apps/web/r.ts': 'export = {};\n',
    'apps/web/rule.js': 'export default {};\n',
  };
  delete files[WEB_CONFIG];
  const found = discover(memoryState(files));
  assert.deepEqual(found.problems, []);
  const loaded = found.workspaces[0].files;
  assert.ok(loaded.has('apps/web/r.ts') && loaded.has('apps/web/rule.js'));
  assert.ok(
    loaded.has('apps/web/package.json'),
    'the nearest package.json (module type) is a dependency',
  );
});

test('fixture: forms that are not loads are not mistaken for them', () => {
  const files = baseFiles();
  files['scripts/helper-b.mjs'] =
    '// require(computed) and import(x) in a comment, createRequire too\n' +
    "export const y = 'require(n) eval import(m) module.require';\n" +
    'export const o = { require: 1, module: 2, eval: 3, createRequire: 4 };\n' +
    "export const g = { globals: { module: 'writable', require: 'readonly' } };\n" +
    'export const same = o.module === 2;\n' +
    'export const meta = import.meta.url;\n' +
    "export const name = 'x'.localeCompare('y');\n";
  const found = discover(memoryState(files));
  assert.deepEqual(found.problems, []);
});

test('fixture: an import cycle terminates and every member is covered', () => {
  const files = baseFiles();
  files['scripts/helper-b.mjs'] = "import { x } from './helper-a.mjs';\nexport const y = x;\n";
  files['scripts/a-rule.mjs'] = "import { x } from './helper-a.mjs';\nexport default x;\n";
  assert.deepEqual(fixtureProblems(files), []);
  files['turbo.json'] = turboJson(BASE_INPUTS.filter((i) => !i.endsWith('helper-b.mjs')));
  const problems = fixtureProblems(files);
  assert.equal(problems.length, 1, fail(problems));
  assert.ok(problems[0].startsWith('scripts/helper-b.mjs '), problems[0]);
});

test('fixture: a legacy eslintrc and an unused config are errors', () => {
  const base = baseFiles();
  assert.ok(
    discover(memoryState({ ...base, 'apps/web/.eslintrc.json': '{}' })).problems.some((p) =>
      p.includes('legacy'),
    ),
  );
  assert.ok(
    discover(
      memoryState({ ...base, 'tools/eslint.config.mjs': 'export default [];\n' }),
    ).problems.some((p) => p.includes('no workspace lint task uses')),
  );
});

// ---------------------------------------------------------------------------
// The JSONC reader (used to mutate the real turbo.json).
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
