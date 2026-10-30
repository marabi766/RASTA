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
 *   which is what runs `.mjs`/`.cjs` and compiled output. The real path of
 *   each target is then classified. A relative, absolute, `file:` URL,
 *   `#imports` or `paths` alias specifier that resolves nowhere is refused:
 *   what cannot be resolved cannot be checked.
 * - **Reachability.** A production file may not reach packages/testing (or
 *   an installed copy of it) or a test-only file (`isTestOnlyPath`). Files
 *   that are neither — root `scripts/`, root jest helpers — are not swept on
 *   their own, but once a production file reaches one it is production too
 *   and its own references are followed.
 * - **Loaders.** `require`, `module.require` and `createRequire` bindings are
 *   traced within the module. A literal argument is resolved like an import;
 *   a non-literal one, a computed member (`module['require']`,
 *   `require['resolve']`), a loader passed on or renamed (`const r = require`),
 *   `createRequire` from anything but this file, or another way to reach a
 *   loader (`process.mainModule`, `Module._load`, `eval`, `node:vm`,
 *   `worker_threads`, module-scope `arguments`) is refused.
 * - **Sweep.** Every source file on disk under apps/, services/ and
 *   packages/, except a workspace's own root `dist`, `coverage`, `.next` and
 *   `node_modules` — and even there, a file one of the workspace's tsconfigs
 *   compiles is swept. `src/generated/**` is swept; only Prisma's runtime
 *   files that are byte for byte (after a comment header) a file
 *   `@prisma/client/runtime` ships are treated like that installed package.
 * - A file that does not parse is a problem.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

const literal = (node) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;

const LOADER_MODULES = new Set(['module', 'node:module']);
const CODE_LOADER_MODULES = new Set(['vm', 'node:vm', 'worker_threads', 'node:worker_threads']);
/** Properties that hand out a loader on whatever object holds them. */
const LOADER_PROPERTIES = new Set(['require', 'mainModule', '_load', '_compile', 'createRequire']);
/** Bundler-injected loaders: nothing in production may use them. */
const BUNDLER_LOADERS = new Set(['__non_webpack_require__', '__webpack_require__']);

/** `createRequire(import.meta.url)` or `createRequire(__filename)`: this file's own require. */
const ownLocation = (node) =>
  (node &&
    ts.isPropertyAccessExpression(node) &&
    ts.isMetaProperty(node.expression) &&
    node.name.text === 'url') ||
  (node && ts.isIdentifier(node) && node.text === '__filename');

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
 * (`import()`), `type` (`import()` type), `path` (`/// <reference path>`) or
 * `types` (`/// <reference types>`).
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

  // Bindings of createRequire (`import { createRequire as cr } from 'node:module'`,
  // `const { createRequire } = require('module')`), then the requires they make.
  const createRequires = new Set();
  const loaders = new Set(['require']);
  const collect = (node) => {
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
        const name = el.propertyName ?? el.name;
        if (ts.isIdentifier(name) && name.text === 'createRequire' && ts.isIdentifier(el.name)) {
          createRequires.add(el.name.text);
        }
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
        ts.isObjectBindingPattern(p.parent.name) &&
        p.parent.name.elements.every(
          (el) => ((el.propertyName ?? el.name).text ?? '') === 'createRequire',
        );
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

  const visit = (node) => {
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
      else refer(specifier, 'dynamic', node);
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
      } else if (name === 'process') {
        if (ts.isElementAccessExpression(p) && p.expression === node) {
          if (literal(p.argumentExpression) === undefined) {
            refuse(p, 'computed member access on process');
          }
        }
      } else if (BUNDLER_LOADERS.has(name)) {
        refuse(node, `${name}: a bundler's loader cannot be checked`);
      } else if (name === 'eval') {
        refuse(node, 'eval can reach a loader');
      } else if (name === 'Function' && (ts.isCallExpression(p) || ts.isNewExpression(p))) {
        if (p.expression === node) refuse(p, 'the Function constructor can reach a loader');
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

const configHost = {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => {
    throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  },
};

/** A tsconfig, parsed the way tsc reads it (`extends`, include/exclude). */
function readConfig(path) {
  const parsed = ts.getParsedCommandLineOfConfigFile(path, {}, configHost);
  // 18003: no inputs. The repository root's own tsconfig includes nothing.
  const errors = (parsed?.errors ?? []).filter((d) => d.code !== 18003);
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

const packageType = new Map();
/** CommonJS or ESM, as Node decides it for `file`. */
function moduleFormat(file) {
  if (/\.m[jt]s$/.test(file)) return ts.ModuleKind.ESNext;
  if (/\.c[jt]s$/.test(file)) return ts.ModuleKind.CommonJS;
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (!packageType.has(dir)) {
      let type;
      try {
        type = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).type ?? 'commonjs';
      } catch {
        type = undefined;
      }
      packageType.set(dir, type);
    }
    const type = packageType.get(dir);
    if (type) return type === 'module' ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS;
    if (dirname(dir) === dir) return ts.ModuleKind.CommonJS;
  }
}

const realpath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};
const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The installed package directory a bare specifier names, by Node's lookup. */
function packageDirectory(specifier, from) {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const subpath = parts.slice(specifier.startsWith('@') ? 2 : 1).join('/');
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const candidate = realpath(join(dir, 'node_modules', name));
    if (candidate) return subpath ? join(candidate, subpath) : candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/** Every directory under apps/, services/ and packages/: one workspace each. */
function workspaces(root) {
  const found = [];
  for (const top of SWEPT) {
    const dir = join(root, top);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) found.push(join(dir, entry.name));
    }
  }
  return found;
}

