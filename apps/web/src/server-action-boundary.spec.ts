import { join, relative } from 'node:path';

import { COMPILED_EXTENSIONS, workspacePackageDirs } from './test/server-action-discovery';
import {
  ALLOWED_REACH,
  NEXT_CONFIG_FILE,
  nextCompiledExtensions,
  nextConfigFiles,
  outsideScanned,
  reachOptionsIn,
  readText,
  tsconfigTargets,
} from './test/server-action-boundary';

/**
 * A fast local early warning; the authority is the compiler's manifest (checked after
 * `next build` in a separate, stacked change). Not extended per reviewer path.
 *
 * The fence around `test/server-action-discovery.ts`: discovery is complete only if the
 * web build cannot compile a source it does not scan. Each failure below names what to do.
 */
const REPO_ROOT = join(__dirname, '../../..');
const APP = join(__dirname, '..');
const ROOTS = [APP, ...workspacePackageDirs(REPO_ROOT, APP)];

it('lists every extension the installed Next compiles', () => {
  const next = nextCompiledExtensions(
    readText(require.resolve('next/dist/build/webpack-config.js')),
  );
  const missing = next.filter((ext) => !(COMPILED_EXTENSIONS as readonly string[]).includes(ext));
  expect(missing.map((ext) => `.${ext}: Next compiles it, add it to COMPILED_EXTENSIONS`)).toEqual(
    [],
  );
});

it('has next.config without an option that reaches sources outside the scanned set', () => {
  const files = nextConfigFiles(APP);
  expect(files).toEqual([NEXT_CONFIG_FILE]);
  const reach = files.flatMap((file) =>
    reachOptionsIn(readText(join(APP, file)), file).map(
      (option) =>
        `${file}: ${option}: extend server-action discovery to what it reaches first (allow-list: ${JSON.stringify(ALLOWED_REACH)})`,
    ),
  );
  expect(reach).toEqual([]);
});

it('has every tsconfig path target inside a scanned root', () => {
  const outside = outsideScanned(tsconfigTargets(join(APP, 'tsconfig.json')), ROOTS).map(
    (target) => `${relative(REPO_ROOT, target)}: extend server-action discovery to it first`,
  );
  expect(outside).toEqual([]);
});

describe('boundary checks (negative control)', () => {
  const rule = (or: string, extra = ''): string =>
    `const codeCondition = { test: { or: [ ${or} ] }, ${extra} exclude: x };`;
  const REAL = '/\\.(tsx|ts|js|cjs|mjs|jsx)$/, /__barrel_optimize__/';
  it('reads the compiled extensions from a webpack rule', () => {
    expect(nextCompiledExtensions(rule(REAL))).toEqual(['cjs', 'js', 'jsx', 'mjs', 'ts', 'tsx']);
  });
  it('ignores the same text in a comment', () => {
    expect(nextCompiledExtensions(`// /\\.(zzz)$/, /__barrel_optimize__/\n${rule(REAL)}`)).toEqual([
      'cjs',
      'js',
      'jsx',
      'mjs',
      'ts',
      'tsx',
    ]);
  });
  it.each([
    ['nothing', 'nothing'],
    ['an added branch (r4 F3)', rule(`${REAL}, /\\.mts$/`)],
    ['a different second term', rule('/\\.(ts)$/, /other/')],
    ['one term', rule('/\\.(ts)$/')],
    ['a computed term', rule('makeRegex(), /__barrel_optimize__/')],
    ['a spread', rule('...more, /\\.(ts)$/, /__barrel_optimize__/')],
    ['an uppercase extension', rule('/\\.(TS)$/, /__barrel_optimize__/')],
    ['two declarations', `${rule(REAL)}\n${rule(REAL)}`],
    ['an extra `test` key', `const codeCondition = { test: { or: [ ${REAL} ], and: [] } };`],
  ])('refuses a rule it cannot read: %s', (_name, source) => {
    expect(() => nextCompiledExtensions(source)).toThrow();
  });
  it.each([
    ['transpilePackages', "export default { transpilePackages: ['@rasta/contracts'] };"],
    ['externalDir', 'export default { experimental: { externalDir: true } };'],
    ['webpack', 'export default { webpack(config) { return config; } };'],
    ['a string key', "export default { 'transpilePackages': [] };"],
    ['a tsconfig path', "export default { typescript: { tsconfigPath: 'tsconfig.build.json' } };"],
  ])('finds %s', (_name, source) => {
    expect(reachOptionsIn(source, 'next.config.mjs')).not.toEqual([]);
  });
  it('ignores a comment', () => {
    expect(reachOptionsIn('// transpilePackages\nexport default {};', 'next.config.mjs')).toEqual(
      [],
    );
  });
  it('finds a target outside the roots, not one inside', () => {
    expect(outsideScanned(['/r/packages/config/src', '/r/apps/web/src'], ['/r/apps/web'])).toEqual([
      '/r/packages/config/src',
    ]);
  });
});
