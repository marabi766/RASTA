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
import { parse as parseYaml } from 'yaml';

/**
 * Nothing that guards the lint rules may fall out of CI unnoticed.
 *
 * Two lists are kept by hand and each fails silently when a file is missing
 * from it:
 *
 *  1. root `package.json` `lint:scripts` — `eslint … && node --test <files>
 *     [&& node --test <files>]`, explicit lists (main runs two `node --test`
 *     commands). A rule test that is not in ANY of them is never run: `pnpm lint`
 *     stays green and the rule it was written to hold can be disabled with no test
 *     failing. The script is read as a chain; a shape the guard does not model
 *     (`;`, `||`, `|`, a background `&`, an option after `--test`, a glob, another
 *     program) throws instead of registering a file that might not run.
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
 *  - DISCOVERY is a supported GRAMMAR for MODULE LOADING, failing closed. In an
 *    eslint config and every module it loads, the only loading forms are a
 *    static `import`, `export … from`, a literal `import()` or a literal
 *    `require()` of (a) a relative path to an existing tracked file with an
 *    explicit JS/TS extension and no `% ? # \` or whitespace/control character
 *    (so the specifier is a file name, not a URL), or (b) a bare package that is
 *    not a workspace package, a workspace alias or a `link:`/`file:`/`portal:`
 *    dependency (or a node built-in from a short allow-list: path, url, util,
 *    assert). `fs`, `child_process`, `os` and the rest are NOT on it. A module that
 *    must use one has an EXACT-PATH entry in BUILTIN_READERS (one per module: the
 *    members it uses, the names an importer may take, and each thing it reads); the
 *    guard checks the members and that every file it reads is a hashed turbo input
 *    of the lint task (decision D-101). Any other use of
 *    require/module/Module/createRequire/_load/Function/eval, a filesystem read
 *    through the names and members listed in BANNED_*, `.call/.apply/.bind`, a
 *    directory or extensionless or `.json` path is a problem with a message.
 *    A lint script must be ONE command, `eslint <paths>`: no newline, CR,
 *    `; & | \` $ ( ) < >` or backslash, no glob character, and each path is `.`,
 *    starts with `./`, or starts with a letter, digit, `_` or `@` (so no path is
 *    or can expand to an option).
 *    pnpm-workspace.yaml is parsed with the `yaml` package and package.json
 *    structurally; an override selector is read with pnpm's own grammar
 *    (`[parent>]name[@range]`, `parseOverrideSelector`) and one that cannot be
 *    read to exactly one package name, over a local source, is a problem.
 *
 *  WHAT THIS GUARD DOES NOT CLAIM (decision D-094, 2026-11-01). It protects the lint
 *  cache against ACCIDENTAL drift; deliberately obfuscated code is caught by PR
 *  review (same trust model as D-086/D-088). The grammar governs how MODULES ARE
 *  LOADED; it is NOT a capability sandbox. Documented residual, not detected:
 *   - Reading files or reaching capabilities from inside rule/config/helper code
 *     by routes the BANNED_* lists do not name, e.g. `const { getBuiltinModule: b }
 *     = process; b('fs').readFileSync(new URL('../rules.json', import.meta.url))`,
 *     `Reflect.get`, `Object.getOwnPropertyDescriptor`, an aliased `process` with
 *     computed access, a destructured/computed `constructor` evaluator,
 *     `process.loadEnvFile`, or an allowed `typescript` import followed by
 *     `ts.sys.readFile`. A data file so read is not a hashed input.
 *   - pnpm dependency specs the structural walk does not classify: unprefixed
 *     relative paths outside a dependency/override map, and any other exotic
 *     spelling of a local source.
 *   - Anything else a reviewer would recognise as deliberate evasion.
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

/**
 * The `.test.mjs` files `lint:scripts` passes to `node --test`, as written, over EVERY
 * `node --test` command of the script (main runs two, joined by `&&`; PR #503).
 *
 * The script is read as a chain: `<command> && <command> …` where a command is
 * `eslint <args>` or `node --test <scripts/NAME.test.mjs>…`, and nothing else. Anything
 * the guard does not model THROWS (a registered file might then not run, or run with
 * a filter): a newline, `; | & ` $ ( ) < > \ * ? [ ] { } # ' " !`, a lone `&` (a
 * background job), `||`, an empty segment, an environment prefix, any other program,
 * an option after `--test` (`--test-name-pattern`, `--test-skip-pattern`, `--test-only`
 * … would register a file whose tests do not run), or a path that is not a plain
 * `scripts/<name>.test.mjs`.
 */
export const registeredTests = (lintScripts) => {
  const refuse = (why) => {
    throw new assert.AssertionError({
      message:
        `package.json \`lint:scripts\` is ${JSON.stringify(lintScripts)}: ${why}. The registration guard only ` +
        'reads `eslint <args> && node --test scripts/<name>.test.mjs … [&& node --test …]`, because a test ' +
        'file in any other shape may never run (or run filtered) while `pnpm lint` stays green.',
    });
  };
  // `&&` is the only separator: with every `&&` removed, any `&` left is a background job.
  const control = /[\n\r;|`$()<>\\*?[\]{}#'"!&]/.exec(lintScripts.replaceAll('&&', ' '));
  if (control !== null) refuse(`it contains ${JSON.stringify(control[0])}`);
  const files = [];
  let nodeTests = 0;
  for (const segment of lintScripts.split('&&')) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) refuse('it has an empty command around `&&`');
    if (tokens[0] === 'eslint') continue;
    if (tokens[0] !== 'node' || tokens[1] !== '--test') {
      refuse(
        `the command ${JSON.stringify(segment.trim())} is neither \`eslint …\` nor \`node --test …\``,
      );
    }
    nodeTests += 1;
    if (tokens.length < 3) refuse('a `node --test` command lists no file');
    for (const token of tokens.slice(2)) {
      if (!/^scripts\/[A-Za-z0-9_.-]+\.test\.mjs$/.test(token)) {
        refuse(
          `\`node --test\` is given ${JSON.stringify(token)}, which is not a plain scripts/<name>.test.mjs ` +
            'file (an option or a pattern can make a registered test not run)',
        );
      }
      files.push(token);
    }
  }
  if (nodeTests === 0) refuse('it no longer runs `node --test <files>`');
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

