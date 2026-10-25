// Scope of the eligibility-clock guard: which files are test, fixture, script
// or test-support code, found by IMPORT GRAPH rather than by file name.
//
// TEST ENTRY POINTS
//   - spec/test files anywhere: *.spec.*, *.test.*, *.int-spec.*, *.e2e-spec.*,
//     *.live-spec.*, *.pg.test.*;
//   - every source file under a test/, tests/, e2e/ or __tests__ directory;
//   - jest/playwright configuration files and every path they name
//     (setupFiles, globalSetup, globalTeardown, …);
//   - files run by `test*`, `verify*`, `check*` and `ci:*` package scripts
//     (root and workspaces), e.g. scripts/verify-outbox-claim-migration.mjs.
// From those, static imports, re-exports, literal dynamic import()/require()
// and require.resolve() are followed. A relative or @rasta/* specifier that
// does not resolve to a file REFUSES (unresolved import), as does a
// dynamic import()/require() of a computed specifier, unless
// REVIEWED_COMPUTED_IMPORTS (below) names that file and argument and says what
// it loads.
//
// PRODUCTION ROOTS (boundary)
//   Production = the files reachable, by the same import rules, from
//   services/<name>/src/main.ts, services/<name>/src/**/*.cli.ts (operator
//   commands), services/<name>/prisma/seed.ts, packages/<name>/src/index.ts
//   (except packages/testing), and every non-test file under apps/<name>/src
//   (Next.js discovers routes by file convention, not by import). A test that imports a production repository reaches it
//   but does not make it test code: production files are never enforced.
//   Everything else that a test entry reaches is enforced: packages/testing,
//   scripts/, apps/*/e2e, tests/, test helpers, and test support that lives
//   under services/*/src but is not reachable from main.ts.
//   Prisma's generated client and node_modules are external.
//   SQL fixture files (*.sql) outside prisma/migrations and infrastructure/
//   are enforced as fixtures (they are read with fs, not imported).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import ts from 'typescript';
import { SOURCE, files, walk } from './eligibility-clock-derive.mjs';

const TEST_FILE =
  /\.(?:spec|test|int-spec|e2e-spec|live-spec)\.[cm]?[jt]sx?$|\.pg\.test\.[cm]?[jt]s$/;
const TEST_DIRECTORY = /(?:^|\/)(?:test|tests|e2e|__tests__)\//;
const CONFIG = /(?:^|\/)(?:jest|playwright)\.config\.[cm]?[jt]s$|(?:^|\/)jest\.setup\.[cm]?[jt]s$/;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve a specifier from `from`; null = external, false = unresolved (refuse). */
export { REVIEWED_COMPUTED_IMPORTS };

