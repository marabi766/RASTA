/**
 * Layer 1 of scripts/testing-dev-only.mjs: no production source file can
 * reach the test-only signer in @rasta/testing (PR #514 r2 F1). This checks
 * resolved targets, not how a specifier is spelled:
 *
 * - **Resolution.** Every module reference is resolved with TypeScript's own
 *   resolver (`ts.resolveModuleName`) under each tsconfig of the file's
 *   workspace that compiles it, so `paths` aliases (`@/*`), extensionless
 *   specifiers and index files resolve as the build resolves them; and under
 *   Node's rules (`NodeNext`, plus `createRequire().resolve` for `require`),
 *   which is what runs `.mjs`/`.cjs` and compiled output. A package's
 *   `exports` (and a file's `#imports`) are read too: every target of the
 *   matching entry, under every condition — `import` and `require`, not only
 *   the `types` TypeScript picks. A target is a URL against its package's:
 *   percent-escapes are decoded and a `?query` or `#fragment` dropped, as
 *   Node does, before its real path is classified. A relative, absolute,
 *   `file:` URL, `#imports`, `paths` alias or package specifier that resolves
 *   to no file is refused: what cannot be resolved cannot be checked. A
 *   package directory that exists is evidence of which package is named,
 *   never of a resolved subpath.
 * - **Executable branches.** The targets under `import`, `require`, `node`,
 *   `default` and `module-sync` (and a `main`) are validated apart from
 *   `types` and from other resolvers: each must exist, or be an output a
 *   tsconfig that emits will write under TypeScript's own output name
 *   (`.mts` → `.mjs`, `.cts` → `.cjs`; `noEmit`, and `emitDeclarationOnly`
 *   for JavaScript, prove nothing). A link to nothing is no target. Packages
 *   outside the repository or in pnpm's store are installed artifacts and
 *   are not asked to prove their targets.
 * - **Reachability.** A production file may not reach packages/testing (or
 *   an installed copy of it) or a test-only file (`isTestOnlyPath`). Files
 *   that are neither — root `scripts/`, root jest helpers, a workspace's
 *   build directories, anything in a `node_modules` that pnpm's store did not
 *   put there — are not swept on their own, but once a production file
 *   reaches one it is production too and its own references are followed.
 *   Only pnpm's store (`node_modules/.pnpm/`) holds leaves. What a `require()`
 *   reaches is code whatever its suffix (Node's CommonJS loader runs anything
 *   but `.json` and `.node` as JavaScript), so `./x`, `./x.txt`, `./x.bin`
 *   or a text `.wasm` are followed, classified by their real path; an
 *   extensionless file is code to `import` as well.
 * - **Loaders.** `require`, `module.require` and `createRequire` bindings are
 *   traced within the module, whatever the key is spelled as (`{ 'createRequire': cr }`).
 *   A literal argument is resolved like an import; a non-literal one, a
 *   computed member (`module['require']`, `require['resolve']`), a loader
 *   passed on, renamed or destructured (`const r = require`,
 *   `const { mainModule } = process`), `createRequire` from anything but this
 *   file (a shadowed or reassigned `__filename` is not this file), or another
 *   way to reach a loader (`process.mainModule`, `process.getBuiltinModule`,
 *   `Module._load`, `eval`, `Function` or a `.constructor` that yields it,
 *   `node:vm`, `worker_threads`, module-scope `arguments`) is refused. One
 *   key policy serves member access and destructuring (`LOADER_KEYS`, with
 *   `constructor`), a receiver is seen through parentheses, `as`, `!`,
 *   `satisfies` and `<T>`, and computed access is refused on `globalThis`,
 *   `global`, `window`, `self` and `process`, also as a reference to
 *   themselves (`globalThis.self[k]`). A name the file declares itself
 *   (`const window = rows`) is not the global.
 * - **Sweep.** Every source file on disk under apps/, services/ and
 *   packages/ — through symbolic links to files and directories, workspaces
 *   included, each real directory entered once per path (no cycles) — except
 *   a workspace's own root `dist`, `coverage`, `.next` and `node_modules`.
 *   Even there, a file one of the workspace's tsconfigs compiles is swept,
 *   and a file production reaches is followed. `src/generated/**` is swept;
 *   only Prisma's runtime files that are byte for byte (after a comment
 *   header) a file `@prisma/client/runtime` ships are treated like that
 *   installed package. A file reached through a link is resolved from both
 *   where the link is (what the compiler sees) and where it points (what
 *   Node loads).
 * - A file, tsconfig or package.json that does not parse, or a link that
 *   resolves nowhere, is a problem.
 *
 * Process = trust boundary (D-087): this is a defence against accidental
 * misuse, not against code written to evade it. Residual, not closed:
 * - aliasing the global object (`const g = globalThis; g.eval(…)`), `this`
 *   as the global in a sloppy function, and a declared `window`/`self` that
 *   is bound to the global;
 * - reflection (`Reflect.get(f, 'constructor')`) and `obj[key]` with a
 *   non-literal key on an object that is not the global;
 * - runtime-only conditions (`node --conditions=x`): every condition's target
 *   is classified, but only the default ones are required to exist;
 * - an `import` of a file with an unfamiliar suffix that a CommonJS-emitting
 *   tsconfig compiles to `require` (TypeScript resolves known suffixes only);
 *   a `.json` or `.node` that `require` loads is a leaf, as a native addon is
 *   not source we can read;
 * - a package built by something other than the repository's tsconfigs
 *   (its unbuilt target cannot be proved: fix the package, not this check);
 * - a link target outside the repository is a leaf; `child_process` (unchanged
 *   from #514).
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { REPO_ROOT, TESTING } from './testing-dev-only.mjs';

const toPosix = (path) => path.split(sep).join('/');
const inside = (dir, path) => {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Source files: TypeScript and JavaScript in every module flavour, declarations too. */
const SOURCE = /\.[cm]?[jt]sx?$/;
const SWEPT = ['apps', 'services', 'packages'];
/** What a workspace may leave unswept, at its own root only. */
const BUILD_DIRS = new Set(['dist', 'coverage', '.next', 'node_modules']);

/**
 * Whether a repository-relative path is test-only code that no image runs:
 * root tests/, packages/testing, a test/, __tests__/ or e2e/ directory, a
 * spec/test file, or a test runner's own files (`jest.config.js`,
 * `jest.setup.cjs`, `playwright.config.ts`). Everything else is production.
 */
