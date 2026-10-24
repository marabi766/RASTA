// -----------------------------------------------------------------------------
// Finds every native URL parse of a value that is not a literal (#385 r5).
//
// `new URL(value)` refuses with a TypeError that keeps the whole input on
// `.input` (and the base on `.base`); Node prints both for an uncaught throw,
// a database URL's password included. Configuration is parsed by
// `@rasta/config`'s reader instead (packages/config/src/url-reader.js), which
// refuses with a fixed text. `url-parsing-guard.test.mjs` runs this over the
// repository and fails on any site that is neither the reader nor allow-listed
// with a reason.
//
// What counts as a parse: `new URL(…)` (also `new globalThis.URL(…)`,
// `new url.URL(…)`), `URL.parse(…)`, `URL.canParse(…)`, and the legacy
// `url.parse(…)` of `node:url` — imported by name (aliased or not), as a
// namespace or default, or `require`d. A parse is raw unless every argument
// is a string literal, a template without substitutions, or `import.meta.url`.
// Read with the TypeScript parser, so a comment or a string that spells
// `new URL(` is not a site, and a call split over lines is.
// -----------------------------------------------------------------------------
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, relative } from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');

/** The trees scanned, relative to the repository root. */
export const SCANNED_TREES = Object.freeze(['scripts', 'packages', 'services', 'apps', 'tests']);

/** Directories never scanned: build output, installs, generated clients. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  'generated',
  'playwright-report',
  'test-results',
]);

const SCRIPT_KINDS = Object.freeze({
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
});

/** Every scanned source file under `root`, as repository-relative paths, sorted. */
export function sourceFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile() && SCRIPT_KINDS[extname(entry.name)] !== undefined) {
        if (!entry.name.endsWith('.d.ts')) found.push(relative(root, join(dir, entry.name)));
      }
    }
  };
  for (const tree of SCANNED_TREES) walk(join(root, tree));
  return found.sort();
}

const URL_MODULES = new Set(['url', 'node:url']);

/** `URL`, or any `<expression>.URL` (`globalThis.URL`, `url.URL`, `window.URL`). */
const isUrlClass = (node) =>
  (ts.isIdentifier(node) && node.text === 'URL') ||
  (ts.isPropertyAccessExpression(node) && node.name.text === 'URL');

const isImportMetaUrl = (node) =>
  ts.isPropertyAccessExpression(node) &&
  ts.isMetaProperty(node.expression) &&
  node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
  node.name.text === 'url';

/** A literal argument cannot carry configuration. */
const isLiteral = (node) =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || isImportMetaUrl(node);

/**
 * The names `source` binds to `node:url`'s legacy `parse` (`parse`, or an
 * alias) and to the module itself (a namespace, default or `require`).
 */
function urlModuleBindings(sourceFile) {
  const parse = new Set();
  const module = new Set();
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      URL_MODULES.has(node.moduleSpecifier.text) &&
      node.importClause
    ) {
      const { name, namedBindings } = node.importClause;
      if (name) module.add(name.text);
      if (namedBindings && ts.isNamespaceImport(namedBindings)) module.add(namedBindings.name.text);
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          if ((element.propertyName ?? element.name).text === 'parse') parse.add(element.name.text);
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'require' &&
      node.initializer.arguments.length === 1 &&
      ts.isStringLiteral(node.initializer.arguments[0]) &&
      URL_MODULES.has(node.initializer.arguments[0].text)
    ) {
      if (ts.isIdentifier(node.name)) module.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const imported = element.propertyName ?? element.name;
          if (
            ts.isIdentifier(imported) &&
            imported.text === 'parse' &&
            ts.isIdentifier(element.name)
          ) {
            parse.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { parse, module };
}

/** What kind of parse `node` is, or null when it is none. */
function parseKind(node, bindings) {
  if (ts.isNewExpression(node) && isUrlClass(node.expression)) return 'new URL';
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    const method = callee.name.text;
    if ((method === 'parse' || method === 'canParse') && isUrlClass(callee.expression)) {
      return `URL.${method}`;
    }
    if (
      method === 'parse' &&
      ts.isIdentifier(callee.expression) &&
      bindings.module.has(callee.expression.text)
    ) {
      return 'url.parse';
    }
  }
  if (ts.isIdentifier(callee) && bindings.parse.has(callee.text)) return 'url.parse';
  return null;
}

