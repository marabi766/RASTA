import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ESLint, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import {
  MINTER_NAME,
  REPO_ROOT,
  SIGNER_MARKER,
  TESTING_DIR,
  devOnlyRule,
  imageTreeProblems,
  isTestOnlyPath,
  pnpmProdGraph,
  prodGraphProblems,
} from './testing-dev-only.mjs';

/**
 * scripts/testing-dev-only.mjs keeps the test signer in @rasta/testing out of
 * production in three layers: source imports, the resolved production
 * dependency graph, and the built image's filesystem (the last runs in CI's
 * `containers` job; its scanner is tested here on fixture trees).
 */

const write = (root, files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};
const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'testing-dev-only-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ---- 1. Source --------------------------------------------------------------

const PROD = join(REPO_ROOT, 'services/x-service/src/x/x.service.ts');
const forms = [
  ["import { mintTestInternalToken } from '@rasta/testing';", 'static import'],
  ["import type { TestInternalTokenKey } from '@rasta/testing';", 'type-only import'],
  ["import '@rasta/testing/dist/internal-token';", 'subpath side-effect import'],
  ["export { mintTestInternalToken } from '@rasta/testing';", 'export-from'],
  ["export * from '@rasta/testing';", 'export-all'],
  ["const m = await import('@rasta/testing');", 'dynamic import()'],
  ['const m = await import(`@rasta/testing`);', 'dynamic import() with a template'],
  ["const m = require('@rasta/testing');", 'require'],
  ["const p = require.resolve('@rasta/testing');", 'require.resolve'],
  ["const m = module.require('@rasta/testing');", 'module.require'],
  ["import t = require('@rasta/testing');", 'import = require'],
  ["type K = import('@rasta/testing').TestInternalTokenKey;", 'import() type'],
  ["import { x } from '../../../../packages/testing/src/internal-token';", 'relative path'],
  ["import { x } from '../../../../packages/testing';", 'relative package root'],
  [`import { x } from '${join(REPO_ROOT, 'packages/testing/dist/index.js')}';`, 'absolute path'],
  ["import { x } from '../../node_modules/@rasta/testing';", 'path through node_modules'],
  ["import { x } from '../../test/api-helpers';", 'a test-only file'],
];

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
});

test('every module form that reaches @rasta/testing is refused in production source', () => {
  ruleTester.run('testing/dev-only', devOnlyRule, {
    valid: [
      { code: "import { z } from '@rasta/contracts';", filename: PROD },
      { code: "import { a } from './a';", filename: PROD },
      { code: "import { t } from '@rasta/testing-tools';", filename: PROD },
      // A lint config loading its rules from root scripts/.
      {
        code: "import rule from '../../scripts/no-zod-default-rule.mjs';",
        filename: join(REPO_ROOT, 'apps/web/eslint.config.mjs'),
      },
    ],
    invalid: [
      ...forms.map(([code, name]) => ({
        name,
        code,
        filename: PROD,
        errors: [{ messageId: 'reaches' }],
      })),
      { code: 'const m = await import(name);', filename: PROD, errors: [{ messageId: 'dynamic' }] },
      { code: 'const m = require(name);', filename: PROD, errors: [{ messageId: 'dynamic' }] },
      // Fail closed: a file kind nobody listed (prisma/, dev/, a new dir) is production.
      ...['prisma/seed.ts', 'dev/telemetry.ts', 'jobs/new-kind.ts', 'src/x.fixture.ts'].map(
        (path) => ({
          code: forms[0][0],
          filename: join(REPO_ROOT, 'services/x-service', path),
          errors: [{ messageId: 'reaches' }],
        }),
      ),
    ],
  });
});

test('every module form is allowed in test-only files', () => {
  const testFiles = [
    'services/x-service/src/x/x.service.spec.ts',
    'services/x-service/src/x/x.int-spec.ts',
    'services/x-service/test/api-helpers.ts',
    'packages/nest-common/src/auth/__tests__/helper.ts',
    'apps/web/e2e/expect.ts',
    'apps/web/src/lib/x.test.tsx',
    'tests/e2e/src/internal.ts',
    'packages/testing/src/index.ts',
  ];
  ruleTester.run('testing/dev-only', devOnlyRule, {
    valid: testFiles.flatMap((path) =>
      forms.map(([code]) => ({ code, filename: join(REPO_ROOT, path) })),
    ),
    invalid: [],
  });
  assert.ok(!isTestOnlyPath('services/x-service/src/main.ts'));
  assert.ok(!isTestOnlyPath('apps/web/src/app/page.tsx'));
});

