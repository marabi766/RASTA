import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authoredFiles } from './authored-source-inventory.cjs';
import { generate, schemaArgs } from './prisma-generate.mjs';

async function probe(results) {
  let calls = 0;
  const delays = [];
  const logs = [];
  const code = await generate({
    run: () => results[Math.min(calls++, results.length - 1)],
    sleep: async (ms) => {
      delays.push(ms);
    },
    log: (message) => logs.push(message),
  });
  return { code, calls, delays, logs };
}

const downloadFailure = (reason) =>
  `Error: request to https://binaries.prisma.sh/all_commits/abc/linux/schema-engine.gz failed, reason: ${reason}`;
for (const stderr of [
  'Error: aborted\n    at TLSSocket.socketCloseListener (node:_http_client:464:19)',
  ...['read ECONNRESET', 'connect ETIMEDOUT', 'socket hang up', 'fetch failed'].map(
    downloadFailure,
  ),
]) {
  test(`transient stderr retries then succeeds: ${stderr}`, async () => {
    const result = await probe([{ status: 1, stderr }, { status: 0 }]);
    assert.equal(result.code, 0);
    assert.equal(result.calls, 2);
    assert.deepEqual(result.delays, [2000]);
    assert.ok(result.logs.some((line) => line.includes('retry 2/3')));
    assert.ok(result.logs.includes(stderr));
  });
}

test('schema and unknown failures fail immediately, including stdout-only network text', async () => {
  for (const stderr of [
    'Error: P1012 schema validation',
    'Error: P1012 schema validation: fetch failed',
    '',
    'unknown failure',
    'Error: aborted',
    'ECONNRESET',
    'TypeError: fetch failed',
    ...['ECONNRESET', 'ETIMEDOUT', 'socket hang up', 'fetch failed', 'Error: aborted'].map(
      (value) => `Error: Unknown binary target ${value} in generator client.`,
    ),
    `Error: Unknown binary target ${downloadFailure('read ECONNRESET')} in generator client.`,
  ]) {
    const result = await probe([{ status: 7, stderr, stdout: 'Error: aborted' }]);
    assert.equal(result.code, 7);
    assert.equal(result.calls, 1);
    assert.deepEqual(result.delays, []);
  }
});

test('persistent network failures stop at three attempts', async () => {
  const result = await probe([{ status: 9, stderr: downloadFailure('read ECONNRESET') }]);
  assert.equal(result.code, 9);
  assert.equal(result.calls, 3);
  assert.deepEqual(result.delays, [2000, 5000]);
  assert.equal(result.logs.filter((line) => line.includes('retry')).length, 2);
});

test('signals and process errors never retry even with transient stderr', async () => {
  for (const failure of [{ signal: 'SIGTERM' }, { error: new Error('timeout') }, {}]) {
    const result = await probe([
      { status: null, stderr: downloadFailure('read ECONNRESET'), ...failure },
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.calls, 1);
  }
});

test('every service generation and build uses the shared boundary', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const file of authoredFiles(root)) {
    const service = relative(root, file).replaceAll('\\', '/');
    if (!/^services\/[^/]+\/package\.json$/.test(service)) continue;
    const pkg = JSON.parse(readFileSync(file));
    if (!pkg.scripts['db:generate']) continue;
    assert.equal(pkg.scripts['db:generate'], 'node ../../scripts/prisma-generate.mjs', service);
    assert.ok(pkg.scripts.build.startsWith(`${pkg.scripts['db:generate']} &&`), service);
  }
});