/** A relative specifier is a file name only when none of these URL-meaningful characters is in it. */
const nonCanonical = (specifier) =>
  /[%?#\\\s]/.test(specifier) ||
  [...specifier].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
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

/**
 * Exact-path exceptions to the built-in rule (decision D-101, 2026-11-01; main's #503).
 *
 * A module the eslint config loads may import `fs`, `child_process`, `os` (or any other
 * built-in outside ALLOWED_BUILTINS) ONLY if its repository path is a key here. There is
 * no pattern and no directory entry: a new module that does so fails until it is listed,
 * with its read surface, in a reviewed change to this table.
 *
 * Each entry is checked, not trusted:
 *  - `builtins`: built-in → the exact members the module uses (static import, `local.member`
 *    access only). A member used and not listed, listed and no longer used, a built-in listed
 *    and not imported, or a load the guard cannot list (`require`, `import()`, re-export,
 *    destructuring, the namespace passed as a value) fails.
 *  - `exports` (optional): the only names a lint-time importer may take from the module.
 *    Its other exports (an image check that spawns docker, say) are then unreachable from
 *    the eslint config, so they are not part of what the rule reads.
 *  - `reads`: what the module reads, as surfaces of the closed vocabulary below. For every
 *    lint workspace that loads the module, every file of every surface must be in the hashed
 *    inputs turbo resolves for that workspace's lint task (`turbo run lint --dry=json`), or
 *    the guard fails naming the module, the surface and the files. The surfaces:
 *      linted-files        every tracked file under the workspace directory (what eslint lints,
 *                          and what the module reads or resolves a path of while linting it)
 *      workspace-manifest  the workspace's package.json
 *      typescript-project  the workspace's tsconfig.test.json, else tsconfig.json (the parser picks the
 *                          first that exists), their `extends`
 *                          chain, and every file or directory their `files`, `include`,
 *                          `references`, `baseUrl`, `rootDirs`, `typeRoots` and `paths` name
 *      dependency-builds   the built output of the workspace's dependencies (type declarations),
 *                          hashed because the lint task `dependsOn` `^build`
 *      location-only      resolves a path (a realpath, the running script) and reads no content
 *    An entry with no surface, or a surface outside this list, fails.
 *
 * Residual (D-094): a module may still read an UNDECLARED path through a declared member
 * (`readFileSync('../rules.json')`); the table names the intended reads and the guard checks
 * them, review catches the rest. The member and `exports` checks are what keep that surface small.
 */
export const BUILTIN_READERS = new Map([
  [
    'scripts/internal-token-parser.mjs',
    {
      why:
        'the typed-or-untyped parser decides, per linted file, whether a TypeScript project covers it, ' +
        'so it looks for the workspace manifest and tsconfig and compares the file on disk with the text eslint passes',
      builtins: { fs: ['existsSync', 'readFileSync'] },
      reads: [
        {
          surface: 'linted-files',
          why: '`fs.existsSync(options.filePath)` and `fs.readFileSync(options.filePath)`: the linted file on disk',
        },
        {
          surface: 'workspace-manifest',
          why: '`fs.existsSync(<dir>/package.json)` walking up from the linted file to its workspace',
        },
        {
          surface: 'typescript-project',
          why: '`fs.existsSync(<dir>/tsconfig.test.json | tsconfig.json)` selects the project the wrapped parser then reads',
        },
        {
          surface: 'dependency-builds',
          why: 'the program it builds resolves @rasta/* imports to dependency build output (.d.ts)',
        },
      ],
    },
  ],
  [
    'scripts/internal-token-source-rule.mjs',
    {
      why:
        'the rule keys its allowances on a file’s canonical repository path, so it resolves symlinks ' +
        'of the linted file and of the checkout root; it reads no file content',
      builtins: { fs: ['realpathSync'] },
      reads: [
        { surface: 'linted-files', why: '`fs.realpathSync(file)`: the linted file’s real path' },
        {
          surface: 'location-only',
          why: '`fs.realpathSync(REPO_ROOT)`: the checkout directory, resolved and not read',
        },
      ],
    },
  ],
  [
    'scripts/testing-dev-only.mjs',
    {
      why:
        'a CLI and library for the test-signer boundary (pnpm graph, image and build-output checks); the lint rule ' +
        'imports it only for REPO_ROOT. Its fs, child_process and os calls run from the CLI and from ' +
        'testing-dev-only.test.mjs, never while eslint loads it',
      builtins: {
        child_process: ['spawnSync'],
        fs: [
          'existsSync',
          'lstatSync',
          'mkdtempSync',
          'readdirSync',
          'readFileSync',
          'realpathSync',
          'rmSync',
        ],
        os: ['tmpdir'],
      },
      exports: ['REPO_ROOT'],
      reads: [
        {
          surface: 'location-only',
          why:
            'on import its only call is `fs.realpathSync(process.argv[1])` (am I the script being run?), the ' +
            'path of the running program, not a repository input; REPO_ROOT is computed from import.meta.url',
        },
      ],
    },
  ],
]);

const READ_SURFACES = new Set([
  'linted-files',
  'workspace-manifest',
  'typescript-project',
  'dependency-builds',
  'location-only',
]);
const own = (object, key) =>
  object !== null && typeof object === 'object' && Object.hasOwn(object, key)
    ? object[key]
    : undefined;
const nonEmpty = (text) => typeof text === 'string' && text.trim() !== '';

/** The table itself must be exact: literal paths, listed members, a known surface, a reason. */
export const exceptionTableProblems = (exceptions) => {
  const problems = [];
  for (const [path, entry] of exceptions) {
    const bad = (what) => problems.push(`BUILTIN_READERS[${JSON.stringify(path)}] ${what}.`);
    if (
      !/^[A-Za-z0-9_@.+-]+(?:\/[A-Za-z0-9_@.+-]+)*\.[cm]?[jt]s$/.test(path) ||
      /(^|\/)\.\.?(\/|$)/.test(path)
    ) {
      bad('is not an exact repository path to a JS/TS file (no glob, directory or `..`)');
    }
    if (entry === null || typeof entry !== 'object') {
      bad('is not an entry');
      continue;
    }
    if (!nonEmpty(entry.why)) bad('has no `why`');
    const builtins = Object.entries(entry.builtins ?? {});
    if (builtins.length === 0) bad('lists no built-in');
    for (const [module, members] of builtins) {
      if (ALLOWED_BUILTINS.has(module) || !isBuiltin(module)) {
        bad(`lists \`${module}\`, which is not a built-in outside ALLOWED_BUILTINS`);
      }
      if (!Array.isArray(members) || members.length === 0 || !members.every(nonEmpty)) {
        bad(`lists no members of \`${module}\``);
      }
    }
    if (
      entry.exports !== undefined &&
      !(Array.isArray(entry.exports) && entry.exports.every(nonEmpty))
    ) {
      bad('has an `exports` that is not a list of names');
    }
    if (!Array.isArray(entry.reads) || entry.reads.length === 0) bad('declares no `reads`');
    for (const read of Array.isArray(entry.reads) ? entry.reads : []) {
      if (!READ_SURFACES.has(read?.surface)) {
        bad(`declares the unknown read surface ${JSON.stringify(read?.surface)}`);
      } else if (!nonEmpty(read.why))
        bad(`declares the surface \`${read.surface}\` without saying why`);
    }
  }
  return problems;
};

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
  /** specifier → the names taken from it (`'*'`: a namespace, default or non-static load). */
  const importNames = new Map();
  /** built-in (without `node:`) → the members used by name; `opaque` when they cannot be listed. */
  const builtinUse = new Map();
  /** local name → built-in, for `import fs from 'node:fs'` and `import * as fs from 'node:fs'`. */
  const namespaceLocals = new Map();
  const builtinOf = (specifier) =>
    specifier.startsWith('node:') || isBuiltin(specifier) ? specifier.replace(/^node:/, '') : null;
  const usage = (builtin) => {
    if (!builtinUse.has(builtin)) builtinUse.set(builtin, { members: new Set(), opaque: false });
    return builtinUse.get(builtin);
  };
  /** A load whose names are not a static member list (`require`, `import()`, `export *`, …). */
  const loadsEverything = (specifier) => {
    importNames.set(specifier, '*');
    const builtin = builtinOf(specifier);
    if (builtin !== null) usage(builtin).opaque = true;
  };
  const loadsNames = (specifier, names) => {
    if (importNames.get(specifier) !== '*') {
      importNames.set(specifier, new Set([...(importNames.get(specifier) ?? []), ...names]));
    }
    const builtin = builtinOf(specifier);
    if (builtin !== null) for (const name of names) usage(builtin).members.add(name);
  };
  const at = (node) => `${path}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  const bad = (node, what) => errors.push(`${at(node)} ${what} ${GRAMMAR}.`);
  const literalArg = (call, form) => {
    const [first] = call.arguments;
    if (isLiteral(first)) {
      specifiers.add(first.text);
      loadsEverything(first.text);
    } else bad(call, `${form} with a non-literal specifier`);
  };
  // Static imports first: a built-in imported as a namespace or default is read through
  // `local.member`, and an import may follow its first use.
  for (const statement of sf.statements) {
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
    if (clause === undefined || !isLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const names = [];
    if (clause.name !== undefined) {
      names.push('default');
      if (builtinOf(specifier) !== null) namespaceLocals.set(clause.name.text, specifier);
    }
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      names.push('*');
      if (builtinOf(specifier) !== null) namespaceLocals.set(bindings.name.text, specifier);
    } else if (bindings !== undefined) {
      for (const element of bindings.elements) {
        names.push((element.propertyName ?? element.name).text);
      }
    }
    if (names.includes('*') || names.includes('default')) {
      // a default/namespace import takes everything the importer might use
      const named = names.filter((n) => n !== '*' && n !== 'default');
      importNames.set(specifier, '*');
      const builtin = builtinOf(specifier);
      if (builtin !== null) for (const name of named) usage(builtin).members.add(name);
    } else {
      loadsNames(specifier, names);
    }
  }

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) {
        if (isLiteral(node.moduleSpecifier)) {
          specifiers.add(node.moduleSpecifier.text);
          if (ts.isExportDeclaration(node)) {
            const clause = node.exportClause;
            if (clause !== undefined && ts.isNamedExports(clause)) {
              loadsNames(
                node.moduleSpecifier.text,
                clause.elements.map((element) => (element.propertyName ?? element.name).text),
              );
            } else loadsEverything(node.moduleSpecifier.text);
          }
        } else bad(node, 'a module specifier that is not a literal');
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        const { expression } = node.moduleReference;
        if (isLiteral(expression)) {
          specifiers.add(expression.text);
          loadsEverything(expression.text);
        } else bad(node, '`import x = require(…)` with a non-literal specifier');
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
    } else if (ts.isIdentifier(node) && namespaceLocals.has(node.text)) {
      const { parent } = node;
      const builtin = builtinOf(namespaceLocals.get(node.text));
      if (ts.isImportClause(parent) || ts.isNamespaceImport(parent)) {
        // the binding itself
      } else if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        usage(builtin).members.add(parent.name.text);
      } else if (
        ts.isElementAccessExpression(parent) &&
        parent.expression === node &&
        isLiteral(parent.argumentExpression)
      ) {
        usage(builtin).members.add(parent.argumentExpression.text);
      } else if (
        !(ts.isPropertyAccessExpression(parent) && parent.name === node) &&
        !(KEY_KINDS.has(parent.kind) && parent.name === node)
      ) {
        usage(builtin).opaque = true; // passed as a value, destructured, shadowed: members unknown
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
  return { specifiers, errors, builtinUse, importNames };
};

/**
 * pnpm's own selector grammar (`config/parse-overrides` and `resolving/parse-wanted-dependency`
 * in the bundled pnpm 11.22.0, which is not an importable dependency, so this mirrors it):
 *
 *   selector := [ parent '>' ] name [ '@' range ]
 *
 * The parent/child separator is the FIRST `>` whose previous character is not a space,
 * `|` or `@` (so the `>` of `plugin@>=1` and of `plugin@^1 || >=2` is part of the range).
 * Each side is cut at its first `@` after position 0 (a scope's `@` is position 0); the
 * range is never parsed, only cut off, so it may hold any character, newlines included.
 * A name is a valid (old-style) npm package name: `name` or `@scope/name`, each part
 * unchanged by `encodeURIComponent` and not starting with `.` or `_`.
 *
 * Returns the package the override applies to, or undefined when the selector does not
 * name exactly one package (pnpm itself rejects those with INVALID_SELECTOR). A caller
 * that sees a local source under such a key must fail closed.
 */
const SELECTOR_SEPARATOR = /[^ |@]>/;
const selectorPackage = (side) => {
  const at = side.indexOf('@', 1);
  const name = at === -1 ? side : side.slice(0, at);
  const m = /^(?:@([^/]+)\/)?([^/]+)$/.exec(name);
  if (m === null) return undefined;
  const parts = m[1] === undefined ? [m[2]] : [m[1], m[2]];
  const ok = parts.every((part) => part === encodeURIComponent(part) && !/^[._]/.test(part));
  return ok ? name : undefined;
};
export const parseOverrideSelector = (key) => {
  if (typeof key !== 'string') return undefined;
  const separator = SELECTOR_SEPARATOR.exec(key);
  if (separator === null) return selectorPackage(key);
  const parent = key.slice(0, separator.index + 1);
  const child = key.slice(separator.index + 2);
  return selectorPackage(parent) === undefined ? undefined : selectorPackage(child);
};

/** A dependency spec that points at code on disk or in the workspace, whatever the key. */
const LOCAL_PREFIX = /^(?:workspace|link|file|portal):/;
/** An unprefixed path spec; only read as one inside a map of dependencies or overrides. */
const LOCAL_PATH = /^(?:\.{1,2}(?:[/\\]|$)|[/\\]|~[/\\])/;
/** Maps whose values are dependency specs (a key is a package, a value a spec). */
const SPEC_MAPS = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'overrides',
  'resolutions',
]);

/**
 * Package names and aliases that resolve to code in this repository (or on disk):
 * every package.json `name`, every dependency key whose spec is `workspace:`,
 * `link:`, `file:` or `portal:` (a `workspace:name@*` spec also names its target),
 * an `npm:` alias of a workspace package, and the same in pnpm-workspace.yaml.
 */
export const localPackageNames = (tracked, read, problems) => {
  const names = new Set();
  const aliases = [];
  const unnamed = (file, rawKey, value) =>
    `${file} maps the selector ${JSON.stringify(rawKey)} to the local source ${JSON.stringify(value)}, but the ` +
    'selector does not name exactly one package (pnpm reads `[parent>]name[@range]`), so the guard cannot tell ' +
    'which import it redirects to workspace code. Use a plain package name as the key.';
  const walk = (file, value, rawKey, map) => {
    const key = rawKey === undefined ? undefined : parseOverrideSelector(rawKey);
    if (typeof value === 'string') {
      const local = LOCAL_PREFIX.test(value) || (SPEC_MAPS.has(map) && LOCAL_PATH.test(value));
      if (local && rawKey !== undefined) {
        if (key === undefined) problems.push(unnamed(file, rawKey, value));
        else names.add(key);
      }
      const target = /^workspace:((?:@[^/@]+\/)?[^/@]+)@/.exec(value);
      if (target) names.add(target[1]);
      const npm = /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@|$)/.exec(value);
      if (npm && rawKey !== undefined) aliases.push({ key, rawKey, file, value, target: npm[1] });
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(file, v, k, rawKey);
    }
  };
  for (const file of tracked) {
    if (/(^|\/)package\.json$/.test(file)) {
      try {
        const pkg = JSON.parse(read(file));
        if (typeof pkg.name === 'string') names.add(pkg.name);
        walk(file, pkg);
      } catch (error) {
        problems.push(
          `${file} is not readable JSON (${error.message}); its lint task cannot be checked.`,
        );
      }
    } else if (/(^|\/)pnpm-workspace\.ya?ml$/.test(file)) {
      try {
        walk(file, parseYaml(String(read(file) ?? '')));
      } catch (error) {
        problems.push(
          `${file} is not readable YAML (${error.message}); its overrides and aliases cannot be checked.`,
        );
      }
    }
  }
  for (const { key, rawKey, file, value, target } of aliases) {
    if (!names.has(target)) continue;
    if (key === undefined) problems.push(unnamed(file, rawKey, value));
    else names.add(key);
  }
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
export const dependencyClosure = (
  entries,
  { tracked, read, localNames, exceptions = BUILTIN_READERS },
) => {
  const files = new Map(entries.map((entry) => [entry, 'an eslint config']));
  const errors = [];
  /** The loaded modules that have an exact-path built-in exception. */
  const excepted = new Set();
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
    const { specifiers, errors: found, builtinUse, importNames } = analyzeModule(file, source);
    errors.push(...found);
    const entry = exceptions.get(file);
    const usedBuiltins = new Set();
    for (const specifier of specifiers) {
      if (/^\.\.?([/\\]|$)/.test(specifier)) {
        const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
        if (nonCanonical(specifier)) {
          errors.push(
            `${file} loads ${JSON.stringify(specifier)}, a relative specifier with a %, ?, #, backslash, whitespace or ` +
              `control character: ESM resolves it as a URL, not as a file name, so this ${GRAMMAR}.`,
          );
        } else if (!KNOWN_EXT.test(specifier)) {
          errors.push(
            `${file} loads '${specifier}', a relative path without an explicit JS/TS extension (a directory, ` +
              `extensionless, .json or unknown suffix), so this ${GRAMMAR}.`,
          );
        } else if (!tracked.has(resolved)) {
          errors.push(
            `${file} loads '${specifier}', which is not an existing tracked file, so this ${GRAMMAR}.`,
          );
        } else {
          const only = exceptions.get(resolved)?.exports;
          const names = importNames.get(specifier) ?? new Set(); // a side-effect import takes no name
          if (only !== undefined && (names === '*' || ![...names].every((n) => only.includes(n)))) {
            errors.push(
              `${file} loads '${specifier}' (${resolved}), whose built-in exception allows a lint-time importer ` +
                `only ${only.map((n) => `\`${n}\``).join(', ')}, but it takes ${
                  names === '*'
                    ? 'everything (a default, namespace, require() or import())'
                    : [...names].join(', ')
                }: its other exports run what it was excepted from, so this ${GRAMMAR}.`,
            );
          }
          if (!files.has(resolved)) {
            files.set(resolved, `loaded by ${file}`);
            queue.push(resolved);
          }
        }
      } else if (specifier.startsWith('node:') || isBuiltin(specifier)) {
        const builtin = specifier.replace(/^node:/, '');
        if (ALLOWED_BUILTINS.has(builtin)) continue;
        const declared = own(entry?.builtins, builtin);
        if (declared === undefined) {
          errors.push(
            `${file} loads the built-in '${specifier}', which can load code or read files, so this ${GRAMMAR}. ` +
              'A module that has to use one needs its own exact-path entry in BUILTIN_READERS naming the members ' +
              'it uses and what it reads; a built-in allow-list is not an option.',
          );
          continue;
        }
        usedBuiltins.add(builtin);
        const use = builtinUse.get(builtin);
        if (use === undefined || use.opaque) {
          errors.push(
            `${file} loads '${specifier}' other than by static import and \`local.member\` access (require, ` +
              'import(), a re-export, destructuring, or the namespace used as a value), so the members it uses ' +
              `cannot be checked against its BUILTIN_READERS entry, and this ${GRAMMAR}.`,
          );
          continue;
        }
        for (const member of use.members) {
          if (!declared.includes(member)) {
            errors.push(
              `${file} uses \`${builtin}.${member}\`, which its BUILTIN_READERS entry does not list: declare it ` +
                'with what it reads, so the guard can check that it is a hashed lint input.',
            );
          }
        }
        for (const member of declared) {
          if (!use.members.has(member)) {
            errors.push(
              `${file} no longer uses \`${builtin}.${member}\`, which its BUILTIN_READERS entry still lists: remove it.`,
            );
          }
        }
      } else if (/^[#/]/.test(specifier) || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
        errors.push(
          `${file} loads '${specifier}' (an absolute path, URL or #alias), so this ${GRAMMAR}.`,
        );
      } else {
        bare(file, specifier);
      }
    }
    if (entry !== undefined) {
      excepted.add(file);
      for (const builtin of Object.keys(entry.builtins ?? {})) {
        if (!usedBuiltins.has(builtin)) {
          errors.push(
            `${file} no longer imports the built-in '${builtin}', which its BUILTIN_READERS entry still lists: remove it.`,
          );
        }
      }
    }
  }
  return { files, errors, excepted };
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
  const why = (reason) =>
    `\`lint\` is ${JSON.stringify(script)}: ${reason}. The guard only supports exactly one command, \`eslint <paths>\`, ` +
    'because it reads the default config lookup from the workspace directory.';
  // ONE command, decided on the raw text before any tokenizing (a newline or a
  // separator would otherwise be erased by the whitespace split).
  const control = /[\n\r;&|`$()<>\\]/.exec(script);
  if (control !== null) {
    return why(`it contains ${JSON.stringify(control[0])}, so it is not a single command`);
  }
  const tokens = script.trim().split(/[ \t]+/);
  if (tokens[0] !== 'eslint' || tokens.length < 2) return why('it is not `eslint <paths>`');
  for (const arg of tokens.slice(1)) {
    if (/[*?[\]{}]/.test(arg)) return why(`the path \`${arg}\` has a glob character`);
    // One simple rule: a path is `.`, or starts with `./`, or starts with a letter,
    // digit, `_` or `@` (a literal directory or file name). Nothing that can start
    // with `-` (an option, or a tracked file named like one) is accepted.
    if (!/^(?:\.|\.\/[A-Za-z0-9_@./+,-]*|[A-Za-z0-9_@][A-Za-z0-9_@./+,-]*)$/.test(arg)) {
      return why(
        `the path \`${arg}\` is not \`.\`, \`./…\` or a literal name starting with a letter, digit, _ or @`,
      );
    }
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
export const discover = ({ tracked, read, exceptions = BUILTIN_READERS }) => {
  const problems = [...exceptionTableProblems(exceptions)];
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
    const { files, errors, excepted } = dependencyClosure(configs, {
      tracked,
      read,
      localNames,
      exceptions,
    });
    for (const config of configs) used.add(config);
    for (const error of errors) if (!problems.includes(error)) problems.push(error);
    found.push({ ...workspace, files, excepted });
  }
  for (const file of tracked) {
    if (/^eslint\.config\./.test(file) || !/(^|\/)eslint\.config\.[cm]?[jt]s$/.test(file)) continue;
    if (!used.has(file)) {
      problems.push(
        `${file} is an eslint config no workspace lint task uses; the guard cannot say what it loads.`,
      );
    }
  }
  return { problems, workspaces: found, all, tracked, read, localNames, exceptions };
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