export function resolveSpecifier(repository, from, specifier, aliases = []) {
  if (specifier.startsWith('node:') || specifier === 'typescript') return null;
  const candidates = (base) => {
    const out = [
      base,
      ...EXTENSIONS.map((e) => base + e),
      ...EXTENSIONS.map((e) => join(base, 'index' + e)),
    ];
    const js = /\.(c|m)?js$/.exec(base);
    if (js) {
      const stem = base.slice(0, -js[0].length);
      out.push(...['.ts', '.tsx', '.mts', '.cts'].map((e) => stem + e));
    }
    return out;
  };
  let base = null;
  if (specifier.startsWith('.') || specifier.startsWith('/'))
    base = resolvePath(dirname(from), specifier);
  else if (specifier.startsWith('@rasta/')) {
    const [, name, ...rest] = specifier.split('/');
    const roots = [join(repository, 'packages', name), join(repository, 'services', name)];
    const packageRoot = roots.find((r) => existsSync(join(r, 'package.json')));
    const workspace =
      packageRoot ?? findWorkspace(repository, specifier.split('/').slice(0, 2).join('/'));
    if (!workspace) return false;
    let sub = rest.join('/');
    if (!sub) base = join(workspace, 'src', 'index');
    else {
      sub = sub.replace(/^dist\//, 'src/');
      base = join(workspace, sub);
    }
  } else {
    const alias = aliases.find(
      (a) => specifier === a.prefix.replace(/\/$/, '') || specifier.startsWith(a.prefix),
    );
    if (alias) base = join(alias.target, specifier.slice(alias.prefix.length));
    else return null; // a node_modules package
  }
  if (/\/generated\//.test(base) || /\/generated$/.test(base)) return null;
  const hit = candidates(base).find(isFile);
  if (!hit) return false;
  return relative(repository, hit);
}

function resolveAbsolute(repository, absolute) {
  if (!absolute.startsWith(repository)) return false;
  if (/\/generated(?:\/|$)/.test(absolute)) return null;
  const local = relative(repository, absolute).replace(
    /^(services|packages)\/([^/]+)\/dist\//,
    '$1/$2/src/',
  );
  return resolveSpecifier(repository, join(repository, 'x'), './' + local);
}

const workspaceCache = new Map();
function findWorkspace(repository, name) {
  if (!workspaceCache.size)
    for (const base of ['apps', 'packages', 'services', 'tests'])
      for (const path of files(join(repository, base)).filter((p) => p.endsWith('/package.json'))) {
        try {
          workspaceCache.set(JSON.parse(readFileSync(path, 'utf8')).name, dirname(path));
        } catch {
          /* not a workspace manifest */
        }
      }
  return workspaceCache.get(name) ?? null;
}

/** tsconfig `paths` aliases (e.g. apps/web `@/*`), read leniently (comments allowed). */
function aliasesFor(repository, local) {
  const parts = local.split('/');
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const dir = join(repository, ...parts.slice(0, i));
    const config = join(dir, 'tsconfig.json');
    if (!isFile(config)) continue;
    const parsed = ts.parseConfigFileTextToJson(config, readFileSync(config, 'utf8')).config ?? {};
    const paths = parsed.compilerOptions?.paths ?? {};
    const baseUrl = join(dir, parsed.compilerOptions?.baseUrl ?? '.');
    return Object.entries(paths).map(([key, [target]]) => ({
      prefix: key.replace(/\*$/, ''),
      target: join(baseUrl, target.replace(/\*$/, '')),
    }));
  }
  return [];
}

/** Edges of one file: [{specifier, resolved, line}] plus refusals. */
export function edges(repository, local) {
  const path = join(repository, local);
  const source = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const aliases = aliasesFor(repository, local);
  const out = [];
  const refusals = [];
  const reviewedImports = [];
  const line = (node) => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
  const add = (node, specifier) => {
    const resolved = specifier.startsWith('/')
      ? resolveAbsolute(repository, specifier)
      : resolveSpecifier(repository, path, specifier, aliases);
    if (resolved === false)
      refusals.push(`${local}:${line(node)}: unresolved import '${specifier}'`);
    else if (resolved) out.push({ specifier, resolved, line: line(node) });
  };
  const config = CONFIG.test(local);
  walk(ast, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      add(node, node.moduleSpecifier.text);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      add(node, node.moduleReference.expression.text);
    else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(ast);
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (dynamic || callee === 'require' || callee === 'require.resolve') {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) add(node, arg.text);
        else {
          const value = arg && constantPath(arg, path, ast);
          const reviewed = REVIEWED_COMPUTED_IMPORTS.find(
            (r) => r.file === local && r.argument === arg?.getText(ast),
          );
          if (value) add(node, value);
          else if (reviewed) reviewedImports.push({ ...reviewed, line: line(node) });
          else refusals.push(`${local}:${line(node)}: computed import specifier`);
        }
      } else if (
        /^jest\.(?:mock|requireActual|doMock)$/.test(callee) &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      )
        add(node, node.arguments[0].text);
    } else if (
      config &&
      ts.isStringLiteralLike(node) &&
      /^(?:<rootDir>\/|\.\.?\/)[^*]*\.[cm]?[jt]sx?$/.test(node.text)
    )
      add(node, node.text.replace('<rootDir>/', './'));
  });
  return { edges: out, refusals, reviewedImports, ast };
}