test('schema selection refuses unknown arguments, outside paths, missing files and symlinks', () => {
  const cwd = fileURLToPath(new URL('../services/economic-service/', import.meta.url));
  const cache = join(cwd, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'settlement-rollback-'));
  try {
    const schema = join(dir, 'prisma/schema.prisma');
    mkdirSync(join(dir, 'prisma'));
    writeFileSync(schema, '');
    assert.deepEqual(schemaArgs([]), []);
    assert.deepEqual(schemaArgs(['--schema', schema], cwd), ['--schema', schema]);
    for (const argv of [
      ['--help'],
      ['--schema', 'prisma/schema.prisma'],
      ['--schema', schema, '--help'],
      ['--schema', join(dir, 'missing')],
    ])
      assert.throws(() => schemaArgs(argv, cwd));
    assert.throws(() => schemaArgs(['--schema', schema], '/tmp'));
    rmSync(schema);
    assert.throws(() => schemaArgs(['--schema', schema], cwd));
    symlinkSync(join(cwd, 'prisma/schema.prisma'), schema);
    assert.throws(() => schemaArgs(['--schema', schema], cwd));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Developer watch commands intentionally retain immediate local generation.
const DEV_SERVICES = new Set(
  [
    'analytics',
    'asset',
    'audit',
    'construction',
    'contract',
    'document',
    'economic',
    'fleet',
    'identity',
    'inventory',
    'maintenance',
    'marketplace',
    'notification',
    'organization',
    'procurement',
    'supplier',
  ].map((name) => `services/${name}-service/package.json`),
);
// Exact inert examples only; additional calls even in these files are refused.
const EXAMPLES = new Map([
  [
    'scripts/fixtures/marketplace-pre-protocol-package.json',
    [
      // Historical manifest snapshot, never installed or executed.
      '"build": "prisma generate &&',
      '"dev": "prisma generate &&',
      '"db:generate": "prisma generate"',
    ],
  ],
  [
    'scripts/service-dev-loader.test.mjs',
    [
      // Assertions for the explicitly allowed developer watch commands.
      "'prisma generate && node ",
      '/^prisma generate && node /',
    ],
  ],
  [
    'scripts/copy-prisma-client.mjs',
    [
      // Diagnostic text only.
      'Run `prisma generate` before building.',
    ],
  ],
]);

test('authored generation callers and install hooks use the enforced boundary', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const file of authoredFiles(root)) {
    const path = relative(root, file).replaceAll('\\', '/');
    if (path === 'scripts/prisma-generate.mjs') continue;
    if (!(
      /(?:^|\/)(?:scripts|tests?|workflows)\//.test(path) ||
      /(?:package\.json|pnpm-workspace\.yaml|Dockerfile)$/.test(path)
    ))
      continue;
    let source = readFileSync(file, 'utf8');
    if (path === 'scripts/prisma-generate.test.mjs') {
      // Remove this check's inert examples and its developer-script regex only.
      const begin = source.indexOf('const EXAMPLES =');
      const end = source.indexOf("\ntest('authored generation", begin);
      source = source.slice(0, begin) + source.slice(end);
      source = source.replace('/^prisma' + ' generate && node /', '');
    }
    for (const example of EXAMPLES.get(path) ?? []) {
      assert.ok(source.includes(example), path);
      source = source.replace(example, '');
    }
    if (DEV_SERVICES.has(path)) {
      const pkg = JSON.parse(source);
      assert.match(pkg.scripts.dev, /^prisma generate && node /, path);
      delete pkg.scripts.dev;
      source = JSON.stringify(pkg);
    }
    source = source.replace(/^\s*\/\/.*$/gm, '');
    // Both shell commands and literal argv arrays; helper-based CLI calls too.
    assert.doesNotMatch(
      source,
      /\bprisma(?:[\s'",]+|[^\n]*?build\/index\.js['",\s]+)generate\b|(?:prismaCli|mustRun)\(\s*\[\s*['"]generate['"]/,
      path,
    );
    if (path.endsWith('Dockerfile') && source.includes('pnpm install --frozen-lockfile'))
      assert.match(
        source,
        /PRISMA_SKIP_POSTINSTALL_GENERATE=true pnpm install --frozen-lockfile/,
        path,
      );
    if (path.startsWith('.github/workflows/') && source.includes('pnpm install --frozen-lockfile'))
      assert.match(source, /PRISMA_SKIP_POSTINSTALL_GENERATE: 'true'/, path);
  }
});