export function isTestOnlyPath(relPath) {
  const rel = toPosix(relPath);
  if (/^(tests|packages\/testing)\//.test(rel)) return true;
  if (/(^|\/)(test|__tests__|e2e)\//.test(rel)) return true;
  if (/(^|\/)(jest|playwright)\.[\w.-]+\.[cm]?[jt]s$/.test(rel)) return true;
  return /\.(spec|test|int-spec|e2e-spec)\.[cm]?[jt]sx?$/.test(rel);
}

// ---------------------------------------------------------------------------
// References and loaders in one file
// ---------------------------------------------------------------------------

const literal = (expression) => {
  const node = expression && unwrapped(expression);
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
};

/** The name a property key spells when it is static (`a`, `'a'`, `['a']`), else undefined. */
const keyName = (name) => {
  if (!name) return undefined;
  if (ts.isComputedPropertyName(name)) return literal(name.expression);
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return literal(name);
};

/** `{ createRequire }` or `{ 'createRequire': cr }`: a plain binding of createRequire, nothing else. */
const tracedCreateRequire = (el) =>
  !el.dotDotDotToken &&
  !el.initializer &&
  ts.isIdentifier(el.name) &&
  keyName(el.propertyName ?? el.name) === 'createRequire';

const LOADER_MODULES = new Set(['module', 'node:module']);
const CODE_LOADER_MODULES = new Set(['vm', 'node:vm', 'worker_threads', 'node:worker_threads']);
/** Properties that hand out a loader on whatever object holds them. */
const LOADER_PROPERTIES = new Set([
  'require',
  'mainModule',
  '_load',
  '_compile',
  'createRequire',
  'getBuiltinModule',
]);
/** Properties of the global object that are code loaders (`globalThis.eval`). */
const CODE_PROPERTIES = new Set(['eval', 'Function']);
/** Names the global object goes by. (`redis.eval` is not eval.) */
const GLOBAL_NAMES = new Set(['globalThis', 'global', 'window', 'self']);
/** Bundler-injected loaders: nothing in production may use them. */
const BUNDLER_LOADERS = new Set(['__non_webpack_require__', '__webpack_require__']);
/** Objects that hold `eval`, `Function` and the loaders, under any name: computed access on them is refused. */
const GLOBAL_OBJECTS = new Set([...GLOBAL_NAMES, 'process']);
/**
 * One policy for a key that hands out a loader, whether it is read as a member
 * (`x.constructor`, `x['constructor']`) or destructured (`{ constructor: C }`,
 * nested, computed-literal, in an assignment). A member read may still be let
 * through where it is only compared or its `.name` read.
 */
const LOADER_KEYS = new Set([...LOADER_PROPERTIES, ...CODE_PROPERTIES, 'constructor']);

/** The expression inside parentheses and type-only wrappers (`(x as T)!` is `x`). */
const unwrapped = (node) => {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isTypeAssertionExpression(n)
  ) {
    n = n.expression;
  }
  return n;
};

/** `node`, seen through parentheses and type-only wrappers (`(x as T)!`). */
const outermost = (node) => {
  let n = node;
  while (
    ts.isParenthesizedExpression(n.parent) ||
    ts.isAsExpression(n.parent) ||
    ts.isNonNullExpression(n.parent) ||
    ts.isSatisfiesExpression(n.parent) ||
    ts.isTypeAssertionExpression(n.parent)
  ) {
    n = n.parent;
  }
  return n;
};

/** The object or array literal `node` sits in is the target of a destructuring assignment. */
const inAssignmentPattern = (node) => {
  let n = node;
  while (
    ts.isObjectLiteralExpression(n.parent) ||
    ts.isArrayLiteralExpression(n.parent) ||
    ts.isPropertyAssignment(n.parent) ||
    ts.isShorthandPropertyAssignment(n.parent) ||
    ts.isSpreadAssignment(n.parent) ||
    ts.isSpreadElement(n.parent) ||
    ts.isParenthesizedExpression(n.parent)
  ) {
    n = n.parent;
  }
  const p = n.parent;
  return (
    n !== node &&
    ((ts.isBinaryExpression(p) &&
      p.left === n &&
      p.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
      ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === n))
  );
};

/** `id` is written to: assigned, incremented, or a destructuring assignment's target. */
const isWritten = (id) => {
  const n = outermost(id);
  const p = n.parent;
  if (
    ts.isBinaryExpression(p) &&
    p.left === n &&
    p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return true;
  }
  if (
    (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) &&
    (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return true;
  }
  if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === n) return true;
  return inAssignmentPattern(n);
};

const BINDINGS = new Set([
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.EnumDeclaration,
]);

/** The identifier is a property or label name, a type, or not a value reference. */
const notAReference = (id) => {
  const p = id.parent;
  if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && p.name === id) return true;
  if (ts.isQualifiedName(p) && p.right === id) return true;
  if (ts.isBindingElement(p) && p.propertyName === id) return true;
  if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.propertyName === id) return true;
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessor(p) ||
      ts.isSetAccessor(p) ||
      ts.isEnumMember(p) ||
      ts.isJsxAttribute(p) ||
      ts.isMetaProperty(p)) &&
    p.name === id
  ) {
    return true;
  }
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return true;
  for (let n = p; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isTypeNode(n)) return true;
    if (!ts.isQualifiedName(n) && !ts.isTypeNode(n)) break;
  }
  return false;
};

const isComparison = (node) =>
  ts.isBinaryExpression(node) &&
  [
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ].includes(node.operatorToken.kind);

const inFunctionWithArguments = (node) => {
  for (let n = node.parent; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isFunctionLike(n) && !ts.isArrowFunction(n)) return true;
  }
  return false;
};

/**
 * Every module reference in `sourceFile` and every loader use that cannot
 * be traced to a literal. A reference is `{ specifier, kind, node }`, kind
 * `import` (static, in the file's own module format), `require`, `dynamic`
 * (`import()`), `type` (`import()` type), `url` (`new URL(…, import.meta.url)`),
 * `path` (`/// <reference path>`) or `types` (`/// <reference types>`).
 */