/** Whitespace collapsed, so an allow-list entry survives reformatting. */
export const normalizeCall = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * Every raw parse in `text` (a file at `file`): `{ file, line, kind, call }`,
 * `call` being the whole expression's source, whitespace collapsed.
 */
export function rawUrlParses(text, file) {
  const kind = SCRIPT_KINDS[extname(file)] ?? ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const bindings = urlModuleBindings(sourceFile);
  const found = [];
  const visit = (node) => {
    const what = parseKind(node, bindings);
    if (what !== null && !(node.arguments ?? []).every(isLiteral)) {
      found.push({
        file,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        kind: what,
        call: normalizeCall(node.getText(sourceFile)),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Test files: `*.spec.*`, `*.test.*`, `*.int-spec.*`, `*.e2e-spec.*` and
 * anything under `__tests__/`. Not scanned — they run on CI's disposable
 * credentials, fixed by the workflow, and what they print is the test report
 * (the class boundary, #385 r5). Test helpers beside them are scanned.
 */
export const isTestFile = (file) =>
  /\.(spec|test|int-spec|e2e-spec)\.[cm]?[jt]sx?$/.test(file) ||
  file.split('/').includes('__tests__');

/** A file that cannot hold a parse: spells neither `URL` nor the `url` module. */
const cannotParse = (text) => !text.includes('URL') && !/['"](node:)?url['"]/.test(text);

/** Every raw parse in the scanned trees under `root`, test files left out. */
export function repositoryUrlParses(root) {
  return sourceFiles(root)
    .filter((file) => !isTestFile(file))
    .flatMap((file) => {
      const text = readFileSync(join(root, file), 'utf8');
      return cannotParse(text) ? [] : rawUrlParses(text, file);
    });
}

/**
 * The sites `allowList` does not cover, and the entries that cover no site
 * (stale: the code moved or was fixed, so the entry must go). An entry is
 * `{ file, call, reason }`; it covers every site in `file` whose collapsed
 * source is `call`.
 */
export function unlistedUrlParses(sites, allowList) {
  const key = (file, call) => `${file}\n${normalizeCall(call)}`;
  const allowed = new Set(allowList.map((entry) => key(entry.file, entry.call)));
  const used = new Set();
  const unlisted = [];
  for (const site of sites) {
    const siteKey = key(site.file, site.call);
    if (allowed.has(siteKey)) used.add(siteKey);
    else unlisted.push(site);
  }
  const stale = allowList.filter((entry) => !used.has(key(entry.file, entry.call)));
  return { unlisted, stale };
}

/**
 * A command-line flag whose name says it takes a credential or a URL. None may
 * exist: configuration that carries a secret arrives through the environment,
 * which is what lets the scripts echo their arguments (#385 r5, the class
 * boundary). Matched on string literals that are a long option one of whose
 * dash-separated words is one of these (`--database-url`, `--password-stdin`;
 * not `--security-opt`).
 */
export const CREDENTIAL_FLAG =
  /^--(?:[a-z0-9]+-)*(?:url|uri|dsn|password|passwd|pass|secret|token|credentials?|connection)(?:-[a-z0-9]+)*(?:=.*)?$/i;

/** Every string literal in `text` that is a {@link CREDENTIAL_FLAG}: `{ file, line, flag }`. */
export function credentialFlags(text, file) {
  const kind = SCRIPT_KINDS[extname(file)] ?? ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const found = [];
  const visit = (node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      CREDENTIAL_FLAG.test(node.text)
    ) {
      found.push({
        file,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        flag: node.text,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
