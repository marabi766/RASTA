import { builtinModules } from 'node:module';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import ts from 'typescript';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS, shared with the Jest specs
const { authoredFiles } = require('../../../../scripts/authored-source-inventory.cjs') as {
  authoredFiles: (dir: string) => string[];
};

/**
 * The portal's executable modules and the edges between them, by resolved
 * identity (FU-189 r2, PR-921 F1). A guard that matches import paths as text
 * misses `./gateway.ts`, a barrel's `export *` and a file it did not think to
 * read; this resolves every specifier the way the compiler does (this app's
 * tsconfig: `@/` paths, bundler resolution, `.ts` and `.js` suffixes) and
 * reads every file node or the bundler can execute.
 */

export const WEB_ROOT = join(__dirname, '..', '..');
const SRC = join(WEB_ROOT, 'src');

/** What node or the bundler executes; a declaration file (`.d.ts`, `.d.mts` …) is types only. */
const EXECUTABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION = /\.d(\.[^./]+)?\.(ts|mts|cts)$/;
/** A file only a test loads, by its own name or a test directory. Checked anyway once a checked module imports it. */
export const TEST_NAMED =
  /(^|\/)(test|__tests__|__mocks__|fixtures?)\/|(^|\/)[^/]*(\.(spec|test)\.|fixture)[^/]*$/i;
/**
 * What Next may load by its location alone, whatever the directory is called: always checked
 * (FU-219). Over-approximates Next's conventions instead of listing them, so a convention this
 * file never heard of (a metadata image, `instrumentation-client`, a numbered `icon2`) is still
 * read: every module under `app/` whose name has no dot before its extension, every module under
 * `pages/` (any name: `x.spec.tsx` is a page there), and every dotless module directly in `src/`
 * or the app's own directory. Holds while `next.config.mjs` sets no `pageExtensions`.
 */
const NEXT_LOADS = /^(src\/)?(pages\/.+|(app\/(.+\/)?)?[^./]+)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Where the check starts: what Next loads, every file not named as a test, the portal's files beside src/. */
export const isRoot = (id: string): boolean =>
  NEXT_LOADS.test(id) ||
  (id.startsWith('src/') ? !TEST_NAMED.test(id.slice(4)) : WEB_ROOT_FILES[id] === 'portal');
const LOADERS = new Set([
  'getBuiltinModule',
  '__non_webpack_require__',
  '__webpack_require__',
  '_load',
]);
/** Loader names reached as a string (`process['getBuiltinModule']`, `m['createRequire']`). */
const LOADER_NAMES = new Set([...LOADERS, 'require', 'createRequire']);
/** What `process` itself loads code or native bindings with. */
const PROCESS_LOADERS = new Set(['binding', '_linkedBinding', 'dlopen']);
/**
 * The one non-code a module may import: a static import of a stylesheet from `src/`, which Next's
 * CSS loader turns into a stylesheet. Node's loader executes any other suffix as JavaScript, and
 * webpack parses a suffix it has no rule for as JavaScript too, so every other "asset" (`.svg`,
 * `.txt`, `.json` …) and every load of one is refused until classified (FU-219). Decided on the
 * file webpack loads, not on the text (PR-949 F1): see `stylesheet` below.
 */
const ASSET = /\.css$/;
/**
 * Request syntax the bundler reads and TypeScript does not: a query or fragment (`x.txt?.css`,
 * which Next's CSS rules, matching the path only, leave to the JavaScript parser), an inline
 * loader or match resource (`!!l!./a.css`, `./x.js!=!./a.css`), a subpath import (`#x`). Refused
 * wherever it appears, whatever the rest says (PR-949 F1).
 */
