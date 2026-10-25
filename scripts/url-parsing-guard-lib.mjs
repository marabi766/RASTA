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
// `new url.URL(…)`, `new globalThis['URL'](…)`), `URL.parse(…)`,
// `URL.canParse(…)` (also `URL['parse'](…)`), and the legacy `url.parse(…)` of
// `node:url` — imported by name (aliased or not), as a namespace or default,
// `require`d or dynamically imported, destructured or not. A parse is raw
// unless every argument is a string literal, a template without
// substitutions, or `import.meta.url`. Any other way to get hold of a parser —
// an alias (`const U = URL`, `const parse = URL.parse`), an argument, a
// subclass, a re-export, a computed member the parser cannot read
// (`URL[name]`, `globalThis[name]`), an unbound `import('url')` — is an
// `escape` site, refused like a raw parse (#385 r6, Codex PR-385 r5 F2).
// Read with the TypeScript parser, so a comment or a string that spells
// `new URL(` is not a site, and a call split over lines is.
//
// The command-line half (`commandLineSurface`, `namesCredential`) feeds the
// explicit contract in cli-contract.mjs.
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

/** The static methods of `URL` that parse their argument. */
const PARSE_METHODS = new Set(['parse', 'canParse']);

/** Objects a computed access on could yield `URL` (`globalThis[name]`). */
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global']);

const isImportMetaUrl = (node) =>
  ts.isPropertyAccessExpression(node) &&
  ts.isMetaProperty(node.expression) &&
  node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
  node.name.text === 'url';

/** A literal argument cannot carry configuration. */
const isLiteral = (node) =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || isImportMetaUrl(node);

const isStringLike = (node) => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

/** Parentheses and type assertions around an expression, removed. */
function unwrap(node) {
  let inner = node;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isTypeAssertionExpression(inner) ||
    (ts.isSatisfiesExpression && ts.isSatisfiesExpression(inner))
  ) {
    inner = inner.expression;
  }
  return inner;
}

/**
 * The member a property or element access reads: its name, the literal of a
 * computed access (`URL['parse']`), or null for a computed access the parser
 * cannot read (`URL[name]`).
 */
function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const argument = unwrap(node.argumentExpression);
  return isStringLike(argument) ? argument.text : null;
}

const isMemberAccess = (node) =>
  ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);

/** `require('url')`, `import('node:url')`: the module, loaded as a value. */
function isUrlModuleLoad(node) {
  const call = unwrap(node);
  if (!ts.isCallExpression(call) || call.arguments.length !== 1) return false;
  const [argument] = call.arguments;
  if (!isStringLike(argument) || !URL_MODULES.has(argument.text)) return false;
  return (
    call.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(call.expression) && call.expression.text === 'require')
  );
}

/** `require('url')` or `await import('url')`, as a declaration's initializer binds it. */
function isBoundUrlModule(initializer) {
  const value = unwrap(initializer);
  if (ts.isAwaitExpression(value)) return isUrlModuleLoad(value.expression);
  return (
    isUrlModuleLoad(value) &&
    ts.isCallExpression(value) &&
    ts.isIdentifier(value.expression) &&
    value.expression.text === 'require'
  );
}

/**
 * Every name `sourceFile` binds to a parser, resolved through the forms that
 * cannot hide one (#385 r6, Codex PR-385 r5 F2):
 *
 *   classes  `URL`, `import { URL as U } from 'node:url'`, any `{ URL: U }`
 *            destructuring (`= require('node:url')`, `= await import('url')`,
 *            `= globalThis`);
 *   parses   `node:url`'s legacy `parse` imported or destructured by name
 *            (aliased or not), and `{ parse: p } = URL`;
 *   modules  `node:url` as a default, namespace or `import u = require(…)`
 *            import, or bound from `require('url')` / `await import('url')`.
 *
 * Every other way to get hold of a parser — `const U = URL`,
 * `const parse = URL.parse`, `foo(URL)`, `URL[name]`, `import('url').then(…)`,
 * `class X extends URL` — is not followed but refused where it stands
 * ({@link parserEscapes}).
 */