/** Every tracked file at `prefix` (a file) or under it (a directory); `.` is the repository. */
const trackedAt = (tracked, prefix) =>
  [...tracked].filter((f) => prefix === '.' || f === prefix || f.startsWith(`${prefix}/`));

const TSCONFIG_LEAVES = ['tsconfig.test.json', 'tsconfig.json'];
const GLOB_CHAR = /[*?[{]/;

/**
 * The `typescript-project` read surface of the workspace in `dir`: its tsconfig files, their
 * `extends` chain (a relative path, `.json` implied; a bare name is a package unless it is a
 * workspace package), and every file or directory those configs point at — `files`, `include`
 * (the static part before a glob), `references`, `baseUrl`, `rootDirs`, `typeRoots`, `paths`
 * targets. A config that sets neither `files` nor `include` anywhere in its chain includes its
 * own directory. Fails closed: an unreadable config, an `extends` that is not a tracked file, an
 * absolute or `${…}` path, or a path outside the repository is a problem.
 * Result: { files: Map<file, why>, problems }.
 */
export const typescriptProject = (dir, { tracked, read, localNames }) => {
  const files = new Map();
  const problems = [];
  // The parser picks the first of these that exists, and reads only that project.
  const leaf = TSCONFIG_LEAVES.map((name) => (dir === '.' ? name : `${dir}/${name}`)).find((f) =>
    tracked.has(f),
  );
  if (leaf !== undefined) {
    const seen = new Set();
    const trees = new Map();
    const baseUrls = new Set();
    const pathTargets = [];
    let selects = false;
    const tree = (config, raw, what, base = posix.dirname(config)) => {
      if (typeof raw !== 'string' || /^[/\\]|^[A-Za-z]:|\$\{|\\/.test(raw)) {
        problems.push(
          `${config} ${what} ${JSON.stringify(raw)} is not a relative path the guard can follow, so the TypeScript ` +
            'project the lint parser reads cannot be checked against turbo’s hashed inputs.',
        );
        return undefined;
      }
      const fixed = [];
      for (const part of raw.split('/')) {
        if (GLOB_CHAR.test(part)) break;
        fixed.push(part);
      }
      const prefix = posix.normalize(posix.join(base, fixed.join('/') || '.'));
      if (prefix === '..' || prefix.startsWith('../')) {
        problems.push(
          `${config} ${what} ${JSON.stringify(raw)} reaches outside the repository, so the TypeScript project the ` +
            'lint parser reads cannot be hashed.',
        );
        return undefined;
      }
      trees.set(prefix, `${config} ${what} ${raw}`);
      return prefix;
    };
    const visit = (file, why) => {
      if (seen.has(file)) return;
      seen.add(file);
      files.set(file, why);
      const { config, error } = ts.parseConfigFileTextToJson(file, read(file) ?? '');
      if (error !== undefined || config === null || typeof config !== 'object') {
        problems.push(
          `${file} is not a readable tsconfig, so the TypeScript project it describes cannot be checked.`,
        );
        return;
      }
      const here = posix.dirname(file);
      const extended = config.extends === undefined ? [] : [config.extends].flat();
      for (const target of extended) {
        if (typeof target !== 'string') {
          problems.push(`${file} has an \`extends\` that is not a path or a list of paths.`);
        } else if (/^\.{1,2}(?:\/|$)/.test(target)) {
          const resolved = posix.normalize(posix.join(here, target));
          const found = [resolved, `${resolved}.json`].find((candidate) => tracked.has(candidate));
          if (found === undefined) {
            problems.push(`${file} extends '${target}', which is not a tracked file.`);
          } else visit(found, `extended by ${file}`);
        } else {
          const bare = target.startsWith('@')
            ? target.split('/').slice(0, 2).join('/')
            : target.split('/')[0];
          if (/^[/\\]|^[A-Za-z]:|\\/.test(target) || localNames.has(bare)) {
            problems.push(
              `${file} extends '${target}', an absolute path or a workspace package: its source is a lint input ` +
                'the guard does not follow. Extend it by relative path.',
            );
          }
        }
      }
      for (const key of ['files', 'include']) {
        if (config[key] === undefined) continue;
        selects = true;
        for (const raw of [config[key]].flat()) tree(file, raw, `\`${key}\` entry`);
      }
      for (const reference of [config.references ?? []].flat()) {
        tree(file, reference?.path, '`references` path');
      }
      const options = config.compilerOptions ?? {};
      if (options.baseUrl !== undefined) {
        const base = tree(file, options.baseUrl, '`baseUrl`');
        if (base !== undefined) baseUrls.add(base);
      }
      for (const key of ['rootDirs', 'typeRoots']) {
        for (const raw of [options[key] ?? []].flat()) tree(file, raw, `\`${key}\` entry`);
      }
      for (const targets of Object.values(options.paths ?? {})) {
        for (const raw of [targets].flat()) pathTargets.push({ file, raw });
      }
    };
    visit(leaf, 'the project tsconfig the lint parser selects');
    for (const { file, raw } of pathTargets) {
      tree(file, raw, '`paths` target');
      for (const base of baseUrls) tree(file, raw, '`paths` target', base);
    }
    if (!selects) tree(leaf, '.', 'default include (neither `files` nor `include` is set)');
    for (const [prefix, why] of trees) {
      for (const file of trackedAt(tracked, prefix)) if (!files.has(file)) files.set(file, why);
    }
  }
  return { files, problems };
};

/** The files of one read surface of one lint workspace: { files: Map<file, why>, problems }. */
const readSurface = (surface, workspace, state) => {
  const { dir } = workspace;
  if (surface === 'linted-files') {
    const files = new Map(
      trackedAt(state.tracked, dir).map((f) => [
        f,
        `a file under ${dir}, linted by ${workspace.name}`,
      ]),
    );
    return { files, problems: [] };
  }
  if (surface === 'workspace-manifest') {
    const manifest = dir === '.' ? 'package.json' : `${dir}/package.json`;
    return { files: new Map([[manifest, `the manifest of ${workspace.name}`]]), problems: [] };
  }
  if (surface === 'typescript-project') return typescriptProject(dir, state);
  return { files: new Map(), problems: [] };
};

/**
 * Everything an excepted built-in reader reads must be hashed by the lint task of each
 * workspace that loads it: `found` is `discover()`'s result, `hashed` turbo's.
 */
export const exceptionReadProblems = (found, hashed) => {
  const problems = [];
  for (const workspace of found.workspaces) {
    const task = hashed.tasks.get(`${workspace.name}#lint`);
    if (task === undefined || !task.cache) continue;
    for (const path of workspace.excepted) {
      for (const { surface, why } of found.exceptions.get(path).reads) {
        if (surface === 'dependency-builds') {
          if (!task.dependsOn.includes('^build')) {
            problems.push(
              `${path} reads ${surface} (${why}) for ${workspace.name}, but its lint task does not depend on ` +
                '`^build`, so a change to a dependency’s build output would replay a cached lint green.',
            );
          }
          continue;
        }
        const { files, problems: unreadable } = readSurface(surface, workspace, found);
        problems.push(...unreadable);
        const missing = [...files.keys()].filter(
          (f) => !task.files.has(f) && !hashed.global.has(f),
        );
        if (missing.length > 0) {
          problems.push(
            `${path} reads the \`${surface}\` surface (${why}) for ${workspace.name}, but ${missing.length} of its ` +
              `files are not in turbo’s resolved hashed inputs for that task (\`turbo run lint --dry=json\`), e.g. ` +
              `${missing.slice(0, 3).join(', ')}: a change to one would replay a cached lint green. Add them as ` +
              'plain "$TURBO_ROOT$/…" inputs to the lint task that applies.',
          );
        }
      }
    }
  }
  return [...new Set(problems)];
};

/** Exceptions no lint workspace loads: the list must stay exact, so each is removed. */
export const staleExceptions = (found) =>
  [...found.exceptions.keys()].filter(
    (path) => !found.workspaces.some((w) => w.excepted.has(path)),
  );

/** Every problem with what turbo's lint tasks hash versus what eslint loads. */
export const inputProblems = ({ tracked, read, hashed, exceptions }) => {
  const found = discover({ tracked, read, exceptions });
  return [
    ...found.problems,
    ...coverageProblems(found, hashed),
    ...exceptionReadProblems(found, hashed),
  ];
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
      dependsOn: task.resolvedTaskDefinition?.dependsOn ?? [],
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
export const fixtureProblems = (files, exceptions) =>
  withFixtureRepo(files, (dir) => {
    const state = memoryState(files);
    return inputProblems({ ...state, exceptions, hashed: turboSnapshot({ cwd: dir }) });
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
    // The discovery half only: the read-surface half has its own mutants below.
    const problems = [...found.problems, ...coverageProblems(found, hashed)];
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
  // r4: one command only, decided before tokenizing
  'eslint src\ntrue',
  'eslint src\nexit 0',
  'eslint src\nnode ../../tools/alternate.mjs',
  'eslint src\rtrue',
  'eslint src `true`',
  'eslint src > out',
  'eslint src < in',
  'eslint src &',
  'eslint src \\\ntrue',
  // r4: no glob, no path that can expand to or be read as an option
  'eslint *',
  'eslint *.mjs',
  'eslint src/**/*.ts',
  'eslint src?',
  'eslint [a]rc',
  'eslint {src,test}',
  'eslint -- src',
  'eslint --config=alternate.mjs',
  'eslint -x',
  'eslint ../other',
  'eslint ~/src',
  'eslint /abs/src',
  "eslint 'src'",
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

test('control: the lint commands the repository uses are single commands the guard accepts', () => {
  for (const command of [
    'eslint .',
    'eslint src',
    'eslint src test dev',
    'eslint src test dev prisma/seed.ts',
    'eslint ./src ./test',
    'eslint  src\ttest',
  ]) {
    assert.equal(lintScriptProblem(command), undefined, command);
  }
});

test('each lint command check fails on its own, with its own reason (no check hides behind another)', () => {
  const reason = (command) => lintScriptProblem(command) ?? '';
  for (const command of [
    'eslint src\ntrue',
    'eslint src\rtrue',
    'eslint src; true',
    'eslint src && true',
    'eslint src | cat',
    'eslint src `true`',
    'eslint src $(true)',
    'eslint src > out',
    'eslint src < in',
    'eslint src \\\ntrue',
  ]) {
    assert.match(reason(command), /so it is not a single command/, JSON.stringify(command));
  }
  for (const command of [
    'eslint *',
    'eslint *.mjs',
    'eslint src/?',
    'eslint [a]',
    'eslint {a,b}',
  ]) {
    assert.match(reason(command), /has a glob character/, command);
  }
  for (const command of [
    'eslint -x',
    'eslint --config=a.mjs',
    'eslint ../x',
    'eslint /x',
    "eslint 'src'",
  ]) {
    assert.match(reason(command), /is not `\.`, `\.\/…` or a literal name/, command);
  }
});

const NON_CANONICAL_SPECIFIERS = {
  'a percent escape': '../../scripts/%61-rule.mjs',
  'a query ending in .mjs': '../../scripts/a-rule.mjs?x=.mjs',
  'a fragment ending in .mjs': '../../scripts/a-rule.mjs#x.mjs',
  'a backslash': '..\\..\\scripts\\a-rule.mjs',
  'an embedded tab': '../../scripts/a-\trule.mjs',
  'a space': '../../scripts/a- rule.mjs',
  'a newline': '../../scripts/a-\nrule.mjs',
  'a NUL': '../../scripts/a-\u0000rule.mjs',
  'a non-breaking space': '../../scripts/a-\u00a0rule.mjs',
};
for (const [name, specifier] of Object.entries(NON_CANONICAL_SPECIFIERS)) {
  for (const form of ['import', 'export', 'dynamic', 'require']) {
    test(`fail closed: ${name} in a ${form} specifier is an error even when a decoy file is tracked`, () => {
      const literal = JSON.stringify(specifier);
      const body = {
        import: `import rule from ${literal};\nexport default [rule];\n`,
        export: `export { default } from ${literal};\n`,
        dynamic: `export default [await import(${literal})];\n`,
        require: `module.exports = [require(${literal})];\n`,
      }[form];
      const files = {
        ...baseFiles(),
        // a decoy whose literal name equals what POSIX normalization makes of the specifier
        [posix.normalize(posix.join('apps/web', specifier))]: 'export default {};\n',
        [WEB_CONFIG]: body,
      };
      const problems = discover(memoryState(files)).problems;
      assert.ok(
        problems.some((p) => /relative specifier with a %/.test(p)),
        fail(problems),
      );
    });
  }
}

test('fail closed: an override selector with a version or parent qualifier, a flow mapping, an anchor or a merge key still names the local package', () => {
  const YAMLS = {
    'a version-qualified key': 'overrides:\n  "plugin-alias@^1": "link:./tools/local-plugin"\n',
    'a parent-qualified key': 'overrides:\n  "host>plugin-alias": "link:./tools/local-plugin"\n',
    'both qualifiers': 'overrides:\n  "host@2>plugin-alias@^1": "link:./tools/local-plugin"\n',
    'a flow mapping': 'overrides: {plugin-alias: "link:./tools/local-plugin"}\n',
    'a folded scalar': 'overrides:\n  plugin-alias: >-\n    link:./tools/local-plugin\n',
    'an anchored value': 'x: &l "link:./tools/local-plugin"\noverrides:\n  plugin-alias: *l\n',
    'a merge key': 'base: &b\n  plugin-alias: "link:./tools/local-plugin"\noverrides:\n  <<: *b\n',
  };
  for (const [name, yaml] of Object.entries(YAMLS)) {
    const files = {
      ...baseFiles(),
      'pnpm-workspace.yaml': `packages:\n  - "apps/*"\n${yaml}`,
      [WEB_CONFIG]: "import plugin from 'plugin-alias';\nexport default [plugin];\n",
    };
    assert.ok(
      discover(memoryState(files)).problems.some((p) => p.includes("'plugin-alias'")),
      name,
    );
  }
  const scoped = {
    ...baseFiles(),
    'package.json':
      '{"name":"root","pnpm":{"overrides":{"@s/plugin@1>@s/plugin-alias@2":"link:./x"}},"scripts":{"lint":"turbo run lint"}}',
    [WEB_CONFIG]: "import plugin from '@s/plugin-alias';\nexport default [plugin];\n",
  };
  assert.ok(discover(memoryState(scoped)).problems.some((p) => p.includes("'@s/plugin-alias'")));
});

// F1.4 (r5): the selector grammar is pnpm's, so a range comparator (`>=`, `>`), a union, a
// bounded range or a multi-line range never turns into a package name or a parent separator.
const SELECTOR_SHAPES = [
  'N',
  'N@1',
  'N@^1',
  'N@~1.2',
  'N@1.x',
  'N@*',
  'N@>=1',
  'N@>1',
  'N@<2',
  'N@<=2',
  'N@>=1 <2',
  'N@>1.0.0 <=2.0.0',
  'N@1.0.0 - 2.0.0',
  'N@^1 || ^2',
  'N@^1||>=3',
  'N@^1\n|| ^2',
  'N@>=1\n <2',
  'N@>=1 || <0.5\n|| 2.x',
  'host>N',
  'host>N@>=1',
  'host>N@>=1 <2',
  'h>N',
  'h@>=1>N@>=1',
  'host@2>N',
  'host@2>N@>1',
  'host@>=2 <3>N@^1 || ^2',
  'host@^1\n|| ^2>N@^1\n|| ^2',
  'host@>=1>N@>=1',
  '@s/host>N@>=1',
  '@s/host@>=2>N',
];
const shapesOf = (name) => SELECTOR_SHAPES.map((shape) => shape.replace(/N/g, name));

test('parseOverrideSelector reads pnpm selectors: a comparator is not a separator, a range is only cut off', () => {
  for (const name of ['plugin-alias', '@s/plugin-alias']) {
    for (const selector of shapesOf(name)) {
      // `host` also contains no N, so the child is always `name`.
      assert.equal(parseOverrideSelector(selector), name, JSON.stringify(selector));
    }
  }
  assert.equal(parseOverrideSelector('plugin-alias@>=1'), 'plugin-alias');
  assert.equal(parseOverrideSelector('plugin-alias@^1\n|| ^2'), 'plugin-alias');
  assert.equal(parseOverrideSelector('@s/n@>=1\n<3'), '@s/n');
});

test('parseOverrideSelector rejects what does not name exactly one package', () => {
  for (const selector of [
    '',
    ' ',
    '>',
    'host>',
    '>plugin-alias',
    'plugin-alias@1>=2', // pnpm splits at `1>`; `=2` is not a package name
    'plugin-alias@^1\n>=2',
    'a>b>c',
    ' plugin-alias',
    'plugin-alias ',
    '.plugin-alias',
    '_plugin-alias',
    'a/b',
    '@s',
    '@s/',
    '@/n',
    'a b',
    'a%20b',
    'host@>=1>',
    '@s/a/b',
    '.host>plugin-alias', // the parent must be a package too, or pnpm rejects the selector
    'a b>plugin-alias',
    'host/x>plugin-alias',
    '@s>plugin-alias',
  ]) {
    assert.equal(parseOverrideSelector(selector), undefined, JSON.stringify(selector));
  }
  assert.equal(parseOverrideSelector(undefined), undefined);
});

const OVERRIDE_PLACES = {
  'pnpm-workspace.yaml overrides': (key, value) => ({
    'pnpm-workspace.yaml': `packages:\n  - "apps/*"\noverrides:\n  ${JSON.stringify(key)}: ${JSON.stringify(value)}\n`,
  }),
  'package.json pnpm.overrides': (key, value) => ({
    'package.json': JSON.stringify({
      name: 'root',
      pnpm: { overrides: { [key]: value } },
      scripts: { lint: 'turbo run lint' },
    }),
  }),
  'package.json resolutions': (key, value) => ({
    'package.json': JSON.stringify({
      name: 'root',
      resolutions: { [key]: value },
      scripts: { lint: 'turbo run lint' },
    }),
  }),
};
const SELECTOR_HOLDERS = {
  config: WEB_CONFIG,
  rule: 'scripts/a-rule.mjs',
  helper: 'scripts/helper-b.mjs',
};
for (const [place, make] of Object.entries(OVERRIDE_PLACES)) {
  for (const [holder, path] of Object.entries(SELECTOR_HOLDERS)) {
    test(`fail closed: every override selector shape redirects to a local package (${place}, ${holder})`, () => {
      for (const name of ['plugin-alias', '@s/plugin-alias']) {
        for (const selector of shapesOf(name)) {
          for (const spec of ['link:./tools/local-plugin', 'file:./tools/local-plugin']) {
            const files = {
              ...baseFiles(),
              ...make(selector, spec),
              [path]: `import plugin from '${name}';\nexport default [plugin];\n`,
            };
            const problems = discover(memoryState(files)).problems;
            assert.ok(
              problems.some((p) => p.includes(`'${name}'`) && /workspace/.test(p)),
              `${JSON.stringify(selector)} → ${spec}\n${fail(problems)}`,
            );
          }
        }
      }
    });

    test(`fail closed: a selector that names no single package over a local source is an error (${place}, ${holder})`, () => {
      for (const selector of [
        'plugin-alias@1>=2',
        'plugin-alias@^1\n>=2',
        'host>',
        ' plugin-alias',
        'a>b>c',
        '.',
      ]) {
        for (const spec of [
          'link:./tools/local-plugin',
          'portal:./tools/local-plugin',
          'workspace:*',
          './tools/local-plugin',
        ]) {
          const files = {
            ...baseFiles(),
            ...make(selector, spec),
            [path]: "import plugin from 'plugin-alias';\nexport default [plugin];\n",
          };
          const problems = discover(memoryState(files)).problems;
          assert.ok(
            problems.some((p) => /does not name exactly one package/.test(p)),
            `${JSON.stringify(selector)} → ${spec}\n${fail(problems)}`,
          );
        }
      }
    });
  }
}

test('an unparsable override selector over a registry version is not an error, and a path map is not an override', () => {
  for (const make of Object.values(OVERRIDE_PLACES)) {
    const files = { ...baseFiles(), ...make('plugin-alias@1>=2', '1.2.3') };
    assert.deepEqual(discover(memoryState(files)).problems, []);
  }
  const files = {
    ...baseFiles(),
    'apps/web/package.json': JSON.stringify({
      name: '@rasta/web',
      scripts: { lint: 'eslint src' },
      exports: { './x': './dist/x.js', '.': './dist/index.js' },
    }),
  };
  assert.deepEqual(discover(memoryState(files)).problems, []);
});

test('fail closed: an unprefixed relative override or dependency path names the local package', () => {
  const OVERRIDE_PATHS = ['./tools/local-plugin', '../tools/local-plugin', '~/local-plugin'];
  for (const [place, make] of Object.entries(OVERRIDE_PLACES)) {
    for (const spec of OVERRIDE_PATHS) {
      const files = {
        ...baseFiles(),
        ...make('plugin-alias@>=1', spec),
        [WEB_CONFIG]: "import plugin from 'plugin-alias';\nexport default [plugin];\n",
      };
      assert.ok(
        discover(memoryState(files)).problems.some((p) => p.includes("'plugin-alias'")),
        `${place} ${spec}`,
      );
    }
  }
  const dependency = {
    ...baseFiles(),
    'apps/web/package.json': JSON.stringify({
      name: '@rasta/web',
      scripts: { lint: 'eslint src' },
      dependencies: { 'plugin-alias': '../../tools/local-plugin' },
    }),
    [WEB_CONFIG]: "import plugin from 'plugin-alias';\nexport default [plugin];\n",
  };
  assert.ok(discover(memoryState(dependency)).problems.some((p) => p.includes("'plugin-alias'")));
});

test('fail closed: an npm: alias of a workspace package under a selector that names no package is an error', () => {
  for (const [place, make] of Object.entries(OVERRIDE_PLACES)) {
    const files = {
      ...baseFiles(),
      'tools/local-plugin/package.json': '{"name":"@rasta/local-plugin"}',
      ...make('plugin-alias@^1\n>=2', 'npm:@rasta/local-plugin@*'),
    };
    assert.ok(
      discover(memoryState(files)).problems.some((p) =>
        /does not name exactly one package/.test(p),
      ),
      place,
    );
  }
  // and an npm: alias under a good selector with a comparator still names the local package
  const files = {
    ...baseFiles(),
    'tools/local-plugin/package.json': '{"name":"@rasta/local-plugin"}',
    ...OVERRIDE_PLACES['pnpm-workspace.yaml overrides'](
      'plugin-alias@>=1',
      'npm:@rasta/local-plugin@*',
    ),
    [WEB_CONFIG]: "import plugin from 'plugin-alias';\nexport default [plugin];\n",
  };
  assert.ok(discover(memoryState(files)).problems.some((p) => p.includes("'plugin-alias'")));
});

test('fail closed: a YAML npm: alias of a workspace package names the local package', () => {
  const files = {
    ...baseFiles(),
    'tools/local-plugin/package.json': '{"name":"@rasta/local-plugin"}',
    'pnpm-workspace.yaml':
      'packages:\n  - "apps/*"\noverrides:\n  plugin-alias: "npm:@rasta/local-plugin@*"\n',
    [WEB_CONFIG]: "import plugin from 'plugin-alias';\nexport default [plugin];\n",
  };
  assert.ok(discover(memoryState(files)).problems.some((p) => p.includes("'plugin-alias'")));
});

test('fail closed: a pnpm-workspace.yaml that does not parse is an error', () => {
  const files = { ...baseFiles(), 'pnpm-workspace.yaml': 'overrides: {a: [\n' };
  assert.ok(discover(memoryState(files)).problems.some((p) => /not readable YAML/.test(p)));
});

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

// ---------------------------------------------------------------------------
// Both `node --test` chains of lint:scripts (main runs two joined by `&&`).
// ---------------------------------------------------------------------------

const FIRST = 'scripts/a-rule.test.mjs';
const SECOND = 'scripts/b-workspace.test.mjs';

test('lint:scripts is read as a chain: every node --test command registers its files', () => {
  assert.deepEqual(
    registeredTests(`eslint scripts && node --test ${FIRST} && node --test ${SECOND} ${SELF}`),
    [FIRST, SECOND, SELF],
  );
  assert.deepEqual(registeredTests(`node --test ${FIRST}`), [FIRST]);
  assert.deepEqual(registeredTests(`eslint . && node --test ${FIRST} ${SECOND}`), [FIRST, SECOND]);
  const text = JSON.parse(readDisk('package.json')).scripts['lint:scripts'];
  const real = registeredTests(text);
  assert.ok(text.split('&&').length >= 3, 'the real script is no longer a chain of commands');
  for (const file of [
    'scripts/internal-token-source-workspace.test.mjs',
    'scripts/internal-token-transport-rule.test.mjs',
    SELF,
  ]) {
    assert.ok(real.includes(file), `${file} is not registered`);
  }
});

test('a file in the second chain is required and registered like one in the first', () => {
  const state = realState();
  const second = 'scripts/internal-token-source-workspace.test.mjs';
  assert.ok(requiredTests(state.names).has(second), 'the convention no longer requires it');
  assert.deepEqual(registrationProblems(state), []);
  // The old reader stopped at the first `&&`: the second chain looked unregistered.
  const text = JSON.parse(readDisk('package.json')).scripts['lint:scripts'];
  const firstOnly = registeredTests(
    text.slice(0, text.indexOf(' && node --test scripts/internal-token-source')),
  );
  assert.ok(!firstOnly.includes(second));
  assert.ok(
    unregisteredTests(state.names, firstOnly).some((p) => p.startsWith(`${second} `)),
    'a file only the second chain runs must be reported when that chain is not read',
  );
  // And listing a file in both chains is a duplicate, not two registrations.
  const both = registeredTests(`${text} && node --test ${second}`);
  assert.ok(
    staleRegistrations(both, (f) => state.tracked.has(f)).some((p) =>
      p.startsWith(`${second} is listed twice`),
    ),
  );
});

test('fail closed: a lint:scripts shape other than eslint / node --test chains throws', () => {
  const bad = {
    'a semicolon': `node --test ${FIRST}; node --test ${SECOND}`,
    'an or': `node --test ${FIRST} || node --test ${SECOND}`,
    'a pipe': `node --test ${FIRST} | cat`,
    'a background job': `node --test ${FIRST} & node --test ${SECOND}`,
    'three ampersands': `node --test ${FIRST} &&& node --test ${SECOND}`,
    'a trailing ampersand': `node --test ${FIRST} &`,
    'a variable': `node --test $FILES`,
    'a command substitution': `node --test $(ls scripts)`,
    'a backtick': 'node --test `ls`',
    'a newline': `node --test ${FIRST}\nnode --test ${SECOND}`,
    'a redirect': `node --test ${FIRST} > out.txt`,
    'a comment': `node --test ${FIRST} # ${SECOND}`,
    'a quote': `node --test '${FIRST}'`,
    'a glob': 'node --test scripts/*.test.mjs',
    'a brace expansion': 'node --test scripts/{a,b}.test.mjs',
    'a leading &&': `&& node --test ${FIRST}`,
    'a trailing &&': `node --test ${FIRST} &&`,
    'an empty segment': `node --test ${FIRST} && && node --test ${SECOND}`,
    'an env prefix': `FOO=1 node --test ${FIRST}`,
    'another program': `node --test ${FIRST} && npm test`,
    'node without --test': `node ${FIRST}`,
    'no file': 'node --test',
    'a second command with no file': `node --test ${FIRST} && node --test`,
    'a name filter': `node --test --test-name-pattern=x ${FIRST}`,
    'a name filter after the files': `node --test ${FIRST} --test-skip-pattern=x`,
    only: `node --test --test-only ${FIRST}`,
    'a path outside scripts': 'node --test ../scripts/a.test.mjs',
    'a nested path': 'node --test scripts/sub/a.test.mjs',
    'a non-test file': 'node --test scripts/a.mjs',
    'no node --test at all': 'eslint scripts',
  };
  for (const [what, script] of Object.entries(bad)) {
    assert.throws(() => registeredTests(script), /lint:scripts/, `${what}: ${script}`);
  }
});

// ---------------------------------------------------------------------------
// Exact-path built-in exceptions (D-101): BUILTIN_READERS.
// ---------------------------------------------------------------------------

const exceptionsOf = (...entries) => new Map(entries);
const READER_PATH = 'scripts/helper-b.mjs';
const reader = (extra = {}) => ({
  why: 'a fixture reader',
  builtins: { fs: ['readFileSync'] },
  reads: [{ surface: 'linted-files', why: 'the linted file' }],
  ...extra,
});
const READER_SOURCE =
  "import { readFileSync } from 'node:fs';\nexport const y = (f) => readFileSync(f, 'utf8');\n";
const withReader = (source = READER_SOURCE) => ({
  ...baseFiles(),
  [READER_PATH]: source,
});
const messages = (problems, needle) => problems.filter((p) => p.includes(needle));

test('exceptions: the real table is exact, and every excepted module is loaded and passes', () => {
  assert.deepEqual(exceptionTableProblems(BUILTIN_READERS), []);
  assert.deepEqual(
    [...BUILTIN_READERS.keys()].sort(),
    [
      'scripts/internal-token-parser.mjs',
      'scripts/internal-token-source-rule.mjs',
      'scripts/testing-dev-only.mjs',
    ],
    'a built-in exception was added or removed: update this list in the same reviewed change',
  );
  const state = realState();
  const found = discover(state);
  assert.deepEqual(staleExceptions(found), [], 'a stale exception: remove it from BUILTIN_READERS');
  const problems = realProblems(state);
  for (const path of BUILTIN_READERS.keys()) {
    assert.deepEqual(messages(problems, path), [], `${path} does not pass: ${fail(problems)}`);
  }
  assert.deepEqual(problems, [], fail(problems));
});

test('exceptions: a module outside the list that loads fs, child_process or os fails', () => {
  for (const [what, source] of Object.entries({
    'a named fs import': READER_SOURCE,
    'the unprefixed fs': "import { readFileSync } from 'fs';\nexport const y = readFileSync;\n",
    'fs/promises': "import { readFile } from 'node:fs/promises';\nexport const y = readFile;\n",
    child_process: "import { execSync } from 'node:child_process';\nexport const y = execSync;\n",
    os: "import { tmpdir } from 'node:os';\nexport const y = tmpdir;\n",
    'a namespace import': "import * as fs from 'node:fs';\nexport const y = fs.readFileSync;\n",
    'a default import': "import fs from 'node:fs';\nexport const y = fs.readFileSync;\n",
    'a require': "const fs = require('node:fs');\nexports.y = fs.readFileSync;\n",
    'a dynamic import': "export const y = await import('node:fs');\n",
    'a re-export': "export { readFileSync as y } from 'node:fs';\n",
  })) {
    const found = discover(memoryState(withReader(source)));
    assert.ok(
      found.problems.some(
        (p) => p.startsWith(`${READER_PATH} loads the built-in`) && p.includes('BUILTIN_READERS'),
      ),
      `${what}: not rejected (${fail(found.problems)})`,
    );
  }
});

test('exceptions: a module in the list passes only for the members and surfaces it declares', () => {
  const ok = (source, entry = reader()) =>
    discover({
      ...memoryState(withReader(source)),
      exceptions: exceptionsOf([READER_PATH, entry]),
    });
  assert.deepEqual(ok(READER_SOURCE).problems, []);
  assert.deepEqual(
    ok("import * as fs from 'fs';\nexport const y = (f) => fs.readFileSync(f);\n").problems,
    [],
  );
  assert.deepEqual(
    ok("import fs from 'node:fs';\nexport const y = (f) => fs['readFileSync'](f);\n").problems,
    [],
  );
  const wrong = {
    'an undeclared member': [
      "import { readFileSync, rmSync } from 'node:fs';\nexport const y = [readFileSync, rmSync];\n",
      'uses `fs.rmSync`',
    ],
    'an undeclared member through the namespace': [
      "import fs from 'node:fs';\nexport const y = [fs.readFileSync, fs.writeFileSync];\n",
      'uses `fs.writeFileSync`',
    ],
    'a declared member no longer used': [
      "import { existsSync } from 'node:fs';\nexport const y = existsSync;\n",
      'no longer uses `fs.readFileSync`',
    ],
    'a declared built-in no longer imported': [
      'export const y = 1;\n',
      "no longer imports the built-in 'fs'",
    ],
    'an undeclared built-in': [
      "import { readFileSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nexport const y = [readFileSync, tmpdir];\n",
      "loads the built-in 'node:os'",
    ],
    'a namespace used as a value': [
      "import fs from 'node:fs';\nexport const y = Object.assign({}, fs);\n",
      'other than by static import',
    ],
    'a destructured namespace': [
      "import fs from 'node:fs';\nconst { readFileSync } = fs;\nexport const y = readFileSync;\n",
      'other than by static import',
    ],
    'a require': [
      "const fs = require('node:fs');\nexports.y = fs.readFileSync;\n",
      'other than by static import',
    ],
    'a dynamic import': [
      "export const y = (await import('node:fs')).readFileSync;\n",
      'other than by static import',
    ],
    'a computed member': [
      "import fs from 'node:fs';\nexport const y = (name) => fs[name];\n",
      'other than by static import',
    ],
    'a re-export of the built-in': ["export * from 'node:fs';\n", 'other than by static import'],
  };
  for (const [what, [source, needle]] of Object.entries(wrong)) {
    const problems = ok(source).problems;
    assert.ok(
      problems.some((p) => p.startsWith(`${READER_PATH} `) && p.includes(needle)),
      `${what}: expected "${needle}" in ${fail(problems)}`,
    );
  }
});

test('exceptions: the names a lint-time importer may take are restricted by `exports`', () => {
  const only = reader({ exports: ['y'] });
  const importing = (line) => ({
    ...withReader(),
    'scripts/helper-a.mjs': `${line}\nexport const x = 1;\n`,
  });
  const run = (line) =>
    discover({
      ...memoryState(importing(line)),
      exceptions: exceptionsOf([READER_PATH, only]),
    }).problems;
  assert.deepEqual(run("import { y } from './helper-b.mjs';"), []);
  assert.deepEqual(run("export { y as z } from './helper-b.mjs';"), []);
  for (const line of [
    "import { y, other } from './helper-b.mjs';",
    "import other from './helper-b.mjs';",
    "import * as all from './helper-b.mjs';",
    "export * from './helper-b.mjs';",
    "export { other } from './helper-b.mjs';",
    "const all = await import('./helper-b.mjs');",
    "const all = require('./helper-b.mjs');",
  ]) {
    assert.ok(
      messages(run(line), 'whose built-in exception allows a lint-time importer only `y`').length >=
        1,
      `${line}: not rejected (${fail(run(line))})`,
    );
  }
  // a side-effect import takes no name; the module's top level runs, which `exports` does not bound
  assert.deepEqual(run("import './helper-b.mjs';"), []);
});

test('exceptions: a malformed table is rejected', () => {
  const entry = reader();
  const cases = {
    'a glob path': [['scripts/*.mjs', entry]],
    'a directory path': [['scripts', entry]],
    'a parent path': [['scripts/../x.mjs', entry]],
    'no why': [[READER_PATH, reader({ why: ' ' })]],
    'no builtins': [[READER_PATH, reader({ builtins: {} })]],
    'an allowed built-in': [[READER_PATH, reader({ builtins: { path: ['join'] } })]],
    'a name that is no built-in': [[READER_PATH, reader({ builtins: { nothing: ['x'] } })]],
    'no members': [[READER_PATH, reader({ builtins: { fs: [] } })]],
    'no reads': [[READER_PATH, reader({ reads: [] })]],
    'an unknown surface': [[READER_PATH, reader({ reads: [{ surface: 'everything', why: 'x' }] })]],
    'a surface without a reason': [[READER_PATH, reader({ reads: [{ surface: 'linted-files' }] })]],
    'a bad exports': [[READER_PATH, reader({ exports: 'y' })]],
  };
  for (const [what, entries] of Object.entries(cases)) {
    assert.ok(exceptionTableProblems(exceptionsOf(...entries)).length >= 1, what);
    const found = discover({ ...memoryState(withReader()), exceptions: exceptionsOf(...entries) });
    assert.ok(
      found.problems.some((p) => p.startsWith('BUILTIN_READERS[')),
      `${what}: not in discover`,
    );
  }
  assert.deepEqual(exceptionTableProblems(exceptionsOf([READER_PATH, entry])), []);
});

test('exceptions: an excepted module whose read surface is not a turbo input fails', async () => {
  const tsFiles = {
    ...withReader(),
    'tsconfig.base.json': '{}',
    'apps/web/tsconfig.json':
      '// the portal\n{"extends":"../../tsconfig.base.json","include":["src/**/*","../../shared/**/*.ts",],}',
    'apps/web/src/index.ts': 'export {};\n',
    'shared/x.ts': 'export {};\n',
  };
  const surfaces = (...names) =>
    exceptionsOf([
      READER_PATH,
      reader({ reads: names.map((surface) => ({ surface, why: 'fixture' })) }),
    ]);
  const run = (files, exceptions, inputs = BASE_INPUTS, extra = {}) =>
    withFixtureRepo({ ...files, 'turbo.json': turboJson(inputs, extra) }, (dir) =>
      inputProblems({
        ...memoryState({ ...files, 'turbo.json': turboJson(inputs, extra) }),
        exceptions,
        hashed: turboSnapshot({ cwd: dir }),
      }),
    );
  // all hashed: passes
  assert.deepEqual(
    run(
      tsFiles,
      surfaces('linted-files', 'workspace-manifest', 'typescript-project', 'location-only'),
      [...BASE_INPUTS, '$TURBO_ROOT$/shared/x.ts'],
      { globalDependencies: ['tsconfig.base.json'] },
    ),
    [],
  );
  // dropping the default inputs: the linted files and the manifest are no longer hashed
  const noDefault = BASE_INPUTS.filter((i) => i !== '$TURBO_DEFAULT$');
  {
    const problems = messages(
      run(tsFiles, surfaces('linted-files'), noDefault),
      `${READER_PATH} reads the \`linted-files\``,
    );
    assert.equal(problems.length, 1, problems.join(' | '));
    assert.ok(problems[0].includes('@rasta/web') && problems[0].includes('apps/web/'), problems[0]);
    // turbo hashes a package's own package.json whatever its inputs say, so that surface holds
    assert.deepEqual(
      messages(run(tsFiles, surfaces('workspace-manifest'), noDefault), 'workspace-manifest'),
      [],
    );
  }
  // a tsconfig that extends a root config turbo does not hash, and includes a tree outside the workspace
  const noGlobals = messages(
    run(tsFiles, surfaces('typescript-project'), BASE_INPUTS),
    `${READER_PATH} reads the \`typescript-project\``,
  );
  assert.equal(noGlobals.length, 1, noGlobals.join(' | '));
  assert.ok(
    noGlobals[0].includes('tsconfig.base.json') || noGlobals[0].includes('shared/x.ts'),
    noGlobals[0],
  );
  const onlyBase = messages(
    run(tsFiles, surfaces('typescript-project'), BASE_INPUTS, {
      globalDependencies: ['tsconfig.base.json'],
    }),
    'reads the `typescript-project`',
  );
  assert.equal(onlyBase.length, 1, onlyBase.join(' | '));
  assert.ok(
    onlyBase[0].includes('shared/x.ts') && !onlyBase[0].includes('tsconfig.base.json'),
    onlyBase[0],
  );
  const onlyShared = messages(
    run(tsFiles, surfaces('typescript-project'), [...BASE_INPUTS, '$TURBO_ROOT$/shared/x.ts']),
    'reads the `typescript-project`',
  );
  assert.equal(onlyShared.length, 1, onlyShared.join(' | '));
  assert.ok(onlyShared[0].includes('tsconfig.base.json'), onlyShared[0]);
  // dependency-builds needs `^build`
  const depends = () =>
    messages(
      run(tsFiles, surfaces('dependency-builds'), BASE_INPUTS, {}),
      'reads dependency-builds',
    );
  assert.equal(depends().length, 1, 'a lint task without ^build must fail dependency-builds');
  const withBuild = withFixtureRepo(
    {
      ...tsFiles,
      'turbo.json': JSON.stringify({
        tasks: { lint: { dependsOn: ['^build'], inputs: BASE_INPUTS } },
      }),
    },
    (dir) =>
      inputProblems({
        ...memoryState(tsFiles),
        exceptions: surfaces('dependency-builds'),
        hashed: turboSnapshot({ cwd: dir }),
      }),
  );
  assert.deepEqual(messages(withBuild, 'dependency-builds'), []);
});

test('typescript-project surface: the chain, the trees and the refusals', () => {
  const state = (files) => ({
    tracked: new Set(Object.keys(files)),
    read: (f) => files[f],
    localNames: new Set(['@rasta/contracts']),
  });
  const surface = (files, dir = 'apps/web') => typescriptProject(dir, state(files));
  const keys = (files, dir) => [...surface(files, dir).files.keys()].sort();
  const base = { 'tsconfig.base.json': '{}', 'apps/web/a.ts': '', 'apps/web/b.ts': '' };

  // a leaf, its extends chain (".json" implied, comments and trailing commas allowed) and its include tree
  assert.deepEqual(
    keys({
      ...base,
      'apps/web/tsconfig.test.json': '{"extends":"./tsconfig","include":["a.ts"],}',
      'apps/web/tsconfig.json': '// c\n{"extends":"../../tsconfig.base"}',
    }),
    [
      'apps/web/a.ts',
      'apps/web/tsconfig.json',
      'apps/web/tsconfig.test.json',
      'tsconfig.base.json',
    ],
  );
  // neither `files` nor `include` anywhere: the config’s own directory
  assert.deepEqual(
    keys({ ...base, 'apps/web/tsconfig.json': '{"extends":["../../tsconfig.base.json"]}' }),
    ['apps/web/a.ts', 'apps/web/b.ts', 'apps/web/tsconfig.json', 'tsconfig.base.json'],
  );
  // references, rootDirs, typeRoots, paths (against the config and the baseUrl), a glob cut at its static part
  const refs = surface({
    ...base,
    'packages/x/src/i.ts': '',
    'packages/y/t/i.d.ts': '',
    'packages/z/r/i.ts': '',
    'packages/w/p/i.ts': '',
    'packages/v/q/i.ts': '',
    'apps/web/tsconfig.json': JSON.stringify({
      include: ['../../packages/x/src/**/*.ts'],
      references: [{ path: '../../packages/z' }],
      compilerOptions: {
        rootDirs: ['../../packages/y'],
        typeRoots: ['../../packages/y/t'],
        baseUrl: '../../packages/v',
        paths: { '@w/*': ['../../packages/w/p/*'], '@q/*': ['q/*'] },
      },
    }),
  });
  assert.deepEqual(refs.problems, []);
  for (const f of [
    'packages/x/src/i.ts',
    'packages/z/r/i.ts',
    'packages/y/t/i.d.ts',
    'packages/w/p/i.ts',
  ]) {
    assert.ok(refs.files.has(f), `${f} not in the surface: ${[...refs.files.keys()].join(', ')}`);
  }
  assert.ok(refs.files.has('packages/v/q/i.ts'), 'a paths target is resolved against baseUrl too');
  // refusals
  const refuse = (config, needle, extra = {}) => {
    const { problems } = surface({ ...base, ...extra, 'apps/web/tsconfig.json': config });
    assert.ok(
      problems.some((p) => p.includes(needle)),
      `${config}: ${problems.join(' | ')}`,
    );
  };
  refuse('{ not json', 'not a readable tsconfig');
  refuse('[1]', 'not a readable tsconfig');
  refuse('{"extends":"./missing.json"}', 'not a tracked file');
  refuse('{"extends":5}', 'not a path');
  refuse('{"extends":"/etc/tsconfig.json"}', 'absolute path or a workspace package');
  refuse('{"extends":"@rasta/contracts/tsconfig.json"}', 'absolute path or a workspace package');
  refuse('{"include":["/abs/**"]}', 'not a relative path');
  refuse('{"include":["${configDir}/x"]}', 'not a relative path');
  refuse('{"include":["../../../outside/**"]}', 'outside the repository');
  refuse('{"include":[5]}', 'not a relative path');
  refuse('{"references":[{"path":"/abs"}]}', 'not a relative path');
  refuse('{"compilerOptions":{"typeRoots":["../../../x"]}}', 'outside the repository');
  // a registry package to extend is not a local source
  assert.deepEqual(
    surface({ ...base, 'apps/web/tsconfig.json': '{"extends":"@tsconfig/node20/tsconfig.json"}' })
      .problems,
    [],
  );
  // a cycle terminates
  assert.deepEqual(
    keys({
      'apps/web/tsconfig.test.json': '{"extends":"./tsconfig.json"}',
      'apps/web/tsconfig.json': '{"extends":"./tsconfig.test.json"}',
    }),
    ['apps/web/tsconfig.json', 'apps/web/tsconfig.test.json'],
  );
  // no tsconfig: nothing is read
  assert.deepEqual(keys(base), []);
});

// Mutants on the real repository: each takes one real thing away and the exception check must fail.
test('mutant: removing any one exception fails naming the module and the built-in', () => {
  const state = realState();
  for (const path of BUILTIN_READERS.keys()) {
    const exceptions = new Map([...BUILTIN_READERS].filter(([key]) => key !== path));
    const problems = discover({ ...state, exceptions }).problems;
    assert.ok(
      problems.some(
        (p) => p.startsWith(`${path} loads the built-in`) && p.includes('BUILTIN_READERS'),
      ),
      `${path}: ${fail(problems)}`,
    );
  }
});

test('mutant: a new module that loads fs from a real rule is rejected until it is listed', () => {
  const state = realState();
  const added = {
    'scripts/new-reader.mjs': () =>
      "import { readFileSync } from 'node:fs';\nexport default readFileSync;\n",
    'scripts/no-zod-default-rule.mjs': (text) => `import './new-reader.mjs';\n${text}`,
  };
  const tracked = new Set([...state.tracked, 'scripts/new-reader.mjs']);
  const mutated = { ...withText(state, added), tracked };
  const problems = discover(mutated).problems;
  assert.ok(
    problems.some((p) => p.startsWith('scripts/new-reader.mjs loads the built-in')),
    fail(problems),
  );
  // the same module, listed with a surface, then passes discovery
  const listed = new Map([
    ...BUILTIN_READERS,
    ['scripts/new-reader.mjs', reader({ reads: [{ surface: 'location-only', why: 'x' }] })],
  ]);
  assert.deepEqual(discover({ ...mutated, exceptions: listed }).problems, []);
  // an excepted module is only excepted for its own path: a copy under another name is not
  const copy = { ...mutated, tracked: new Set([...tracked, 'scripts/copy-of-parser.mjs']) };
  const renamed = withText(copy, {
    'scripts/copy-of-parser.mjs': () => state.read('scripts/internal-token-parser.mjs'),
    'scripts/new-reader.mjs': () => "import './copy-of-parser.mjs';\nexport default 1;\n",
    'scripts/no-zod-default-rule.mjs': (text) => `import './new-reader.mjs';\n${text}`,
  });
  assert.ok(
    discover({ ...renamed, tracked: copy.tracked }).problems.some((p) =>
      p.startsWith('scripts/copy-of-parser.mjs loads the built-in'),
    ),
  );
});

test('mutant: the real excepted modules cannot grow a new member, lose one, or widen their exports', () => {
  const state = realState();
  const edit = (file, from, to) => {
    const text = state.read(file);
    assert.ok(text.includes(from), `${file} no longer contains ${from}`);
    return discover(withText(state, { [file]: () => text.replace(from, to) })).problems;
  };
  const parser = 'scripts/internal-token-parser.mjs';
  const rule = 'scripts/internal-token-source-rule.mjs';
  const dev = 'scripts/testing-dev-only.mjs';
  const has = (problems, file, needle) =>
    problems.some((p) => p.startsWith(`${file} `) && p.includes(needle));
  assert.ok(
    has(
      edit(parser, "import fs from 'node:fs';", "import fs from 'node:fs';\nfs.readdirSync('.');"),
      parser,
      'uses `fs.readdirSync`',
    ),
  );
  assert.ok(
    has(
      edit(parser, "fs.readFileSync(options.filePath, 'utf8') !== code", 'false'),
      parser,
      'no longer uses `fs.readFileSync`',
    ),
  );
  assert.ok(
    has(
      edit(rule, 'fs.realpathSync(REPO_ROOT)', 'fs.readFileSync(REPO_ROOT)'),
      rule,
      'uses `fs.readFileSync`',
    ),
  );
  assert.ok(
    has(
      edit(rule, 'fs.realpathSync(REPO_ROOT)', 'Object.assign({}, fs)'),
      rule,
      'other than by static import',
    ),
  );
  assert.ok(
    has(
      edit(
        dev,
        "import { tmpdir } from 'node:os';",
        "import { tmpdir, homedir } from 'node:os';\nhomedir();",
      ),
      dev,
      'uses `os.homedir`',
    ),
  );
  assert.ok(
    has(
      edit(
        rule,
        "import { REPO_ROOT } from './testing-dev-only.mjs';",
        "import { REPO_ROOT, checkImage } from './testing-dev-only.mjs';\ncheckImage;",
      ),
      rule,
      'allows a lint-time importer only `REPO_ROOT`',
    ),
  );
  assert.ok(
    edit(
      rule,
      "import { REPO_ROOT } from './testing-dev-only.mjs';",
      "import * as dev from './testing-dev-only.mjs';\nconst REPO_ROOT = dev.REPO_ROOT;",
    ).some((p) => p.includes('allows a lint-time importer only `REPO_ROOT`')),
  );
});

test('mutant: a real excepted module’s read surface that turbo stops hashing fails naming it', async () => {
  const state = realState();
  const found = discover(state);
  const run = async (change) => inputProblems({ ...state, hashed: await mutatedSnapshot(change) });
  // the default inputs carry the linted files, the manifests and the tsconfigs of every workspace
  const noDefault = await run((doc) => {
    doc.tasks.lint.inputs = doc.tasks.lint.inputs.filter((i) => i !== '$TURBO_DEFAULT$');
  });
  for (const path of [
    'scripts/internal-token-parser.mjs',
    'scripts/internal-token-source-rule.mjs',
  ]) {
    assert.ok(
      noDefault.some((p) => p.startsWith(`${path} reads the \`linted-files\` surface`)),
      `${path}: ${fail(noDefault)}`,
    );
  }
  assert.ok(
    noDefault.some((p) =>
      p.startsWith('scripts/internal-token-parser.mjs reads the `typescript-project`'),
    ),
  );
  // tsconfig.base.json is a global dependency: the extends chain of every workspace reaches it
  const noBase = await run((doc) => {
    doc.globalDependencies = doc.globalDependencies.filter((f) => f !== 'tsconfig.base.json');
  });
  const baseProblems = noBase.filter(
    (p) =>
      p.startsWith('scripts/internal-token-parser.mjs reads the `typescript-project`') &&
      p.includes('tsconfig.base.json'),
  );
  assert.equal(baseProblems.length, found.workspaces.length, fail(noBase));
  // the type declarations come from dependency builds, hashed through `^build`
  const noBuild = await run((doc) => {
    doc.tasks.lint.dependsOn = [];
  });
  assert.ok(
    noBuild.some((p) => p.startsWith('scripts/internal-token-parser.mjs reads dependency-builds')),
    fail(noBuild),
  );
  // a stale entry (a tracked module nothing loads) is found by the exact-list check
  const stale = new Map([
    ...BUILTIN_READERS,
    ['scripts/check-compose-ports-lib.mjs', reader({ builtins: { fs: ['readFileSync'] } })],
  ]);
  assert.deepEqual(staleExceptions(discover({ ...state, exceptions: stale })), [
    'scripts/check-compose-ports-lib.mjs',
  ]);
});