const REQUEST_SYNTAX = /[?#!]/;
/** webpack's free variables (`__webpack_require__`, `__webpack_modules__` …) and magic comments. */
const WEBPACK_NAME = /^__(non_)?webpack_/;
/** …and pragmas the compiler turns into imports (`@jsxImportSource @/x` imports `@/x/jsx-runtime`). */
const MAGIC_COMMENT = /\b(webpack|turbopack)[A-Z][A-Za-z]*\s*:|@jsx(ImportSource|Runtime|Frag)?\b/;
/** Next's `resolve.extensions`, in its order (no `extensionAlias`): what webpack tries after the name. */
const BUNDLER_EXTENSIONS = ['.js', '.mjs', '.tsx', '.ts', '.jsx', '.json', '.wasm'];
/** What Next serves from `public/` as is, without compiling it: only files no browser executes. */
const INERT_PUBLIC = /^public\/.+\.(png|jpe?g|gif|webp|avif|ico|woff2?)$/;

/** A stylesheet on disk: a real file (a link to code is loaded as its target), named `.css`. */
export const isStylesheetFile = (path: string): boolean =>
  ASSET.test(path) && lstatSync(path).isFile();

/**
 * The executable files directly in `apps/web/` outside `src/`. The two the portal
 * process runs are roots; the rest never run in it. A new file here fails until
 * it is put in one list or the other.
 */
export const WEB_ROOT_FILES: Readonly<Record<string, 'portal' | string>> = {
  'next.config.mjs': 'portal',
  'upload-limit.cjs': 'portal',
  'eslint.config.mjs': 'lint tooling',
  'jest.config.cjs': 'test runner config',
  'playwright.config.ts': 'browser-test runner config',
  'postcss.config.mjs': 'CSS build step',
  'next-env.d.ts': 'types only',
};

export interface Edge {
  /** `src/server/gateway.ts`, `pkg:zod`, `node:http`, or `unresolved:<specifier>`. */
  readonly to: string;
  /** `export` is a re-export; `load` is `import()`, `require` or `import x = require()`. */
  readonly how: 'import' | 'export' | 'load';
  readonly typeOnly: boolean;
  /** The whole module as one value: `* as`, `export *`, a default, or a load. */
  readonly whole: boolean;
  readonly names: ReadonlyArray<{ readonly imported: string; readonly local: string }>;
  readonly line: number;
}

export interface ModuleFacts {
  readonly id: string;
  readonly file: ts.SourceFile;
  readonly edges: readonly Edge[];
  /** Loads it cannot name: `import(where)`, `require(x)`. */
  readonly unprovable: readonly string[];
}

const kindOf = (path: string): ts.ScriptKind =>
  /\.tsx$/.test(path)
    ? ts.ScriptKind.TSX
    : /\.(ts|mts|cts)$/.test(path)
      ? ts.ScriptKind.TS
      : /\.jsx$/.test(path)
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;

export const COMPILER_OPTIONS = (() => {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(WEB_ROOT, 'tsconfig.json'), undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  });
  if (!parsed) throw new Error('apps/web/tsconfig.json did not parse');
  return parsed.options;
})();