test('no production source file in apps/, services/ or packages/ reaches @rasta/testing', async () => {
  // Every file on disk, not the lint scripts' lists: a file no lint script
  // names (a new directory, a service-local script) is still checked.
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      {
        ignores: [
          '**/node_modules/**',
          '**/dist/**',
          '**/.next/**',
          '**/coverage/**',
          '**/src/generated/**',
        ],
      },
      {
        files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
          ecmaVersion: 'latest',
          sourceType: 'module',
        },
        linterOptions: { reportUnusedDisableDirectives: 'off', noInlineConfig: true },
        plugins: { testing: { rules: { 'dev-only': devOnlyRule } } },
        rules: { 'testing/dev-only': 'error' },
      },
    ],
  });
  const results = await eslint.lintFiles([
    'apps/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
    'services/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
    'packages/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
  ]);
  const production = results.filter((r) => !isTestOnlyPath(r.filePath.slice(REPO_ROOT.length)));
  assert.ok(production.length > 1000, `only ${production.length} production files linted`);
  // A file that does not parse cannot be checked, so it is a problem too.
  const problems = results.flatMap((r) =>
    r.messages
      .filter((m) => m.ruleId === 'testing/dev-only' || m.fatal)
      .map((m) => `${r.filePath.slice(REPO_ROOT.length)}:${m.line} ${m.message}`),
  );
  assert.deepEqual(problems, []);
});

// ---- 2. Dependencies --------------------------------------------------------

test('no workspace project resolves @rasta/testing in its production graph', () => {
  const projects = pnpmProdGraph(REPO_ROOT);
  assert.ok(projects.length >= 26, `only ${projects.length} workspace projects listed`);
  for (const name of [
    '@rasta/fleet-service',
    '@rasta/api-gateway',
    '@rasta/nest-common',
    '@rasta/web',
  ]) {
    assert.ok(
      projects.some((p) => p.name === name),
      `${name} missing from pnpm list`,
    );
  }
  assert.deepEqual(prodGraphProblems(projects, TESTING_DIR), []);
});

