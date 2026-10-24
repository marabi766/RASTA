import { join, relative } from 'node:path';

import { COMPILED_EXTENSIONS, workspacePackageDirs } from './test/server-action-discovery';
import {
  ALLOWED_REACH,
  nextCompiledExtensions,
  nextConfigFiles,
  outsideScanned,
  reachOptionsIn,
  readText,
  tsconfigTargets,
} from './test/server-action-boundary';

/**
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
  expect(files.length).toBe(1);
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
  it('reads the compiled extensions from a webpack rule', () => {
    expect(
      nextCompiledExtensions(
        'test: { or: [ /\\.(tsx|ts|js|cjs|mjs|jsx)$/, /__barrel_optimize__/ ] }',
      ),
    ).toEqual(['cjs', 'js', 'jsx', 'mjs', 'ts', 'tsx']);
  });
  it('refuses a rule it cannot read', () => {
    expect(() => nextCompiledExtensions('nothing')).toThrow();
  });
  it.each([
    ['transpilePackages', "export default { transpilePackages: ['@rasta/contracts'] };"],
    ['externalDir', 'export default { experimental: { externalDir: true } };'],
    ['webpack', 'export default { webpack(config) { return config; } };'],
    ['a string key', "export default { 'transpilePackages': [] };"],
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