function walk(dir, skip, onFile) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skip(path, entry.name)) walk(path, skip, onFile);
    } else if (entry.isFile()) {
      onFile(path, entry.name);
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

  for (const ws of workspaces(root)) {
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

  /** Where `file` sits: a problem, a leaf, or production code to follow. */
  const classify = (target) => {
    const real = realpath(target) ?? resolve(target);
    if (inside(testingDir, real) || /[/\\]@rasta[+/]testing([/@\\]|$)/.test(real)) {
      return { problem: 'packages/testing (the test signer)' };
    }
    if (!inside(root, real)) return { leaf: true };
    const rel = toPosix(relative(root, real));
    // An installed package (pnpm's store is under the root node_modules).
    if (rel.startsWith('node_modules/')) return { leaf: true };
    const ws = wsList.find((w) => inside(w, real));
    const top = ws && relative(ws, real).split(sep)[0];
    if (top === 'node_modules') return { leaf: true };
    if (isTestOnlyPath(rel)) return { problem: `test-only ${rel}` };
    if (ws) {
      // A workspace's build output: compiled from its own sources, which are swept.
      if (BUILD_DIRS.has(top) && !workspaceOf.has(real)) return { leaf: true };
      if (verifiedPrismaRuntime(real, ws, generated)) return { leaf: true };
    }
    if (!SOURCE.test(real) || !existsSync(real)) return { leaf: true };
    return { follow: real };
  };

  /** Every real file `specifier` can load from `file`; `[]` when nothing resolves. */
  const resolveAll = (specifier, kind, file) => {
    const targets = new Set();
    if (kind === 'path') {
      // A reference that names no file compiles nothing in: the name is classified.
      return [resolve(dirname(file), specifier)];
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
          : ts.resolveModuleName(spec, file, options, ts.sys, cache, undefined, mode)
              .resolvedModule;
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
      for (const path of [
        resolve(dirname(file), spec),
        fileURLToPath(new URL(spec, pathToFileURL(file))),
      ]) {
        if (isFile(path)) targets.add(path);
      }
    } else if (!spec.startsWith('#')) {
      // The installed package itself, built or not (`dist/` may not exist yet).
      for (const name of kind === 'types' ? [spec, `@types/${spec}`] : [spec]) {
        const dir = packageDirectory(name, file);
        if (dir) targets.add(dir);
      }
    }
    return [...targets];
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
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
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
      const targets = resolveAll(specifier, kind, file);
      if (targets.length === 0) {
        const alias =
          specifier.startsWith('#') || configsHere.some((c) => matchesPaths(specifier, c.options));
        const what = pathLike(specifier) ? 'path' : alias ? 'alias' : 'package';
        problems.push(`${at} ${specifier}: an unresolvable ${what} cannot be checked`);
        continue;
      }
      for (const target of targets) {
        const verdict = classify(target);
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