/** `virtual` adds or replaces files (absolute path → source) on top of the disk: the probes. */
export function importGraph(virtual: ReadonlyMap<string, string> = new Map()) {
  const host: ts.ModuleResolutionHost = {
    ...ts.sys,
    fileExists: (path) => virtual.has(path) || ts.sys.fileExists(path),
    readFile: (path) => virtual.get(path) ?? ts.sys.readFile(path),
    directoryExists: (path) =>
      [...virtual.keys()].some((file) => file.startsWith(`${path}/`)) ||
      (ts.sys.directoryExists?.(path) ?? false),
  };
  const idOf = (path: string) => relative(WEB_ROOT, path).split('\\').join('/');

  // Every file the repository authors in this app (git's view: what CI checks out and builds).
  const authored = authoredFiles(WEB_ROOT);
  const atRoot = authored.filter((path) => dirname(path) === WEB_ROOT);
  const inSrc = authored.filter(
    (path) => path.startsWith(`${SRC}/`) || /^(app|pages)\//.test(idOf(path)),
  );
  const files = [...new Set([...inSrc, ...atRoot, ...virtual.keys()])].filter(
    (path) => EXECUTABLE.test(path) && !DECLARATION.test(path),
  );
  const inventory = new Set(files.map(idOf));
  // `x.js` beside `x.ts`: the compiler resolves `./x` to one, the bundler may load the other.
  const stems = new Map<string, string[]>();
  for (const id of inventory) {
    const stem = id.replace(EXECUTABLE, '');
    stems.set(stem, [...(stems.get(stem) ?? []), id]);
  }
  const twins = [...stems.values()].filter((ids) => ids.length > 1);
  // What the bundler loads around the graph, and cannot be proven inert: refused (PR-949 F1).
  const refused = [...new Set([...authored, ...virtual.keys()])]
    .map(idOf)
    .flatMap((id) =>
      id.startsWith('public/') && !INERT_PUBLIC.test(id)
        ? [`${id} is served as is from public/ and may execute: refused`]
        : /(^|\/)package\.json$/.test(id) && id !== 'package.json'
          ? [`${id} can remap what the bundler resolves (main, browser, imports): refused`]
          : [],
    );
  // Only `name`, `scripts` and the like: no field that remaps a request (`browser`, `imports` …).
  const manifest = JSON.parse(host.readFile(join(WEB_ROOT, 'package.json')) ?? '{}') as object;
  for (const key of Object.keys(manifest))
    if (!/^(name|version|private|description|scripts|dependencies|devDependencies)$/.test(key))
      refused.push(`package.json sets ${key}, which the bundler may resolve by: refused`);
  const stylesheets = new Set([
    ...authored.filter(isStylesheetFile),
    ...[...virtual.keys()].filter((path) => ASSET.test(path)),
  ]);
  /** `./a.css`, `../a.css` or `@/a.css` from `src/`, mapped exactly: webpack's own first try. */
  const stylesheet = (specifier: string, from: string, how: Edge['how']): boolean => {
    if (how === 'load' || !from.startsWith(`${SRC}/`) || !ASSET.test(specifier)) return false;
    const target = specifier.startsWith('@/')
      ? join(SRC, specifier.slice(2))
      : /^\.\.?\//.test(specifier)
        ? join(dirname(from), specifier)
        : null;
    return target !== null && stylesheets.has(target);
  };

  const resolve = (specifier: string, from: string, how: Edge['how'], nodeLoad = false): string => {
    if (REQUEST_SYNTAX.test(specifier)) return `unresolved:${specifier}`;
    const bare = specifier.replace(/^node:/, '');
    if (specifier.startsWith('node:') || builtinModules.includes(bare)) return `node:${bare}`;
    // A Node require does not use TypeScript's .js → .ts substitution or @/ alias.
    // Accept only exact, inventoried local code; refuse other Node resolution modes.
    if (nodeLoad && /^[./@]/.test(specifier)) {
      const exact = join(dirname(from), specifier);
      return specifier.startsWith('.') &&
        EXECUTABLE.test(exact) &&
        host.fileExists(exact) &&
        inventory.has(idOf(exact))
        ? idOf(exact)
        : `unresolved:${specifier}`;
    }
    const found = ts.resolveModuleName(specifier, from, COMPILER_OPTIONS, host).resolvedModule;
    const path = found?.resolvedFileName;
    // A package that is not installed: the package list decides, as if it were.
    if (path === undefined && !/^(\.|\/|@\/)/.test(specifier)) return `pkg:${specifier}`;
    // A missing `x.css` is not an asset: webpack completes it with Next's extensions (`x.css.mjs`).
    if (path === undefined || ASSET.test(path))
      return stylesheet(specifier, from, how) ? 'asset' : `unresolved:${specifier}`;
    // By the whole specifier: `next/navigation` is not `next/dist/compiled/undici`. A workspace
    // package (`@rasta/contracts`) resolves to its own source outside this app.
    if (
      found?.isExternalLibraryImport ||
      path.includes('/node_modules/') ||
      !path.startsWith(`${WEB_ROOT}/`)
    )
      return `pkg:${specifier}`;
    // webpack tries the name as written, then each extension, then `index`: the first file it
    // finds must be the one TypeScript chose (`./x` with `x` and `x.ts`, `./d` with `d/index`).
    const base = specifier.startsWith('@/')
      ? join(SRC, specifier.slice(2))
      : join(specifier.startsWith('/') ? '' : dirname(from), specifier);
    const first = ['', ...BUNDLER_EXTENSIONS]
      .map((ext) => `${base}${ext}`)
      .concat(['', ...BUNDLER_EXTENSIONS].map((ext) => join(base, `index${ext}`)))
      .find((candidate) => host.fileExists(candidate));
    if (first !== undefined && first !== path) return `unresolved:${specifier}`;
    // In `scripts/` or `e2e/`, or a declaration standing in for code: nothing this guard reads.
    return inventory.has(idOf(path)) ? idOf(path) : `unresolved:${specifier}`;
  };

  const facts = new Map<string, ModuleFacts>();
  for (const path of files) {
    const id = idOf(path);
    const text = virtual.get(path) ?? readFileSync(path, 'utf8');
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kindOf(path));
    const edges: Edge[] = [];
    const unprovable: string[] = [];
    const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    // `webpackIgnore`, `webpackInclude` …: the bundler loads something other than the text says.
    if (MAGIC_COMMENT.test(text)) unprovable.push(`${id} carries a bundler magic comment`);
    const add = (
      node: ts.Node,
      specifier: string,
      edge: Omit<Edge, 'to' | 'line'>,
      nodeLoad = false,
    ) =>
      edges.push({ ...edge, to: resolve(specifier, path, edge.how, nodeLoad), line: lineOf(node) });

    const factories = new Set<string>();
    for (const statement of file.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !/^(node:)?module$/.test(statement.moduleSpecifier.text)
      )
        continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const item of bindings.elements)
          if ((item.propertyName ?? item.name).text === 'createRequire')
            factories.add(item.name.text);
    }
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const names = [
          ...(clause?.name ? [{ imported: 'default', local: clause.name.text }] : []),
          ...(bindings && ts.isNamedImports(bindings)
            ? bindings.elements
                .filter((e) => !e.isTypeOnly)
                .map((e) => ({ imported: (e.propertyName ?? e.name).text, local: e.name.text }))
            : []),
        ];
        const typeOnly =
          !!clause?.isTypeOnly ||
          (!!bindings &&
            ts.isNamedImports(bindings) &&
            !clause?.name &&
            bindings.elements.length > 0 &&
            names.length === 0);
        const whole = !!clause?.name || (!!bindings && ts.isNamespaceImport(bindings));
        add(node, node.moduleSpecifier.text, { how: 'import', typeOnly, whole, names });
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const clause = node.exportClause;
        const names =
          clause && ts.isNamedExports(clause)
            ? clause.elements
                .filter((e) => !e.isTypeOnly)
                .map((e) => ({ imported: (e.propertyName ?? e.name).text, local: e.name.text }))
            : [];
        const typeOnly =
          node.isTypeOnly ||
          (!!clause && ts.isNamedExports(clause) && clause.elements.length > 0 && !names.length);
        add(node, node.moduleSpecifier.text, {
          how: 'export',
          typeOnly,
          whole: !clause || ts.isNamespaceExport(clause),
          names,
        });
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        const expression = node.moduleReference.expression;
        if (ts.isStringLiteralLike(expression)) {
          add(
            node,
            expression.text,
            {
              how: 'load',
              typeOnly: node.isTypeOnly,
              whole: true,
              names: [],
            },
            true,
          );
        } else unprovable.push(`${id}:${lineOf(node)} loads a module it cannot name`);
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const [specifier] = node.arguments;
        if (specifier && ts.isStringLiteralLike(specifier)) {
          add(
            node,
            specifier.text,
            { how: 'load', typeOnly: false, whole: true, names: [] },
            node.expression.kind !== ts.SyntaxKind.ImportKeyword,
          );
        } else unprovable.push(`${id}:${lineOf(node)} loads a module it cannot name`);
      }
      // Model only the inline factory at this module's actual URL. Escaping it,
      // another base, namespace/default imports and computed access are refused.
      if (ts.isIdentifier(node) && factories.has(node.text) && !ts.isImportSpecifier(node.parent)) {
        const factory = node.parent;
        const load = factory.parent;
        if (
          ts.isCallExpression(factory) &&
          factory.expression === node &&
          factory.arguments.length === 1 &&
          factory.arguments[0]?.getText(file) === 'import.meta.url' &&
          ts.isCallExpression(load) &&
          load.expression === factory &&
          load.arguments.length === 1 &&
          ts.isStringLiteralLike(load.arguments[0]!)
        )
          add(
            load,
            (load.arguments[0] as ts.StringLiteralLike).text,
            {
              how: 'load',
              typeOnly: false,
              whole: true,
              names: [],
            },
            true,
          );
        else unprovable.push(`${id}:${lineOf(node)} escapes a loader factory or its base`);
      }
      // `import.meta.webpackContext`, `.webpackHot`, `new URL(x, import.meta.url)`: only the
      // modelled factory's base is read (PR-949 F1).
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        const url = node.parent;
        const call = url.parent;
        if (
          !ts.isPropertyAccessExpression(url) ||
          url.name.text !== 'url' ||
          !ts.isCallExpression(call) ||
          call.arguments[0] !== url ||
          !ts.isIdentifier(call.expression) ||
          !factories.has(call.expression.text)
        )
          unprovable.push(`${id}:${lineOf(node)} uses import.meta other than as a factory's base`);
      }
      // `const r = require`, `module.require`, `require.context`, `process.getBuiltinModule('http')`,
      // webpack's own loaders: a load with no specifier to resolve.
      if (
        ts.isIdentifier(node) &&
        (LOADERS.has(node.text) ||
          WEBPACK_NAME.test(node.text) ||
          // AMD (`define([...], f)`), which webpack's parser still reads in Next.
          (node.text === 'define' &&
            !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) ||
          (node.text === 'require' &&
            !(ts.isCallExpression(node.parent) && node.parent.expression === node)))
      )
        unprovable.push(`${id}:${lineOf(node)} reaches ${node.text} other than as a named load`);
      // The same capabilities by a string, and `process`'s own loaders by any name (FU-219).
      if (ts.isStringLiteralLike(node) && LOADER_NAMES.has(node.text))
        unprovable.push(`${id}:${lineOf(node)} names the loader ${node.text} as a string`);
      // `module.hot.accept('./x')`, `module.constructor` …: only `module.exports` is modelled.
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'module' &&
        !(ts.isPropertyAccessExpression(node) && node.name.text === 'exports')
      )
        unprovable.push(`${id}:${lineOf(node)} reaches module other than module.exports`);
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'process' &&
        (ts.isPropertyAccessExpression(node)
          ? PROCESS_LOADERS.has(node.name.text)
          : !ts.isStringLiteralLike(node.argumentExpression) ||
            PROCESS_LOADERS.has(node.argumentExpression.text))
      )
        unprovable.push(`${id}:${lineOf(node)} reaches a loader of process`);
      ts.forEachChild(node, visit);
    };
    visit(file);
    facts.set(id, { id, file, edges, unprovable });
  }

  const checked = new Set<string>();
  const pending = [...inventory].filter(isRoot);
  while (pending.length > 0) {
    const id = pending.pop() as string;
    if (checked.has(id)) continue;
    checked.add(id);
    for (const edge of facts.get(id)?.edges ?? [])
      if (!edge.typeOnly && inventory.has(edge.to)) pending.push(edge.to);
  }
  const rootFiles = [
    ...new Set([...atRoot, ...virtual.keys()].filter((p) => dirname(p) === WEB_ROOT)),
  ]
    .map(idOf)
    .filter((id) => EXECUTABLE.test(id));
  return { facts, inventory, checked: [...checked].sort(), rootFiles, twins, refused };
}
