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
import ts from 'typescript';
import { extname, join, relative } from 'node:path';

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
const DYNAMIC_CAPABILITIES = new Set(['unsafe', 'createRequire', 'getBuiltinModule']);

const isImportMetaUrl = (node) =>
  ts.isPropertyAccessExpression(node) &&
  ts.isMetaProperty(node.expression) &&
  node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
  node.name.text === 'url';

/**
 * A literal argument cannot carry configuration: a string literal, a template
 * without substitutions, `import.meta.url`, or a name in `literalUrls`.
 */
const isLiteral = (node, literalUrls = new Set()) =>
  ts.isStringLiteral(node) ||
  ts.isNoSubstitutionTemplateLiteral(node) ||
  isImportMetaUrl(node) ||
  (ts.isIdentifier(unwrap(node)) && literalUrls.has(unwrap(node).text));

/**
 * The names a file binds, once and with `const`, to a URL built from literals
 * only (`const lib = new URL('../lib/', import.meta.url)`): a repository
 * path, which a parse against it cannot turn into configuration. A name bound
 * more than once anywhere in the file (another `const`, a `let`, a parameter)
 * is not one, whatever the scope: the guard does not resolve scopes.
 */
function literalUrlNames(sourceFile, bindings) {
  const declared = new Map();
  const count = (name) => declared.set(name, (declared.get(name) ?? 0) + 1);
  const candidates = [];
  const visit = (node) => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      ts.isIdentifier(node.name)
    ) {
      count(node.name.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      candidates.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const literalUrls = new Set();
  // In source order, so a URL built on an earlier one is seen.
  for (const declaration of candidates) {
    const value = unwrap(declaration.initializer);
    if (
      declared.get(declaration.name.text) === 1 &&
      ts.isNewExpression(value) &&
      parserReference(value.expression, bindings) === 'class' &&
      (value.arguments ?? []).length > 0 &&
      value.arguments.every((argument) => isLiteral(argument, literalUrls))
    ) {
      literalUrls.add(declaration.name.text);
    }
  }
  return literalUrls;
}

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
 * Resolve lexical symbols without loading dependencies or ambient libraries.
 * Unknown local bindings shadow globals only in their own scope. Aliases and
 * binding patterns are followed, but their escape sites are still refused.
 */
function parserBindings(sourceFile) {
  const host = ts.createCompilerHost({});
  host.getSourceFile = (file) => (file === sourceFile.fileName ? sourceFile : undefined);
  const checker = ts
    .createProgram([sourceFile.fileName], { noLib: true, noResolve: true, allowJs: true }, host)
    .getTypeChecker();
  const active = new Set();
  const moduleKind = (name) => {
    if (URL_MODULES.has(name)) return 'module';
    if (['vm', 'node:vm'].includes(name)) return 'unsafe';
    if (['module', 'node:module'].includes(name)) return 'loaderModule';
    if (['process', 'node:process'].includes(name)) return 'process';
    if (['util', 'node:util'].includes(name)) return 'util';
    return null;
  };
  const member = (object, name) => {
    if (object === 'global') {
      if (name === 'URL') return 'class';
      if (GLOBAL_OBJECTS.has(name)) return 'global';
      if (['eval', 'Function'].includes(name)) return 'unsafe';
      if (name === 'process') return 'process';
    }
    if (object === 'module' && name === 'URL') return 'class';
    if (object === 'class' && PARSE_METHODS.has(name)) return 'parse';
    if (object === 'module' && name === 'parse') return 'parse';
    if (object === 'class' && name === 'prototype') return 'prototype';
    if (['prototype', 'instance'].includes(object) && name === 'constructor') return 'class';
    if (object === 'loaderModule' && name === 'createRequire') return 'createRequire';
    if (object === 'process' && name === 'getBuiltinModule') return 'getBuiltinModule';
    if (object === 'process' && name === 'argv') return 'argv';
    if (object === 'util' && name === 'parseArgs') return 'parseArgs';
    return null;
  };
  const declarationReference = (declaration) => {
    if (ts.isVariableDeclaration(declaration)) {
      return declaration.initializer ? reference(declaration.initializer) : null;
    }
    if (ts.isBindingElement(declaration)) {
      const pattern = declaration.parent;
      const owner = pattern.parent;
      const from = ts.isBindingElement(owner)
        ? declarationReference(owner)
        : owner.initializer
          ? reference(owner.initializer)
          : null;
      const key = declaration.propertyName ?? declaration.name;
      const name = ts.isComputedPropertyName(key)
        ? isStringLike(unwrap(key.expression))
          ? unwrap(key.expression).text
          : null
        : ts.isIdentifier(key) || isStringLike(key)
          ? key.text
          : null;
      return member(from, name);
    }
    if (ts.isImportSpecifier(declaration)) {
      const from = moduleKind(declaration.parent.parent.parent.moduleSpecifier.text);
      const name = (declaration.propertyName ?? declaration.name).text;
      return name === 'default' ? from : member(from, name);
    }
    if (ts.isNamespaceImport(declaration) || ts.isImportClause(declaration)) {
      const imported = ts.isNamespaceImport(declaration)
        ? declaration.parent.parent
        : declaration.parent;
      return moduleKind(imported.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(declaration)) {
      const specifier = declaration.moduleReference.expression;
      return specifier && isStringLike(specifier) ? moduleKind(specifier.text) : null;
    }
    return null;
  };
  const reference = (node) => {
    const inner = unwrap(node);
    if (ts.isIdentifier(inner)) {
      const symbol = checker.getSymbolAtLocation(inner);
      if (symbol?.declarations?.some((declaration) => !ts.isIdentifier(declaration))) {
        if (active.has(symbol)) return null;
        active.add(symbol);
        const result = (symbol.declarations ?? []).map(declarationReference).find(Boolean) ?? null;
        active.delete(symbol);
        return result;
      }
      if (inner.text === 'URL') return 'class';
      if (GLOBAL_OBJECTS.has(inner.text)) return 'global';
      if (['eval', 'Function'].includes(inner.text)) return 'unsafe';
      if (inner.text === 'process') return 'process';
      return null;
    }
    if (ts.isAwaitExpression(inner)) return reference(inner.expression);
    if (isMemberAccess(inner)) return member(reference(inner.expression), memberName(inner));
    if (isUrlModuleLoad(inner)) return 'module';
    if (ts.isCallExpression(inner)) {
      const callee = reference(inner.expression);
      if (callee === 'createRequire') return 'loader';
      if (
        ['loader', 'getBuiltinModule'].includes(callee) &&
        inner.arguments.length === 1 &&
        isStringLike(inner.arguments[0])
      )
        return moduleKind(inner.arguments[0].text);
    }
    if (
      ts.isCallExpression(inner) &&
      inner.arguments.length === 1 &&
      isStringLike(inner.arguments[0])
    ) {
      if (
        inner.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(inner.expression) && inner.expression.text === 'require')
      ) {
        return moduleKind(inner.arguments[0].text);
      }
    }
    if (ts.isNewExpression(inner) && reference(inner.expression) === 'class') return 'instance';
    return null;
  };
  return { reference };
}

/** Native parser capabilities, including global objects that can hand them out. */
function parserReference(node, bindings) {
  const kind = bindings.reference(node);
  return ['class', 'parse', 'module', 'global', 'prototype'].includes(kind) ? kind : null;
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
  if (kind === 'global' || kind === 'prototype') {
    return isMemberAccess(parent) && parent.expression === node && memberName(parent) !== null;
  }
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
  const literalUrls = literalUrlNames(sourceFile, bindings);
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
    // Refuse dynamic execution/loaders themselves, even without URL text.
    // A reviewed exemption covers this expression only; scanning continues.
    if (
      !isInType(node) &&
      ((ts.isIdentifier(node) && !isDeclarationName(node)) || isMemberAccess(node)) &&
      DYNAMIC_CAPABILITIES.has(bindings.reference(node))
    ) {
      const expression = outermost(node);
      site(
        expression.parent &&
          (ts.isCallExpression(expression.parent) || ts.isNewExpression(expression.parent))
          ? expression.parent
          : expression,
        'dynamic code/loader',
      );
    }
    if (ts.isCallExpression(node) && DYNAMIC_CAPABILITIES.has(bindings.reference(node)))
      site(node, 'dynamic code/loader');
    if (
      ts.isImportDeclaration(node) &&
      isStringLike(node.moduleSpecifier) &&
      ['vm', 'node:vm'].includes(node.moduleSpecifier.text)
    )
      site(node, 'dynamic code/loader');
    if (
      ts.isBinaryExpression(node) &&
      ts.isAssignmentOperator(node.operatorToken.kind) &&
      isMemberAccess(unwrap(node.left)) &&
      bindings.reference(unwrap(node.left).expression) === 'instance' &&
      !isLiteral(node.right)
    )
      site(node, 'URL mutation');
    const what = parseKind(node, bindings);
    if (
      what !== null &&
      !(node.arguments ?? []).every((argument) => isLiteral(argument, literalUrls))
    ) {
      site(node, what);
    }
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
    // Loader/vm re-exports would move the refused capability into another file.
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      isStringLike(node.moduleSpecifier) &&
      ['module', 'node:module', 'process', 'node:process', 'vm', 'node:vm'].includes(
        node.moduleSpecifier.text,
      ) &&
      (!node.exportClause ||
        !ts.isNamedExports(node.exportClause) ||
        node.exportClause.elements.some((element) =>
          ['default', 'createRequire', 'getBuiltinModule'].includes(
            (element.propertyName ?? element.name).text,
          ),
        ) ||
        ['vm', 'node:vm'].includes(node.moduleSpecifier.text))
    )
      site(node, 'dynamic code/loader');
    // A re-export hands a parser to another file under any name: refused here.
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      isStringLike(node.moduleSpecifier) &&
      URL_MODULES.has(node.moduleSpecifier.text) &&
      (!node.exportClause ||
        !ts.isNamedExports(node.exportClause) ||
        node.exportClause.elements.some((element) =>
          ['parse', 'URL', 'default'].includes((element.propertyName ?? element.name).text),
        ))
    ) {
      site(node, 'escape');
    }
    // A computed access on a parser, or on a global object, the parser cannot read.
    if (ts.isElementAccessExpression(node) && memberName(node) === null && !isInType(node)) {
      const object = unwrap(node.expression);
      if (parserReference(object, bindings) !== null) {
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

/** Every raw parse in the scanned trees under `root`, test files left out. */
export function repositoryUrlParses(root) {
  return sourceFiles(root)
    .filter((file) => !isTestFile(file))
    .flatMap((file) => {
      const text = readFileSync(join(root, file), 'utf8');
      return rawUrlParses(text, file);
    });
}

/**
 * The sites `allowList` does not cover, and the entries that cover no site
 * (stale: the code moved or was fixed, so the entry must go). An entry is
 * `{ file, call, reason, line? }`; an expression must match exactly one site.
 * Repeated expressions need a line. Duplicate/stale entries never grant access.
 */
export function unlistedUrlParses(sites, allowList) {
  const remaining = new Set(sites);
  const stale = [];
  for (const entry of allowList) {
    const matches = [...remaining].filter(
      (site) =>
        site.file === entry.file &&
        normalizeCall(site.call) === normalizeCall(entry.call) &&
        (entry.line === undefined || site.line === entry.line),
    );
    if (matches.length === 1 && typeof entry.reason === 'string' && entry.reason.trim()) {
      remaining.delete(matches[0]);
    } else stale.push(entry);
  }
  return { unlisted: [...remaining], stale };
}

/**
 * A string literal spelled like a command-line option, long or short:
 * `--schema`, `--max=3`, `-X`, `-tA`. Its option is the part before any `=`.
 */
const OPTION_LITERAL = /^--?[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*(?:=[\s\S]*)?$/;

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
  const bindings = parserBindings(sourceFile);
  let readsArgv = false;
  const options = new Set();
  const visit = (node) => {
    if (
      (((ts.isIdentifier(node) && !isDeclarationName(node)) || isMemberAccess(node)) &&
        bindings.reference(node) === 'argv') ||
      (ts.isCallExpression(node) && bindings.reference(node.expression) === 'parseArgs')
    ) {
      readsArgv = true;
      // A parseArgs call's options are its accepted options, keys spelled bare.
      const [config] = ts.isCallExpression(node) ? node.arguments : [];
      if (config && ts.isObjectLiteralExpression(config)) {
        for (const property of config.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) || isStringLike(property.name)) &&
            property.name.text === 'options' &&
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