function parserBindings(sourceFile) {
  const classes = new Set(['URL']);
  const parses = new Set();
  const modules = new Set();
  const destructured = (pattern, from) => {
    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
      const imported = element.propertyName ?? element.name;
      const name = ts.isIdentifier(imported) || isStringLike(imported) ? imported.text : null;
      if (name === 'URL') classes.add(element.name.text);
      else if (name === 'parse' && from === 'module') parses.add(element.name.text);
      else if (name !== null && PARSE_METHODS.has(name) && from === 'class') {
        parses.add(element.name.text);
      }
    }
  };
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      isStringLike(node.moduleSpecifier) &&
      URL_MODULES.has(node.moduleSpecifier.text) &&
      node.importClause
    ) {
      const { name, namedBindings } = node.importClause;
      if (name) modules.add(name.text);
      if (namedBindings && ts.isNamespaceImport(namedBindings))
        modules.add(namedBindings.name.text);
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (imported === 'parse') parses.add(element.name.text);
          if (imported === 'URL') classes.add(element.name.text);
        }
      }
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isStringLike(node.moduleReference.expression) &&
      URL_MODULES.has(node.moduleReference.expression.text)
    ) {
      modules.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const value = unwrap(node.initializer);
      const from = isBoundUrlModule(node.initializer)
        ? 'module'
        : ts.isIdentifier(value) && classes.has(value.text)
          ? 'class'
          : ts.isIdentifier(value) && modules.has(value.text)
            ? 'module'
            : 'other';
      if (ts.isIdentifier(node.name) && from === 'module' && isBoundUrlModule(node.initializer)) {
        modules.add(node.name.text);
      }
      if (ts.isObjectBindingPattern(node.name)) destructured(node.name, from);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { classes, parses, modules };
}

/** What `node` refers to, as far as parsers go: 'class', 'parse', 'module' or null. */
function parserReference(node, bindings) {
  const inner = unwrap(node);
  if (ts.isIdentifier(inner)) {
    if (bindings.classes.has(inner.text)) return 'class';
    if (bindings.parses.has(inner.text)) return 'parse';
    if (bindings.modules.has(inner.text)) return 'module';
    return null;
  }
  if (isUrlModuleLoad(inner)) return 'module';
  if (ts.isAwaitExpression(inner) && isUrlModuleLoad(inner.expression)) return 'module';
  if (isMemberAccess(inner)) {
    const name = memberName(inner);
    if (name === 'URL') return 'class';
    const object = parserReference(inner.expression, bindings);
    if (name !== null && PARSE_METHODS.has(name) && object === 'class') return 'parse';
    if (name === 'parse' && object === 'module') return 'parse';
  }
  return null;
}

/** An identifier that names a declaration or a property, not a value. */
function isDeclarationName(node) {
  const { parent } = node;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    ((ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassExpression(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessor(parent) ||
      ts.isSetAccessor(parent)) &&
      parent.name === node) ||
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportEqualsDeclaration(parent) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    ts.isLabeledStatement(parent) ||
    ts.isBreakOrContinueStatement(parent)
  );
}

/** The expression `node` stands in as its parent sees it (through parentheses and casts). */
function outermost(node) {
  let current = node;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      (ts.isSatisfiesExpression && ts.isSatisfiesExpression(current.parent)))
  ) {
    current = current.parent;
  }
  return current;
}

/**
 * Whether a parser reference stays where a reader of the source can see what
 * it does: a class constructed or tested (`new URL(…)`, `x instanceof URL`,
 * `typeof URL`) or one of its other members read (`URL.createObjectURL`); a
 * parse method called; a module bound by name, or one of its members read.
 * Anything else lets the parser travel — an alias, an argument, a returned or
 * exported value, a subclass, a computed member — and is an escape.
 */
function staysInPlace(reference, kind) {
  const node = outermost(reference);
  const { parent } = node;
  if (ts.isTypeOfExpression(parent)) return true;
  if (kind === 'parse') return ts.isCallExpression(parent) && parent.expression === node;
  if (kind === 'class') {
    if (ts.isNewExpression(parent) && parent.expression === node) return true;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      parent.right === node
    ) {
      return true;
    }
    if (isMemberAccess(parent) && parent.expression === node) {
      // A member the parser can read: another method, or a parse method, which
      // is then a reference of its own.
      return memberName(parent) !== null;
    }
    return false;
  }
  // A module: bound by a declaration, or a member of it read by a name the
  // parser can read. `import('url')` itself only through `await`, so a
  // `.then(m => …)` callback's `m` cannot carry it unseen.
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
    return isBoundUrlModule(node);
  }
  if (ts.isAwaitExpression(parent)) {
    const bound = outermost(parent);
    return (
      (ts.isVariableDeclaration(bound.parent) && bound.parent.initializer === bound) ||
      (isMemberAccess(bound.parent) &&
        bound.parent.expression === bound &&
        memberName(bound.parent) !== null)
    );
  }
  if (isMemberAccess(parent) && parent.expression === node) {
    if (memberName(parent) === null) return false;
    return (
      !isUrlModuleLoad(node) ||
      !ts.isCallExpression(unwrap(node)) ||
      unwrap(node).expression.kind !== ts.SyntaxKind.ImportKeyword
    );
  }
  return false;
}