test('an aliased production dependency on @rasta/testing is found through the pnpm graph', (t) => {
  // A real workspace, installed by pnpm (offline: nothing outside it), so the
  // graph is pnpm's own resolution of each alias form.
  const root = scratch(t);
  const manifest = (name, dependencies) => JSON.stringify({ name, version: '0.1.0', dependencies });
  write(root, {
    'package.json': JSON.stringify({ name: 'root', private: true }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n  - services/*\n',
    'packages/testing/package.json': manifest('@rasta/testing'),
    'packages/clean/package.json': manifest('@rasta/clean'),
    'services/workspace-alias/package.json': manifest('@rasta/a', {
      signing: 'workspace:@rasta/testing@*',
    }),
    'services/link-alias/package.json': manifest('@rasta/b', {
      signing: 'link:../../packages/testing',
    }),
    'services/file-alias/package.json': manifest('@rasta/c', {
      signing: 'file:../../packages/testing',
    }),
    'packages/middle/package.json': manifest('@rasta/middle', { t: 'workspace:@rasta/testing@*' }),
    'services/transitive/package.json': manifest('@rasta/d', { '@rasta/middle': 'workspace:*' }),
    'services/dev-only/package.json': JSON.stringify({
      name: '@rasta/e',
      version: '0.1.0',
      dependencies: { '@rasta/clean': 'workspace:*' },
      devDependencies: { '@rasta/testing': 'workspace:*' },
    }),
  });
  const install = spawnSync('pnpm', ['install', '--offline', '--no-frozen-lockfile'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const problems = prodGraphProblems(pnpmProdGraph(root), join(root, 'packages/testing'));
  assert.deepEqual(problems.sort(), [
    '@rasta/a → signing (link:../../packages/testing)',
    '@rasta/b → signing (link:../../packages/testing)',
    '@rasta/c → signing (link:../../packages/testing)',
    '@rasta/d → @rasta/middle (link:../../packages/middle) → t (link:../../packages/testing)',
    '@rasta/middle → t (link:../testing)',
  ]);
});

test('a dependency is identified by its manifest name wherever it is installed', (t) => {
  const root = scratch(t);
  write(root, {
    'packages/testing/package.json': '{"name":"@rasta/testing"}',
    'store/vendored/package.json': '{"name":"@rasta/testing"}',
    'store/other/package.json': '{"name":"other"}',
  });
  const projects = [
    {
      name: '@rasta/x',
      path: join(root, 'x'),
      dependencies: {
        other: { version: '1.0.0', path: join(root, 'store/other') },
        renamed: { version: '1.0.0', path: join(root, 'store/vendored') },
      },
    },
  ];
  assert.deepEqual(prodGraphProblems(projects, join(root, 'packages/testing')), [
    '@rasta/x → renamed (1.0.0)',
  ]);
});

// ---- 3. Images --------------------------------------------------------------

const MINTER = readFileSync(join(TESTING_DIR, 'src/internal-token.ts'), 'utf8');

test('the minter carries the marker the image check looks for', () => {
  assert.ok(MINTER.includes(SIGNER_MARKER), 'internal-token.ts lost SIGNER_MARKER');
  assert.ok(MINTER.includes(`function ${MINTER_NAME}`));
});

const CLEAN_IMAGE = {
  'app/package.json':
    '{"name":"@rasta/x-service","devDependencies":{"@rasta/testing":"workspace:*"}}',
  'app/dist/main.js': 'require("./app.module");',
  'app/node_modules/@rasta/nest-common/package.json': '{"name":"@rasta/nest-common"}',
  'app/node_modules/broken/package.json': '{ not json',
  // A service's own test sources ship in its directory; they name the minter
  // but cannot resolve it without the package.
  'app/test/api-helpers.ts': `import { ${MINTER_NAME} } from '@rasta/testing';`,
  'app/src/x/x.service.spec.ts': `const t = ${MINTER_NAME};`,
};

test('a clean image filesystem passes', (t) => {
  const root = scratch(t);
  write(root, CLEAN_IMAGE);
  assert.deepEqual(imageTreeProblems(root), []);
});

test('the test signer or its package anywhere in an image filesystem is refused', (t) => {
  const cases = {
    'aliased install': { 'app/node_modules/signing/package.json': '{"name":"@rasta/testing"}' },
    'pnpm store entry': {
      'app/node_modules/.pnpm/@rasta+testing@file+packages+testing/node_modules/x/index.js': '',
    },
    'scoped directory without manifest': { 'app/node_modules/@rasta/testing/x.js': '' },
    'copied package with renamed manifest': {
      'app/vendor-signing/package.json': '{"name":"vendor"}',
      'app/vendor-signing/dist/internal-token.js': `throw new Error('... (${SIGNER_MARKER})');`,
    },
    'bundled minter': { 'app/dist/chunk-1.js': `e("x (${SIGNER_MARKER})")` },
    'compiled caller': { 'app/dist/auth/token.js': `(0, t.${MINTER_NAME})(key)` },
    'source map': { 'app/dist/main.js.map': `{"names":["${MINTER_NAME}"]}` },
    'declaration file': { 'app/dist/x.d.ts': `export { ${MINTER_NAME} }` },
    'minter source copied as TypeScript': {
      'app/signing.ts': `export function ${MINTER_NAME}() { throw new Error('${SIGNER_MARKER}'); }`,
    },
    'unreadable manifest naming the package': {
      'app/node_modules/x/package.json': '{ "name": "@rasta/testing", ',
    },
    'outside the app directory': { 'usr/lib/signing/index.js': `"${SIGNER_MARKER}"` },
  };
  for (const [name, files] of Object.entries(cases)) {
    const root = scratch(t);
    write(root, { ...CLEAN_IMAGE, ...files });
    assert.notDeepEqual(imageTreeProblems(root), [], name);
  }
});