/**
 * A module path computed from constants only: string literals, import.meta
 * dirname/url, __dirname, join/resolve, new URL(…, import.meta.url),
 * pathToFileURL(…).href, fileURLToPath(…), and const bindings of those.
 * Returns an absolute path, or null when any part is not a constant.
 */
function constantPath(node, path, ast, depth = 0) {
  if (!node || depth > 8) return null;
  const again = (n) => constantPath(n, path, ast, depth + 1);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return again(node.expression);
  if (ts.isStringLiteralLike(node)) return node.text;
  const text = node.getText(ast);
  if (text === 'import.meta.dirname' || text === '__dirname') return dirname(path);
  if (text === 'import.meta.url') return 'file://' + path;
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const part = again(span.expression);
      if (part === null) return null;
      out += part + span.literal.text;
    }
    return out;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const [l, r] = [again(node.left), again(node.right)];
    return l === null || r === null ? null : l + r;
  }
  if (ts.isPropertyAccessExpression(node) && ['href', 'pathname'].includes(node.name.text)) {
    const inner = again(node.expression);
    return inner === null ? null : inner.replace(/^file:\/\//, '');
  }
  if (ts.isNewExpression(node) && node.expression.getText(ast) === 'URL') {
    const [rel, base] = (node.arguments ?? []).map(again);
    if (rel === null || base === null || base === undefined) return null;
    return new URL(rel, base.startsWith('file://') ? base : 'file://' + base).pathname;
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText(ast).replace(/^path\./, '');
    const args = node.arguments.map(again);
    if (args.some((a) => a === null)) return null;
    if (callee === 'join') return join(...args);
    if (callee === 'resolve') return resolvePath(...args);
    if (callee === 'dirname') return dirname(args[0]);
    if (callee === 'pathToFileURL' || callee === 'fileURLToPath' || callee === 'url.fileURLToPath')
      return args[0].replace(/^file:\/\//, '');
    return null;
  }
  if (ts.isIdentifier(node)) {
    let found = null;
    walk(ast, (n) => {
      if (
        !found &&
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === node.text &&
        n.initializer &&
        n.parent.flags & ts.NodeFlags.Const
      )
        found = n.initializer;
    });
    return found ? again(found) : null;
  }
  return null;
}

/**
 * Computed specifiers that cannot be constants, each reviewed: what it loads
 * and why that module is not a test write path the scan misses.
 */
const REVIEWED_COMPUTED_IMPORTS = [
  {
    file: 'scripts/outbox-b3-protocol.pg.test.mjs',
    argument: "join(serviceDir, 'src', 'generated', 'prisma')",
    loads: 'the generated Prisma client of a service (external, generated code)',
  },
  {
    file: 'scripts/outbox-b2-prisma-port.mjs',
    argument: 'generated',
    loads: "join(serviceDir, 'src', 'generated', 'prisma'): the generated Prisma client (external)",
  },
  {
    file: 'scripts/aggregation-campaign-preflight.test.mjs',
    argument: 'pathToFileURL(file).href',
    loads:
      'a mutated temporary copy of scripts/aggregation-campaign-preflight-lib.mjs (scanned as itself); opens no database',
  },
  {
    file: 'apps/web/src/write-session-refusal.spec.ts',
    argument: '`./${path}`',
    loads: 'the apps/web/src server-action modules named in MODULES: production (apps/*/src)',
  },
  {
    file: 'apps/web/src/token-roles-screens.spec.ts',
    argument: 'path',
    loads: 'apps/web/src page modules: production (apps/*/src)',
  },
  {
    file: 'apps/web/src/app/demo-mode-pages.spec.ts',
    argument: 'path',
    loads: 'apps/web/src page modules: production (apps/*/src)',
  },
];

function packageScriptEntries(repository) {
  const entries = [];
  const manifests = [join(repository, 'package.json')];
  for (const base of ['apps', 'packages', 'services', 'tests'])
    manifests.push(...files(join(repository, base)).filter((p) => p.endsWith('/package.json')));
  for (const manifest of manifests) {
    const scripts = JSON.parse(readFileSync(manifest, 'utf8')).scripts ?? {};
    for (const [name, command] of Object.entries(scripts)) {
      if (!/^(?:test|verify|check|ci)(?::|$)/.test(name)) continue;
      for (const match of command.matchAll(
        /(?:^|\s)((?:\.{0,2}\/)?[\w./-]+\.(?:[cm]?[jt]s|tsx))(?=\s|$|&|;)/g,
      )) {
        const path = resolvePath(dirname(manifest), match[1]);
        if (isFile(path)) entries.push(relative(repository, path));
      }
    }
  }
  return entries;
}

export function testEntryPoints(repository) {
  const all = ['apps', 'packages', 'services', 'scripts', 'tests'].flatMap((b) =>
    files(join(repository, b)).map((p) => relative(repository, p)),
  );
  const entries = all.filter(
    (local) =>
      SOURCE.test(local) &&
      !local.endsWith('.d.ts') &&
      (TEST_FILE.test(local) || TEST_DIRECTORY.test(local) || CONFIG.test(local)),
  );
  return [...new Set([...entries, ...packageScriptEntries(repository)])].sort();
}

export function productionEntryPoints(repository) {
  const out = [];
  for (const base of ['services', 'packages'])
    for (const dir of files(join(repository, base))
      .filter((p) => p.endsWith('/package.json'))
      .map(dirname)) {
      const local = relative(repository, dir);
      if (local === 'packages/testing' || local.split('/').length !== 2) continue;
      for (const entry of ['src/main.ts', 'src/index.ts', 'prisma/seed.ts'])
        if (isFile(join(dir, entry))) out.push(join(local, entry));
      for (const path of files(join(dir, 'src')).filter((p) => /\.cli\.ts$/.test(p)))
        out.push(relative(repository, path));
    }
  for (const path of files(join(repository, 'apps'))) {
    const local = relative(repository, path);
    if (
      /^apps\/[^/]+\/src\//.test(local) &&
      SOURCE.test(local) &&
      !TEST_FILE.test(local) &&
      !TEST_DIRECTORY.test(local.slice(local.indexOf('/src/')))
    )
      out.push(local);
  }
  return out;
}

function closure(repository, roots, cache) {
  const seen = new Set();
  const refusals = [];
  const stack = [...roots];
  while (stack.length) {
    const local = stack.pop();
    if (seen.has(local)) continue;
    seen.add(local);
    if (!SOURCE.test(local)) continue;
    let result = cache.get(local);
    if (!result) {
      result = edges(repository, local);
      cache.set(local, result);
    }
    refusals.push(...result.refusals);
    for (const edge of result.edges) stack.push(edge.resolved);
  }
  return { files: seen, refusals };
}

/** {enforced: Set(local), production: Set(local), refusals: string[], sqlFixtures: [local]} */
export function scope(repository, entries = testEntryPoints(repository)) {
  const cache = new Map();
  const production = closure(repository, productionEntryPoints(repository), cache).files;
  const tests = closure(repository, entries, cache);
  const enforced = new Set(
    [...tests.files].filter(
      (local) => !production.has(local) && SOURCE.test(local) && !local.endsWith('.d.ts'),
    ),
  );
  // Production refusals (an unresolved import in product code) are not this guard's business.
  const sqlFixtures = ['apps', 'packages', 'services', 'scripts', 'tests']
    .flatMap((b) => files(join(repository, b)).map((p) => relative(repository, p)))
    .filter((local) => local.endsWith('.sql') && !/\/prisma\/migrations\//.test(local));
  const refusals = [...new Set(tests.refusals)].filter((r) => enforced.has(r.split(':')[0]));
  return { enforced, production, refusals, sqlFixtures, cache };
}