export function moduleReferences(sourceFile) {
  const references = [];
  const refusals = [];
  const refer = (specifier, kind, node) => references.push({ specifier, kind, node });
  const refuse = (node, message) => refusals.push({ node, message });

  for (const ref of sourceFile.referencedFiles) {
    refer(ref.fileName, 'path', { pos: ref.pos });
  }
  for (const ref of sourceFile.typeReferenceDirectives) {
    refer(ref.fileName, 'types', { pos: ref.pos });
  }

  // `__filename` names this file only while nothing in it declares or assigns
  // the name: `const __filename = '/elsewhere/x.js'` makes a createRequire
  // that resolves from elsewhere. (`__dirname` is never this file.)
  let ownFilename = true;
  /** `createRequire(import.meta.url)` or `createRequire(__filename)`: this file's own require. */
  const ownLocation = (node) =>
    (node &&
      ts.isPropertyAccessExpression(node) &&
      ts.isMetaProperty(node.expression) &&
      node.name.text === 'url') ||
    (node && ts.isIdentifier(node) && node.text === '__filename' && ownFilename);

  // Bindings of createRequire (`import { createRequire as cr } from 'node:module'`,
  // `const { createRequire } = require('module')`, the key spelled any way),
  // then the requires they make.
  const createRequires = new Set();
  const loaders = new Set(['require']);
  // Names this file declares itself (`const window = rows.slice(0, 10)`): not the
  // global of that name. (Binding the global to a name is aliasing: residual.)
  const declaredNames = new Set();
  /**
   * `expr` is the global object or `process`, seen through wrappers and through
   * the global's own references to itself (`(globalThis as any).self`, `window['window']`).
   */
  const isGlobalObject = (expr) => {
    const e = unwrapped(expr);
    if (ts.isIdentifier(e)) return GLOBAL_OBJECTS.has(e.text) && !declaredNames.has(e.text);
    const key = ts.isPropertyAccessExpression(e)
      ? e.name.text
      : ts.isElementAccessExpression(e)
        ? literal(e.argumentExpression)
        : undefined;
    return key !== undefined && GLOBAL_OBJECTS.has(key) && isGlobalObject(e.expression);
  };
  const collect = (node) => {
    if (ts.isIdentifier(node) && BINDINGS.has(node.parent.kind) && node.parent.name === node) {
      declaredNames.add(node.text);
    }
    if (
      ts.isIdentifier(node) &&
      node.text === '__filename' &&
      !notAReference(node) &&
      ((BINDINGS.has(node.parent.kind) && node.parent.name === node) || isWritten(node))
    ) {
      ownFilename = false;
    }
    if (ts.isImportDeclaration(node) && LOADER_MODULES.has(literal(node.moduleSpecifier))) {
      const clause = node.importClause;
      if (clause?.name || (clause?.namedBindings && !ts.isNamedImports(clause.namedBindings))) {
        refuse(node, `only createRequire may be imported from ${literal(node.moduleSpecifier)}`);
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          if ((el.propertyName ?? el.name).text === 'createRequire') {
            createRequires.add(el.name.text);
          } else {
            refuse(el, `only createRequire may be imported from ${literal(node.moduleSpecifier)}`);
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'require' &&
      LOADER_MODULES.has(literal(node.initializer.arguments[0]))
    ) {
      for (const el of node.name.elements) {
        if (tracedCreateRequire(el)) createRequires.add(el.name.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  const aliases = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      createRequires.has(node.initializer.expression.text)
    ) {
      loaders.add(node.name.text);
    }
    ts.forEachChild(node, aliases);
  };
  aliases(sourceFile);

  /** `id` is a loader (`require`, a createRequire result, `module.require`). */
  const loaderUse = (id, target) => {
    const p = target.parent;
    if (ts.isCallExpression(p) && p.expression === target) {
      const specifier = literal(p.arguments[0]);
      if (specifier === undefined) refuse(p, 'a loader called with a non-literal specifier');
      else refer(specifier, 'require', p);
      // `const { createRequire } = require('node:module')` is the one use traced.
      const only =
        ts.isVariableDeclaration(p.parent) &&
        p.parent.initializer === p &&
        ts.isObjectBindingPattern(p.parent.name) &&
        p.parent.name.elements.every(tracedCreateRequire);
      if (LOADER_MODULES.has(specifier) && !only) {
        refuse(p, `only createRequire may be taken from ${specifier}`);
      }
      return;
    }
    if (ts.isPropertyAccessExpression(p) && p.expression === target) {
      const gp = p.parent;
      if (p.name.text === 'resolve' && ts.isCallExpression(gp) && gp.expression === p) {
        const specifier = literal(gp.arguments[0]);
        if (specifier === undefined) refuse(gp, 'require.resolve with a non-literal specifier');
        else refer(specifier, 'require', gp);
        return;
      }
      if (p.name.text === 'main' && id.text === 'require' && isComparison(gp)) return;
      refuse(p, `${p.getText(sourceFile)}: a loader property that cannot be traced`);
      return;
    }
    if (ts.isTypeOfExpression(p)) return;
    if (ts.isElementAccessExpression(p) && p.expression === target) {
      refuse(p, 'computed member access on a loader');
      return;
    }
    refuse(target, `${id.text} used as a value (renamed or passed on): untraceable loader`);
  };

  /** A destructured key that hands out a loader or a code loader (`{ mainModule }`, `{ 'eval': e }`). */
  const destructuredKey = (node, key) => {
    if (key === undefined) {
      refuse(node, 'destructuring by a computed key cannot be traced');
    } else if (LOADER_KEYS.has(key)) {
      refuse(node, `destructuring ${key}: a loader that cannot be traced`);
    }
  };

  const visit = (node) => {
    if (
      ts.isElementAccessExpression(node) &&
      literal(node.argumentExpression) === undefined &&
      isGlobalObject(node.expression)
    ) {
      refuse(node, `computed member access on ${unwrapped(node.expression).getText(sourceFile)}`);
    }
    if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent) &&
      !node.dotDotDotToken
    ) {
      const decl = node.parent.parent;
      const fromLoaderModule =
        ts.isVariableDeclaration(decl) &&
        decl.initializer &&
        ts.isCallExpression(decl.initializer) &&
        ts.isIdentifier(decl.initializer.expression) &&
        decl.initializer.expression.text === 'require' &&
        LOADER_MODULES.has(literal(decl.initializer.arguments[0]));
      // `const { createRequire } = require('node:module')` is traced (collect, above).
      if (!(fromLoaderModule && tracedCreateRequire(node))) {
        destructuredKey(node, keyName(node.propertyName ?? node.name));
      }
    } else if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      inAssignmentPattern(node)
    ) {
      destructuredKey(node, keyName(node.name));
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier === undefined) refuse(node, 'a non-literal module specifier');
      else refer(specifier, 'import', node);
      if (ts.isExportDeclaration(node) && LOADER_MODULES.has(specifier)) {
        refuse(node, `re-exporting ${specifier} hands a loader on untraced`);
      }
    } else if (ts.isExternalModuleReference(node)) {
      const specifier = literal(node.expression);
      if (specifier === undefined) refuse(node, 'a non-literal module specifier');
      else refer(specifier, 'require', node);
      if (LOADER_MODULES.has(specifier))
        refuse(node, `only createRequire may be taken from ${specifier}`);
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      const specifier = ts.isLiteralTypeNode(arg) ? literal(arg.literal) : undefined;
      if (specifier === undefined) refuse(node, 'a non-literal import() type');
      else refer(specifier, 'type', node);
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      ownLocation(node.arguments?.[1])
    ) {
      // `new URL('./x', import.meta.url)`: a bundler emits (or starts a worker from) it.
      const specifier = literal(node.arguments[0]);
      if (specifier === undefined) refuse(node, 'new URL(…, import.meta.url) with a non-literal');
      else refer(specifier, 'url', node);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = literal(node.arguments[0]);
      if (specifier === undefined) {
        refuse(node, 'a non-literal import() cannot be checked; use a literal');
      } else {
        refer(specifier, 'dynamic', node);
      }
    } else if (
      (ts.isPropertyAccessExpression(node) && LOADER_PROPERTIES.has(node.name.text)) ||
      (ts.isElementAccessExpression(node) &&
        LOADER_PROPERTIES.has(literal(node.argumentExpression)))
    ) {
      const isModuleRequire =
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'module' &&
        node.name.text === 'require';
      if (isModuleRequire) loaderUse(node.expression, node);
      else if (!(ts.isIdentifier(node.expression) && loaders.has(node.expression.text))) {
        refuse(node, `${node.getText(sourceFile)}: a loader reached through a property`);
      }
    } else if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      CODE_PROPERTIES.has(
        ts.isPropertyAccessExpression(node) ? node.name.text : literal(node.argumentExpression),
      ) &&
      isGlobalObject(node.expression)
    ) {
      refuse(node, `${node.getText(sourceFile)}: a code loader reached through a property`);
    } else if (
      (ts.isPropertyAccessExpression(node) && node.name.text === 'constructor') ||
      (ts.isElementAccessExpression(node) && literal(node.argumentExpression) === 'constructor')
    ) {
      // A function's constructor is Function; only reading its name or comparing it is traced.
      const n = outermost(node);
      const readsName =
        ts.isPropertyAccessExpression(n.parent) &&
        n.parent.expression === n &&
        n.parent.name.text === 'name';
      if (!readsName && !isComparison(n.parent)) {
        refuse(node, `${node.getText(sourceFile)}: a constructor can be Function, a code loader`);
      }
    } else if (ts.isIdentifier(node) && !notAReference(node)) {
      const p = node.parent;
      const declared = BINDINGS.has(p.kind) && p.name === node;
      const name = node.text;
      if (loaders.has(name)) {
        if (declared) {
          if (name === 'require') refuse(node, 'a local binding shadows require');
          // A createRequire alias's own declaration.
        } else {
          loaderUse(node, node);
        }
      } else if (createRequires.has(name)) {
        if (!declared) {
          if (ts.isCallExpression(p) && p.expression === node) {
            if (!ownLocation(p.arguments[0])) {
              refuse(p, 'createRequire for another location than this file');
            }
            const gp = p.parent;
            const named =
              ts.isVariableDeclaration(gp) &&
              gp.initializer === p &&
              ts.isIdentifier(gp.name) &&
              loaders.has(gp.name.text);
            if (!named) loaderUse(node, p);
          } else {
            refuse(node, 'createRequire used as a value: untraceable loader');
          }
        }
      } else if (name === 'module') {
        if (declared) refuse(node, 'a local binding shadows module');
        else if (ts.isPropertyAccessExpression(p) && p.expression === node) {
          if (p.name.text !== 'exports' && p.name.text !== 'require') {
            refuse(p, `module.${p.name.text}: only module.exports and module.require are traced`);
          }
        } else if (ts.isElementAccessExpression(p) && p.expression === node) {
          refuse(p, 'computed member access on module');
        } else if (!isComparison(p) && !ts.isTypeOfExpression(p)) {
          refuse(node, 'module used as a value: untraceable loader');
        }
      } else if (BUNDLER_LOADERS.has(name)) {
        refuse(node, `${name}: a bundler's loader cannot be checked`);
      } else if (name === 'eval') {
        refuse(node, 'eval can reach a loader');
      } else if (name === 'Function') {
        // Called, constructed or handed on (`const F = Function`): all reach a loader.
        const instanceOf =
          ts.isBinaryExpression(p) &&
          p.right === node &&
          p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword;
        if (!instanceOf) refuse(node, 'the Function constructor can reach a loader');
      } else if (name === 'arguments' && !inFunctionWithArguments(node)) {
        refuse(node, 'module-scope arguments holds the loader');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const ref of references) {
    if (CODE_LOADER_MODULES.has(ref.specifier)) {
      refuse(ref.node, `${ref.specifier} loads code that cannot be checked`);
    }
    if (LOADER_MODULES.has(ref.specifier) && ref.kind !== 'import' && ref.kind !== 'require') {
      refuse(ref.node, `${ref.specifier} through ${ref.kind}`);
    }
  }
  return { references, refusals };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Node's own rules, for files no tsconfig compiles and for what runs compiled. */
const NODE_OPTIONS = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  allowJs: true,
  resolveJsonModule: true,
};

const MODE_AWARE = new Set([
  ts.ModuleResolutionKind.Node16,
  ts.ModuleResolutionKind.NodeNext,
  ts.ModuleResolutionKind.Bundler,
]);

const configHost = {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => {
    throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  },
};

/** A tsconfig, parsed the way tsc reads it (`extends`, include/exclude). */
function readConfig(path) {
  const parsed = ts.getParsedCommandLineOfConfigFile(path, {}, configHost);
  // Syntax errors too: TypeScript recovers a config from `{` and reports
  // them only beside `errors`, as tsc does. 18003: no inputs; the repository
  // root's own tsconfig includes nothing.
  const errors = (parsed ? ts.getConfigFileParsingDiagnostics(parsed) : []).filter(
    (d) => d.code !== 18003,
  );
  if (!parsed || errors.length > 0) {
    throw new Error(
      `${path}: ${errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ')}`,
    );
  }
  return {
    path,
    options: parsed.options,
    files: new Set(parsed.fileNames.map((f) => resolve(f))),
    cache: ts.createModuleResolutionCache(dirname(path), (f) => f, parsed.options),
    parsed,
  };
}

const matchesPaths = (specifier, options) =>
  Object.keys(options.paths ?? {}).some((pattern) => {
    const star = pattern.indexOf('*');
    if (star < 0) return specifier === pattern;
    return (
      specifier.length >= pattern.length - 1 &&
      specifier.startsWith(pattern.slice(0, star)) &&
      specifier.endsWith(pattern.slice(star + 1))
    );
  });

const manifests = new Map();
/**
 * `dir`'s package.json, parsed; `undefined` when there is none. One that
 * exists but does not parse throws: Node refuses it too
 * (ERR_INVALID_PACKAGE_CONFIG), and the scope above it is not Node's answer.
 */
function manifest(dir) {
  if (!manifests.has(dir)) {
    const path = join(dir, 'package.json');
    let value;
    if (isFile(path)) {
      try {
        value = JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        value = new Error(`${path} does not parse: ${error.message}`);
      }
    }
    manifests.set(dir, value);
  }
  const value = manifests.get(dir);
  if (value instanceof Error) throw value;
  return value;
}

/**
 * Whether the loader that `kind` of reference uses runs `file` as code though
 * its suffix is not a source one. Node's CommonJS loader runs everything but
 * `.json` and `.node` as JavaScript (`require('./x.txt')`, `./x.bin`, a text
 * `.wasm`, a `.cjs` link to an extensionless file: classified by the real
 * path); either loader runs an extensionless file. Any other suffix under an
 * `import` is an asset (the bundler's, or Node's refusal).
 */
const loadedAsCode = (file, kind) =>
  kind === 'require' ? !/\.(json|node)$/i.test(basename(file)) : extname(file) === '';

/** The directory of the package.json whose scope `file` is in. */
function packageScope(file) {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (manifest(dir)) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/** CommonJS or ESM, as Node decides it for `file`. */
function moduleFormat(file) {
  if (/\.m[jt]s$/.test(file)) return ts.ModuleKind.ESNext;
  if (/\.c[jt]s$/.test(file)) return ts.ModuleKind.CommonJS;
  const scope = packageScope(file);
  return scope && manifest(scope).type === 'module' ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS;
}

const realpath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};
/** Something is at `path`, even a link to nothing. */
const lstatExists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * The file a relative or absolute URL specifier names from `file`, as Node's
 * ESM loader reads it: without its query or fragment, percent-decoded.
 */
const urlPath = (specifier, file) => {
  try {
    return resolve(dirname(file), decodeURIComponent(specifier.replace(/[?#].*$/s, '')));
  } catch {
    return undefined;
  }
};

/**
 * Conditions Node takes by default: the branches that run. Every other
 * condition (`types`, `browser`, `development`, a custom one) is classified
 * but is not evidence that the package can be loaded.
 */
const EXECUTABLE_CONDITIONS = new Set(['import', 'require', 'node', 'default', 'module-sync']);

/**
 * Every string an `exports` or `imports` entry maps to, under any condition,
 * as `{ target, executable }`: `executable` while every condition on the way
 * is one Node takes by default.
 */
function entryTargets(value, executable = true, out = []) {
  if (typeof value === 'string') out.push({ target: value, executable });
  else if (Array.isArray(value)) {
    for (const v of value) entryTargets(v, executable, out);
  } else if (value && typeof value === 'object') {
    for (const [condition, v] of Object.entries(value)) {
      entryTargets(v, executable && EXECUTABLE_CONDITIONS.has(condition), out);
    }
  }
  return out;
}

/**
 * The file a package `exports`/`imports` target names from `dir`, as Node
 * resolves it: a URL against the package's own, so percent-escapes are decoded
 * and a `?query` or `#fragment` dropped (`./dist/%72untime.mjs?x` is
 * `dist/runtime.mjs`). A target that is not a file URL, or encodes a
 * separator, is Node's ERR_INVALID_PACKAGE_TARGET: refused.
 */
function targetPath(dir, target) {
  const url = new URL(target, pathToFileURL(join(dir, sep)));
  if (url.protocol !== 'file:') throw new Error(`the package target ${target} is not a path`);
  return fileURLToPath(url);
}

/**
 * The targets `request` (`.`, `./sub`, `#x`) has in an `exports` or
 * `imports` map, as `entryTargets` gives them: every condition's (`import`,
 * `require`, `node`, `default`, `types`…), with a `*` pattern filled in.
 * `undefined` when no key matches:
 * Node refuses such a request (ERR_PACKAGE_PATH_NOT_EXPORTED).
 */
function mapTargets(map, request) {
  if (map === undefined || map === null) return undefined;
  const sugar =
    typeof map !== 'object' ||
    Array.isArray(map) ||
    !Object.keys(map).some((k) => k.startsWith('.') || k.startsWith('#'));
  const entries = sugar ? { '.': map } : map;
  if (Object.hasOwn(entries, request)) return entryTargets(entries[request]);
  let found;
  for (const [key, value] of Object.entries(entries)) {
    const star = key.indexOf('*');
    let fill;
    if (star >= 0) {
      const [head, tail] = [key.slice(0, star), key.slice(star + 1)];
      if (request.length >= key.length && request.startsWith(head) && request.endsWith(tail)) {
        fill = (t) => t.replaceAll('*', request.slice(head.length, request.length - tail.length));
      }
    } else if (key.endsWith('/') && request.startsWith(key)) {
      fill = (t) => t + request.slice(key.length);
    }
    if (fill) {
      (found ??= []).push(...entryTargets(value).map((e) => ({ ...e, target: fill(e.target) })));
    }
  }
  return found;
}

/**
 * What a bare or `#` specifier names from `from`, read from package.json as
 * Node reads it. `identity`: the installed package's directory — which
 * package is named, never proof that the request resolves. `targets`: the
 * files its `exports` (every condition), `imports`, main fields or plain
 * subpath name, whether they exist or not, each `{ path, executable }`
 * (`executable`: a branch that runs, not `types` or a condition Node does not
 * take; `main` is probed like Node does), with `home`, the directory of the
 * package.json it comes from.
 */
function packageTargets(specifier, from, depth = 0) {
  const scope = packageScope(from);
  if (specifier.startsWith('#')) {
    const result = { identity: [], targets: [] };
    for (const { target, executable } of (scope &&
      mapTargets(manifest(scope).imports, specifier)) ??
      []) {
      if (target.startsWith('./')) {
        result.targets.push({ path: targetPath(scope, target), executable, home: scope });
      } else if (depth < 8 && !isBuiltin(target)) {
        // `"#db": "some-package/sub"`: what that package maps it to.
        const named = packageTargets(target, join(scope, 'package.json'), depth + 1);
        result.identity.push(...named.identity);
        for (const t of named.targets) {
          result.targets.push({ ...t, executable: t.executable && executable });
        }
      }
    }
    return result;
  }
  const parts = specifier.split('/');
  const scoped = specifier.startsWith('@');
  const name = parts.slice(0, scoped ? 2 : 1).join('/');
  const subpath = parts.slice(scoped ? 2 : 1).join('/');
  // A package with `exports` can name itself from inside its own scope.
  let dir =
    scope && manifest(scope).name === name && manifest(scope).exports !== undefined
      ? scope
      : undefined;
  for (let d = dirname(from); !dir; d = dirname(d)) {
    dir = realpath(join(d, 'node_modules', name));
    if (dirname(d) === d) break;
  }
  if (!dir) return { identity: [], targets: [] };
  const pkg = manifest(dir) ?? {};
  const request = subpath ? `./${subpath}` : '.';
  const targets = [];
  if (pkg.exports !== undefined) {
    for (const { target, executable } of mapTargets(pkg.exports, request) ?? []) {
      targets.push({ path: targetPath(dir, target), executable, home: dir });
    }
  } else if (subpath) {
    // Node's CommonJS loader reads the path; its ESM loader reads a URL.
    targets.push({ path: resolve(dir, request), executable: false, home: dir });
    try {
      targets.push({ path: targetPath(dir, request), executable: false, home: dir });
    } catch {
      // Not a URL path: the plain one above stands.
    }
  } else {
    for (const field of ['main', 'module', 'browser', 'types', 'typings']) {
      if (typeof pkg[field] === 'string') {
        const path = resolve(dir, pkg[field]);
        targets.push({ path, executable: field === 'main', probe: field === 'main', home: dir });
      }
    }
  }
  return { identity: [dir], targets };
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * What a directory entry is, a symbolic link followed to what it points at:
 * `dir`, `file`, `broken` (a link to nothing) or `other`.
 */
function entryKind(dir, entry) {
  if (!entry.isSymbolicLink()) {
    return entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other';
  }
  try {
    const stats = statSync(join(dir, entry.name));
    return stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other';
  } catch {
    return 'broken';
  }
}

/** Every directory under apps/, services/ and packages/, linked ones too: one workspace each. */
function workspaces(root, onBroken) {
  const found = [];
  for (const top of SWEPT) {
    const dir = join(root, top);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const kind = entryKind(dir, entry);
      if (kind === 'dir') found.push(join(dir, entry.name));
      else if (kind === 'broken') onBroken(join(dir, entry.name));
    }
  }
  return found;
}

/**
 * Every file under `dir`, through symbolic links to files and directories:
 * the compiler and Node both follow them. A linked directory whose real path
 * is already open above it (a cycle) is not entered again.
 */
function walk(dir, skip, onFile, onBroken, open = new Set([realpath(dir)])) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const kind = entryKind(dir, entry);
    if (kind === 'dir') {
      if (skip(path, entry.name)) continue;
      const real = realpath(path);
      if (open.has(real)) continue;
      open.add(real);
      walk(path, skip, onFile, onBroken, open);
      open.delete(real);
    } else if (kind === 'file') {
      onFile(path, entry.name);
    } else if (kind === 'broken' && !skip(path, entry.name)) {
      onBroken(path);
    }
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const runtimeHashes = new Map();
/** What Prisma's generator copies from `@prisma/client/runtime`, by content. */
function prismaRuntimeHashes(workspace) {
  let runtime;
  try {
    const manifest = createRequire(join(workspace, 'package.json')).resolve(
      '@prisma/client/package.json',
    );
    runtime = realpathSync(join(dirname(manifest), 'runtime'));
  } catch {
    return new Map();
  }
  if (runtimeHashes.has(runtime)) return runtimeHashes.get(runtime);
  // By size, then content: a file is hashed only when a shipped one is as long.
  const hashes = new Map();
  runtimeHashes.set(runtime, hashes);
  for (const name of readdirSync(runtime)) {
    if (!isFile(join(runtime, name))) continue;
    const bytes = readFileSync(join(runtime, name));
    if (!hashes.has(bytes.length)) hashes.set(bytes.length, new Set());
    hashes.get(bytes.length).add(sha256(bytes));
  }
  return hashes;
}

/**
 * `true` when `text` is only whitespace and complete comments, `false` when
 * it holds code, `undefined` while a comment is still open.
 */
const onlyTrivia = (text) => {
  let open = false;
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    text,
    () => (open = true),
  );
  if (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) return false;
  return open ? undefined : true;
};

/**
 * Whether `file`, in a Prisma generator's output directory (from the
 * workspace's prisma/schema.prisma), is byte for byte a file
 * `@prisma/client/runtime` ships, after a header that is only comments. Such
 * a file is that installed package's code, and is treated like it.
 */
function verifiedPrismaRuntime(file, workspace, state) {
  if (!state.has(workspace)) {
    const outputs = [];
    const schema = join(workspace, 'prisma', 'schema.prisma');
    if (existsSync(schema)) {
      const text = readFileSync(schema, 'utf8');
      for (const block of text.matchAll(/generator\s+\w+\s*\{([^}]*)\}/g)) {
        const output = /^\s*output\s*=\s*"([^"]+)"/m.exec(block[1]);
        if (output) outputs.push(resolve(dirname(schema), output[1]));
      }
    }
    state.set(workspace, {
      outputs,
      hashes: outputs.length ? prismaRuntimeHashes(workspace) : null,
    });
  }
  const { outputs, hashes } = state.get(workspace);
  if (!outputs.some((out) => inside(out, file) && out !== file)) return false;
  const bytes = readFileSync(file);
  const shipped = (rest) => hashes.get(rest.length)?.has(sha256(rest)) ?? false;
  if (shipped(bytes)) return true;
  for (let at = bytes.indexOf(10); at >= 0; at = bytes.indexOf(10, at + 1)) {
    const header = onlyTrivia(bytes.subarray(0, at + 1).toString('utf8'));
    if (header === false) break;
    if (header && shipped(bytes.subarray(at + 1))) return true;
  }
  return false;
}

/**
 * The sweep (see the header). Returns the problems, one string each, and how
 * many production files were checked.
 */
export function sourceProblems(root = REPO_ROOT) {
  const testingDir =
    realpath(join(root, 'packages', 'testing')) ?? join(root, 'packages', 'testing');
  const configs = new Map();
  const config = (path) => {
    if (!configs.has(path)) configs.set(path, readConfig(path));
    return configs.get(path);
  };
  const workspaceOf = new Map();
  const generated = new Map();
  const roots = [];
  const problems = [];
  let prismaRuntime = 0;
  const broken = (path) =>
    problems.push(`${toPosix(relative(root, path))}: a symbolic link to nothing cannot be checked`);

  for (const ws of workspaces(root, broken)) {
    const tsconfigs = [];
    const files = [];
    const skipped = [];
    walk(
      ws,
      (path, name) => {
        if (dirname(path) === ws && BUILD_DIRS.has(name)) {
          skipped.push(path);
          return true;
        }
        return false;
      },
      (path, name) => {
        if (/^tsconfig.*\.json$/.test(name)) tsconfigs.push(path);
        if (SOURCE.test(name)) files.push(path);
      },
      broken,
    );
    // A build directory is left out only where no tsconfig compiles from it.
    for (const path of tsconfigs) {
      for (const file of config(path).files) {
        if (skipped.some((dir) => inside(dir, file))) files.push(file);
      }
    }
    for (const file of new Set(files)) {
      workspaceOf.set(file, ws);
      if (isTestOnlyPath(relative(root, file))) continue;
      if (verifiedPrismaRuntime(file, ws, generated)) prismaRuntime += 1;
      else roots.push(file);
    }
  }
  const wsList = [...new Set(workspaceOf.values())];

  /** The tsconfigs that compile `file`, else the nearest tsconfig.json above it. */
  const configsMemo = new Map();
  const configsFor = (file) => {
    if (!configsMemo.has(file)) configsMemo.set(file, findConfigs(file));
    return configsMemo.get(file);
  };
  const findConfigs = (file) => {
    const compiling = [...configs.values()].filter((c) => c.files.has(file));
    if (compiling.length > 0) return compiling;
    for (let dir = dirname(file); inside(root, dir); dir = dirname(dir)) {
      const path = join(dir, 'tsconfig.json');
      if (existsSync(path)) return [config(path)];
      if (dir === root) break;
    }
    return [];
  };

  /**
   * The source one of the repository's tsconfigs compiles to `target`, a
   * build output not on disk yet (`main: ./dist/index.js` before a build):
   * what will run there is that source, compiled. Only a tsconfig that emits
   * proves it (`noEmit`, and `emitDeclarationOnly` for JavaScript, do not),
   * and only under the output name TypeScript itself gives the source
   * (`.mts` → `.mjs`, `.cts` → `.cjs`, `.tsx` → `.js` or `.jsx`).
   */
  const builtFrom = (target) => {
    for (const c of configs.values()) {
      const { outDir, rootDir, noEmit } = c.options;
      if (!outDir || noEmit || target === outDir || !inside(outDir, target)) continue;
      const base = join(rootDir ?? dirname(c.path), relative(outDir, target)).replace(
        /(\.d)?\.[cm]?[jt]sx?$/,
        '',
      );
      for (const ext of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) {
        if (!c.files.has(base + ext)) continue;
        const outputs = ts.getOutputFileNames(
          c.parsed,
          base + ext,
          ts.sys.useCaseSensitiveFileNames,
        );
        if (outputs.some((o) => resolve(o) === target)) return base + ext;
      }
    }
    return undefined;
  };

  /**
   * Whether an executable package target will exist: a file on disk, or an
   * unbuilt output a tsconfig emits (`builtFrom`). A link to nothing is
   * neither: a build would not make it a file. A `main` that names no file is
   * probed the way Node does (`.js`, `.json`, `.node`, `/index.…`).
   */
  const provable = ({ path, probe }) => {
    if (isFile(path)) return true;
    const candidates = probe
      ? [path, ...['.js', '.json', '.node'].flatMap((e) => [path + e, join(path, `index${e}`)])]
      : [path];
    return candidates.some((c) => isFile(c) || (!lstatExists(c) && builtFrom(c) !== undefined));
  };

  /** An installed package (pnpm's store, or outside the repository): `classify` treats it as a leaf. */
  const installed = (dir) => {
    const real = realpath(dir) ?? dir;
    return (
      !inside(root, real) || /(^|\/)node_modules\/\.pnpm\//.test(toPosix(relative(root, real)))
    );
  };

  /** Where `file` sits: a problem, a leaf, or production code to follow. */
  const classify = (target, kind) => {
    const real = realpath(target) ?? resolve(target);
    if (inside(testingDir, real) || /[/\\]@rasta[+/]testing([/@\\]|$)/.test(real)) {
      return { problem: 'packages/testing (the test signer)' };
    }
    if (!inside(root, real)) return { leaf: true };
    const rel = toPosix(relative(root, real));
    // An installed package: pnpm's store, which only `pnpm install` writes,
    // from the lockfile. Anything else in a node_modules — like a workspace's
    // dist, coverage or .next — is repository code once production reaches it.
    if (/(^|\/)node_modules\/\.pnpm\//.test(rel)) return { leaf: true };
    const ws = wsList.find((w) => inside(w, real));
    // A directory (`new URL('../test/', import.meta.url)`) by what it holds.
    const dir = existsSync(real) && statSync(real).isDirectory();
    if (isTestOnlyPath(dir ? `${rel}/` : rel)) return { problem: `test-only ${rel}` };
    if (ws && !dir && verifiedPrismaRuntime(real, ws, generated)) return { leaf: true };
    if (!existsSync(real) || dir) return { leaf: true };
    if (!SOURCE.test(real) && !loadedAsCode(real, kind)) return { leaf: true };
    return { follow: real };
  };

  /**
   * What `specifier` can load from `file`. `targets`: every existing file any
   * resolver finds; empty when nothing resolves. `evidence`: what is
   * classified without proving resolution — the package directory a name
   * denotes, and `exports` targets that are not on disk (not built yet).
   */
  const resolveAll = (specifier, kind, file) => {
    const targets = new Set();
    const evidence = new Set();
    const unproven = new Set();
    const result = () => ({
      targets: [...targets],
      evidence: [...evidence],
      unproven: [...unproven],
    });
    if (kind === 'path') {
      // A reference that names no file compiles nothing in: the name is classified.
      targets.add(resolve(dirname(file), specifier));
      return result();
    }
    if (kind === 'url') {
      // A file or a directory, exactly as the URL names it.
      const path = urlPath(specifier, file);
      if (path && existsSync(path)) targets.add(path);
      return result();
    }
    let spec = specifier;
    if (/^file:/i.test(spec)) spec = fileURLToPath(spec);
    const mode =
      kind === 'require'
        ? ts.ModuleKind.CommonJS
        : kind === 'dynamic'
          ? ts.ModuleKind.ESNext
          : moduleFormat(file);
    const optionSets = [
      ...configsFor(file).map((c) => [c.options, c.cache]),
      [NODE_OPTIONS, nodeCache],
    ];
    for (const [options, cache] of optionSets) {
      const resolved =
        kind === 'types'
          ? ts.resolveTypeReferenceDirective(spec, file, options, ts.sys)
              .resolvedTypeReferenceDirective
          : ts.resolveModuleName(
              spec,
              file,
              options,
              ts.sys,
              cache,
              undefined,
              // As tsc: a format only where resolution has one (node10 has none,
              // and given one, TypeScript would apply `exports` that tsc does not).
              MODE_AWARE.has(options.moduleResolution) ? mode : undefined,
            ).resolvedModule;
      if (resolved?.resolvedFileName) targets.add(resolved.resolvedFileName);
    }
    if (kind !== 'types') {
      try {
        const viaNode = requireFrom(file).resolve(spec);
        if (isAbsolute(viaNode)) targets.add(viaNode);
      } catch {
        // Not loadable by require from here; the other resolutions decide.
      }
    }
    if (spec.startsWith('.') || isAbsolute(spec)) {
      // A file named exactly: an asset the bundler loads (`./x.css`), or what
      // Node's ESM loader reads for a URL with a query (`./x.wasm?module`).
      for (const path of [resolve(dirname(file), spec), urlPath(spec, file)]) {
        if (path && isFile(path)) targets.add(path);
      }
    } else {
      // The package as Node reads its package.json: every `exports`/`imports`
      // condition (TypeScript stops at `types`; require() only sees
      // `require`), and the package directory itself as evidence of identity.
      for (const name of kind === 'types' ? [spec, `@types/${spec}`] : [spec]) {
        const named = packageTargets(name, file);
        for (const dir of named.identity) evidence.add(dir);
        for (const target of named.targets) {
          // A target on disk resolves; so does an unbuilt one a tsconfig compiles from source.
          const source = isFile(target.path) ? target.path : builtFrom(target.path);
          if (source) targets.add(source);
          evidence.add(target.path);
          // Types, or another resolver, finding something is not proof that the
          // runtime branch exists: each executable target stands on its own.
          if (
            target.executable &&
            kind !== 'types' &&
            kind !== 'type' &&
            !installed(target.home) &&
            !provable(target)
          ) {
            unproven.add(target.path);
          }
        }
      }
    }
    return result();
  };

  const nodeCache = ts.createModuleResolutionCache(root, (f) => f, NODE_OPTIONS);
  let requireMemo = [];
  const requireFrom = (file) => {
    if (requireMemo[0] !== file) requireMemo = [file, createRequire(file)];
    return requireMemo[1];
  };
  const pathLike = (spec) => spec.startsWith('.') || isAbsolute(spec) || /^file:/i.test(spec);
  const parent = new Map();
  const chain = (file) => {
    const steps = [];
    for (let at = file; at; at = parent.get(at)) steps.unshift(toPosix(relative(root, at)));
    return steps.join(' → ');
  };
  const queue = [...roots];
  const seen = new Set(queue);
  let checked = 0;
  while (queue.length > 0) {
    const file = queue.shift();
    checked += 1;
    const where = (pos) => `${chain(file)}:${pos.line + 1}`;
    const text = readFileSync(file, 'utf8');
    // A file with a suffix TypeScript does not know (`require('./x.txt')`) is read as JavaScript.
    const sourceFile = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      SOURCE.test(file) ? undefined : ts.ScriptKind.JS,
    );
    const position = (node) =>
      sourceFile.getLineAndCharacterOfPosition(
        Math.min(node.getStart?.(sourceFile) ?? node.pos ?? 0, text.length),
      );
    if (sourceFile.parseDiagnostics.length > 0) {
      problems.push(
        `${where(position({ pos: sourceFile.parseDiagnostics[0].start }))} does not parse`,
      );
      continue;
    }
    const { references, refusals } = moduleReferences(sourceFile);
    for (const { node, message } of refusals) {
      problems.push(`${where(position(node))} ${message}`);
    }
    const configsHere = configsFor(file);
    // A linked file is compiled where the link is and loaded by Node where it
    // points: its references are resolved from both.
    const froms = [...new Set([file, realpath(file) ?? file])];
    for (const { specifier, kind, node } of references) {
      const at = where(position(node));
      if (specifier === TESTING || specifier.startsWith(`${TESTING}/`)) {
        problems.push(`${at} imports ${specifier}`);
        continue;
      }
      if (/(^|\/)@rasta[/+]testing([/@]|$)/.test(specifier)) {
        problems.push(`${at} reaches ${TESTING} through ${specifier}`);
        continue;
      }
      if (/^[a-z][a-z\d+.-]+:/i.test(specifier) && !/^(node|file):/i.test(specifier)) {
        problems.push(`${at} loads ${specifier}: only node: and file: URLs can be checked`);
        continue;
      }
      if (kind !== 'path' && kind !== 'types' && isBuiltin(specifier)) continue;
      const found = new Set();
      try {
        for (const from of froms) {
          const { targets, evidence, unproven } = resolveAll(specifier, kind, from);
          for (const path of unproven) {
            problems.push(
              `${at} ${specifier}: the executable target ${toPosix(relative(root, path))} neither exists nor is built from a source a tsconfig emits`,
            );
          }
          // Each place it is loaded from must resolve.
          if (targets.length === 0) {
            const alias =
              specifier.startsWith('#') ||
              configsHere.some((c) => matchesPaths(specifier, c.options));
            const what = pathLike(specifier) ? 'path' : alias ? 'alias' : 'package';
            const via = from === file ? '' : ` from ${toPosix(relative(root, from))}`;
            problems.push(`${at} ${specifier}: an unresolvable ${what}${via} cannot be checked`);
          }
          for (const target of [...targets, ...evidence]) found.add(target);
        }
      } catch (error) {
        problems.push(`${at} ${specifier}: ${error.message}`);
        continue;
      }
      for (const target of found) {
        const verdict = classify(target, kind);
        if (verdict.problem) {
          problems.push(`${at} ${specifier} reaches ${verdict.problem}`);
        } else if (verdict.follow && !seen.has(verdict.follow)) {
          seen.add(verdict.follow);
          parent.set(verdict.follow, file);
          queue.push(verdict.follow);
        }
      }
    }
  }
  const followed = [...parent.keys()].map((f) => toPosix(relative(root, f))).sort();
  return {
    problems: [...new Set(problems)],
    roots: roots.length,
    checked,
    prismaRuntime,
    followed,
  };
}