/** A node inside a type: annotations, `typeof URL` types, interfaces. A class's `extends` is not one. */
function isInType(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isExpressionWithTypeArguments(current)) {
      const clause = current.parent;
      if (
        ts.isHeritageClause(clause) &&
        clause.token === ts.SyntaxKind.ExtendsKeyword &&
        (ts.isClassDeclaration(clause.parent) || ts.isClassExpression(clause.parent))
      ) {
        return false;
      }
      return true;
    }
    if (
      ts.isTypeNode(current) ||
      ts.isInterfaceDeclaration(current) ||
      ts.isTypeAliasDeclaration(current)
    ) {
      return true;
    }
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

/** What kind of parse `node` is, or null when it is none. */
function parseKind(node, bindings) {
  if (ts.isNewExpression(node) && parserReference(node.expression, bindings) === 'class') {
    return 'new URL';
  }
  if (!ts.isCallExpression(node) || parserReference(node.expression, bindings) !== 'parse') {
    return null;
  }
  const callee = unwrap(node.expression);
  if (isMemberAccess(callee) && parserReference(callee.expression, bindings) === 'class') {
    return `URL.${memberName(callee)}`;
  }
  return 'url.parse';
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
  const bindings = parserBindings(sourceFile);
  const found = [];
  const seen = new Set();
  const site = (node, what) => {
    // One site per expression, however many rules it breaks.
    if (seen.has(node)) return;
    seen.add(node);
    found.push({
      file,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      kind: what,
      call: normalizeCall(node.getText(sourceFile)),
    });
  };
  const visit = (node) => {
    const what = parseKind(node, bindings);
    if (what !== null && !(node.arguments ?? []).every(isLiteral)) site(node, what);
    const reference =
      (ts.isIdentifier(node) && !isDeclarationName(node)) ||
      isMemberAccess(node) ||
      ts.isCallExpression(node)
        ? parserReference(node, bindings)
        : null;
    // A reference is judged where it is outermost: `URL.parse` is one
    // reference, not also its `URL`.
    const partOfLarger =
      reference !== null &&
      isMemberAccess(outermost(node).parent) &&
      outermost(node).parent.expression === outermost(node) &&
      parserReference(outermost(node).parent, bindings) !== null;
    if (reference !== null && !partOfLarger && !isInType(node) && !staysInPlace(node, reference)) {
      site(outermost(node).parent ?? node, 'escape');
    }
    // A re-export hands a parser to another file under any name: refused here.
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      isStringLike(node.moduleSpecifier) &&
      URL_MODULES.has(node.moduleSpecifier.text) &&
      (!node.exportClause ||
        !ts.isNamedExports(node.exportClause) ||
        node.exportClause.elements.some((element) =>
          ['parse', 'URL'].includes((element.propertyName ?? element.name).text),
        ))
    ) {
      site(node, 'escape');
    }
    // A computed access on a parser, or on a global object, the parser cannot read.
    if (ts.isElementAccessExpression(node) && memberName(node) === null && !isInType(node)) {
      const object = unwrap(node.expression);
      if (
        parserReference(object, bindings) !== null ||
        (ts.isIdentifier(object) && GLOBAL_OBJECTS.has(object.text))
      ) {
        site(node, 'escape');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Test files, by name only: `*.spec.*`, `*.test.*`, `*.int-spec.*`,
 * `*.e2e-spec.*`. Not scanned — they run on CI's disposable credentials, fixed
 * by the workflow, and what they print is the test report (the class
 * boundary, #385 r5). Everything else is scanned, test helpers and fixtures
 * included, wherever they live — `__tests__/` too (#385 r6).
 */
export const isTestFile = (file) => /\.(spec|test|int-spec|e2e-spec)\.[cm]?[jt]sx?$/.test(file);

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
 * A string literal spelled like a command-line option, long or short:
 * `--schema`, `--max=3`, `-X`, `-tA`. Its option is the part before any `=`.
 */
const OPTION_LITERAL = /^--?[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*(?:=[\s\S]*)?$/;

/** Whether `node` is `process.argv`, or a call of node:util's `parseArgs`. */
function readsCommandLine(node, utilParseArgs) {
  if (
    isMemberAccess(node) &&
    memberName(node) === 'argv' &&
    ts.isIdentifier(unwrap(node.expression)) &&
    unwrap(node.expression).text === 'process'
  ) {
    return true;
  }
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    utilParseArgs.has(node.expression.text)
  );
}

/**
 * The command-line surface of a file (#385 r6, Codex PR-385 r5 F2): whether
 * it reads its own command line (`process.argv`, or `parseArgs` of
 * `node:util`), and every option it spells — each string literal shaped like
 * one, and each key of a `parseArgs` `options` object. Matched against the
 * explicit contract in cli-contract.mjs, which says per file which of them it
 * accepts, and what value each takes.
 */
export function commandLineSurface(text, file) {
  const kind = SCRIPT_KINDS[extname(file)] ?? ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const utilParseArgs = new Set();
  let readsArgv = false;
  const options = new Set();
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      isStringLike(node.moduleSpecifier) &&
      ['util', 'node:util'].includes(node.moduleSpecifier.text) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        if ((element.propertyName ?? element.name).text === 'parseArgs') {
          utilParseArgs.add(element.name.text);
        }
      }
    }
    if (readsCommandLine(node, utilParseArgs)) {
      readsArgv = true;
      // A parseArgs call's options are its accepted options, keys spelled bare.
      const [config] = ts.isCallExpression(node) ? node.arguments : [];
      if (config && ts.isObjectLiteralExpression(config)) {
        for (const property of config.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            property.name.getText(sourceFile) === 'options' &&
            ts.isObjectLiteralExpression(property.initializer)
          ) {
            for (const option of property.initializer.properties) {
              const name =
                option.name && (ts.isIdentifier(option.name) || isStringLike(option.name))
                  ? option.name.text
                  : null;
              if (name !== null) options.add(`--${name}`);
            }
          }
        }
      }
    }
    if (isStringLike(node) && OPTION_LITERAL.test(node.text)) {
      options.add(node.text.split('=')[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { readsArgv, options: [...options].sort() };
}

/**
 * An option whose name says it takes a credential, a URL or where to connect.
 * Words are split at `-`, `_`, `.` and camelCase humps (`--apiKey`,
 * `--databaseUrl`, `--api-key`, `--endpoint`), and each is compared whole, so
 * `--security-opt` and `--with-database` are not one. A backstop under the
 * contract: no option it names may be accepted at all.
 */
const CREDENTIAL_WORDS = new Set([
  'url',
  'uri',
  'dsn',
  'password',
  'passwd',
  'pass',
  'pwd',
  'secret',
  'token',
  'credential',
  'credentials',
  'connection',
  'key',
  'apikey',
  'auth',
  'endpoint',
  'host',
  'broker',
  'brokers',
  'cert',
  'certificate',
]);

/** The words of an option's name, lower-cased. */
export const optionWords = (option) =>
  option
    .replace(/^-+/, '')
    .split('=')[0]
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split(/[-_.]+/)
    .filter(Boolean);

/** Whether `option`'s name says it takes a credential or a URL. */
export const namesCredential = (option) =>
  optionWords(option).some((word) => CREDENTIAL_WORDS.has(word));

/**
 * What breaks the command-line contract (cli-contract.mjs), given every
 * scanned file's surface (`file -> commandLineSurface`): a file not listed,
 * an option spelled but not listed or listed but not spelled, an argv reader
 * whose positionals are not stated, an accepted option or positional of a
 * kind outside `kinds`, an accepted option named like a credential, and an
 * option passed on whose credential-like name has no stated reason.
 */
export function contractProblems(surfaces, contract, kinds, namedLikeCredentials) {
  const problems = [];
  for (const [file, surface] of surfaces) {
    const entry = Object.hasOwn(contract, file) ? contract[file] : undefined;
    if (!entry) {
      problems.push(`${file}: not in the contract (${surface.options.join(' ') || 'argv'})`);
      continue;
    }
    const listed = [...Object.keys(entry.accepts ?? {}), ...(entry.other ?? [])];
    const unlisted = surface.options.filter((option) => !listed.includes(option));
    const stale = listed.filter((option) => !surface.options.includes(option));
    if (unlisted.length > 0)
      problems.push(`${file}: spells ${unlisted.join(' ')}, not in its entry`);
    if (stale.length > 0) problems.push(`${file}: its entry lists ${stale.join(' ')}, not spelled`);
    if (surface.readsArgv && !entry.positionals) {
      problems.push(`${file}: reads its command line; its entry must say its positionals`);
    }
  }
  for (const [file, entry] of Object.entries(contract)) {
    if (!surfaces.has(file)) {
      problems.push(`${file}: listed, but neither reads argv nor spells an option`);
    }
    for (const [option, kind] of Object.entries(entry.accepts ?? {})) {
      if (!Object.hasOwn(kinds, kind)) problems.push(`${file}: ${option} takes "${kind}"`);
      if (namesCredential(option)) problems.push(`${file}: accepts ${option}`);
    }
    for (const kind of entry.positionals ?? []) {
      if (!Object.hasOwn(kinds, kind)) problems.push(`${file}: a positional takes "${kind}"`);
    }
    for (const option of entry.other ?? []) {
      if (namesCredential(option) && !Object.hasOwn(namedLikeCredentials, option)) {
        problems.push(`${file}: passes ${option}; say why it is not a credential`);
      }
    }
  }
  return problems;
}
