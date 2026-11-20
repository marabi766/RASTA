import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { MeterFullRun } from '../src/maintenance/meter-full-run';
import { lockUsageMeter } from '../src/maintenance/usage-meter';
import { PrismaService } from '../src/prisma/prisma.service';
import { asActor, databaseUrl, id, seedAsset, seedMeter, tenants } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS inventory shared with repository guards
const { authoredFiles } = require('../../../scripts/authored-source-inventory.cjs') as {
  authoredFiles: (dir: string) => string[];
};

const execute = promisify(execFile);
const service = resolve(__dirname, '..');
const migrations = join(service, 'prisma/migrations');
const sources = [
  'src/maintenance/meter-full-run.ts',
  'src/maintenance/meter-full-run-status.cli.ts',
  'src/maintenance/meter-full-run-status.args.ts',
  'src/maintenance/meter-reconcile.ts',
  'src/config/env.ts',
  'src/prisma/prisma.service.ts',
  'prisma/schema.prisma',
  ...authoredFiles(migrations)
    .filter(
      (path) =>
        relative(migrations, path).split('/').length === 2 && path.endsWith('/migration.sql'),
    )
    .map((path) => relative(service, path)),
];
const sourceHashes = (): string[] =>
  sources.map((name) =>
    createHash('sha256')
      .update(readFileSync(join(service, name)))
      .digest('hex'),
  );

describe('spawned read-only full-run status (canonical PostgreSQL schemas)', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const schemas = [`status_inactive_${suffix}`, `status_active_${suffix}`];
  const ownerUrl = process.env.DATABASE_URL_MAINTENANCE_MIGRATOR;
  if (!ownerUrl) throw new Error('DATABASE_URL_MAINTENANCE_MIGRATOR required');
  const owner = new PrismaService(ownerUrl);
  const urls = schemas.map((schema) => {
    const url = new URL(databaseUrl());
    url.searchParams.set('schema', schema);
    url.searchParams.set('connection_limit', '2');
    url.searchParams.set('pool_timeout', '2');
    return url.toString();
  });
  const prisma = new PrismaService(urls[1]);
  const org = tenants();
  const runId = '--apply';
  const operator = 'USR_STATUS_OPERATOR';
  const boundary = 'SYNTHETIC_STATUS_TEST_SEAL';
  const assets = [id('AST'), id('AST')];
  const tables = [
    'meter_full_run',
    'meter_full_run_asset',
    'asset_ref',
    'asset_usage_entry',
    'asset_usage_meter',
    'processed_event',
    'outbox_message',
    'outbox_stream_sequence',
  ];
  // Explicit child allowlist: no inherited URLs, credentials, envfiles or preloads.
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: 'test',
    NO_COLOR: '1',
    DATABASE_POOL_SIZE: '2',
    DATABASE_POOL_TIMEOUT_SECONDS: '2',
    KAFKA_BROKERS: '127.0.0.1:1',
    KAFKA_ALLOW_PLAINTEXT: 'true',
    ASSET_SERVICE_URL: 'http://127.0.0.1:1',
    FLEET_SERVICE_URL: 'http://127.0.0.1:1',
    OIDC_ISSUER_URL: 'http://127.0.0.1:1',
    OIDC_JWKS_URI: 'http://127.0.0.1:1/jwks',
    OIDC_AUDIENCE: 'status-test',
    INTERNAL_TOKEN_SECRET: 'synthetic_status_secret_not_for_identity_verification',
    METER_RECONCILE_OPERATOR_ID: operator,
  };
  const cli = async (
    args = [`--run-id=${runId}`],
    overrides: NodeJS.ProcessEnv = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const result = await execute(
        process.execPath,
        ['-r', '@swc-node/register', 'src/maintenance/meter-full-run-status.cli.ts', ...args],
        {
          cwd: service,
          env: { ...childEnv, DATABASE_URL_MAINTENANCE: urls[1], ...overrides },
          timeout: 15_000,
          maxBuffer: 8192,
        },
      );
      return { code: 0, ...result };
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string; killed?: boolean };
      expect(result.killed).not.toBe(true);
      expect(typeof result.code).toBe('number');
      return result;
    }
  };
  async function storedRows(): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (const schema of schemas)
      for (const table of tables)
        rows.push(
          await owner.client.$queryRawUnsafe(
            `SELECT row_to_json(t)::text AS row, xmin::text AS xmin FROM "${schema}"."${table}" t ORDER BY row_to_json(t)::text`,
          ),
        );
    return rows;
  }
  let rowsBefore: unknown[];
  let hashesBefore: string[];
  let expected: unknown;
  beforeAll(async () => {
    for (const schema of schemas) {
      await owner.client.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      const url = new URL(ownerUrl);
      url.searchParams.set('schema', schema);
      // Apply every canonical migration, including all triggers and constraints.
      await execute(
        process.execPath,
        [join(service, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
        { cwd: service, env: { ...childEnv, DATABASE_URL: url.toString() }, timeout: 30_000 },
      );
      const role = decodeURIComponent(new URL(urls[0]).username).replaceAll('"', '""');
      await owner.client.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      await owner.client.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`,
      );
      await owner.client.$executeRawUnsafe(
        `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}"`,
      );
      await owner.client.$executeRawUnsafe(
        `REVOKE ALL ON "${schema}"._prisma_migrations FROM "${role}"`,
      );
      await owner.client.$executeRawUnsafe(
        `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA "${schema}" FROM PUBLIC`,
      );
    }
    for (const [index, assetId] of assets.entries()) {
      await seedAsset(prisma, assetId, index === 0 ? org.a : org.b);
      await seedMeter(prisma, assetId, index === 0 ? org.a : org.b, '0');
    }
    // Canonical fixture's permitted LEGACY -> LEDGER edge, under the meter lock.
    await prisma.transaction(async (tx) => {
      await lockUsageMeter(tx, { assetId: assets[0], organizationId: org.a, now: new Date() });
      await tx.$executeRaw`UPDATE asset_usage_meter SET meter_source = 'LEDGER' WHERE asset_id = ${assets[0]}`;
    });
    // Synthetic authority ONLY in fixture setup; no production completeness claim.
    // One LEDGER asset and one explicit refusal satisfy the actual activation guards.
    await new MeterFullRun(prisma, {
      withSealedInventory: async (_runId, commit) =>
        commit({
          complete: true,
          scope: 'ALL_PHYSICAL_ASSETS',
          boundary,
          assets: assets.map((assetId, index) => ({
            assetId,
            organizationId: index === 0 ? org.a : org.b,
          })),
        }),
      withQuarantineClear: async (runId, boundary, commit) =>
        commit({ runId, boundary, clear: true, assertHeld: async () => undefined }),
    }).activate(runId, operator, [{ assetId: assets[1], reason: 'HISTORY_UNKNOWN' }]);
    const [gate] = await prisma.client.$queryRaw<{ inventory_digest: string }[]>`
      SELECT inventory_digest FROM meter_full_run WHERE id = true`;
    expected = {
      runId,
      inventoryDigest: gate.inventory_digest,
      sourceBoundary: boundary,
      assetCount: 2,
      refusedCount: 1,
    };
    rowsBefore = await storedRows();
    hashesBefore = sourceHashes();
  });
  afterEach(async () => {
    expect(await storedRows()).toEqual(rowsBefore);
    expect(sourceHashes()).toEqual(hashesBefore);
  });
  afterAll(async () => {
    expect((await prisma.stop()).drained).toBe(true);
    try {
      for (const schema of schemas)
        await owner.client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      expect((await owner.stop()).drained).toBe(true);
    }
  });
  it.each([['--run-id', 'RUN_COMPAT'], ['--run-id=--RUN'], ['--run-id=--'], ['--run-id=--apply']])(
    'returns only null for the legal inactive singleton with %j',
    async (...args) => {
      expect(await cli(args, { DATABASE_URL_MAINTENANCE: urls[0] })).toEqual({
        code: 0,
        stdout: 'null\n',
        stderr: '',
      });
    },
  );
  it('returns exactly persisted bounded evidence across repeated fresh processes', async () => {
    for (let i = 0; i < 2; i++) {
      const result = await cli();
      expect(result).toEqual({ code: 0, stdout: `${JSON.stringify(expected)}\n`, stderr: '' });
      for (const value of [
        ...assets,
        org.a,
        org.b,
        operator,
        urls[1],
        childEnv.INTERNAL_TOKEN_SECRET!,
      ])
        expect(result.stdout).not.toContain(value);
    }
  });
  it.each([
    { args: ['--run-id', 'OTHER_RUN'] },
    { env: { METER_RECONCILE_OPERATOR_ID: 'OTHER_OPERATOR' } },
  ])('refuses mismatched run/operator without returning evidence %#', async ({ args, env }) => {
    const result = await cli(args, env);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^command failed \(code unknown\); diagnostics withheld;.*\n$/);
  });
  it.each([
    { METER_RECONCILE_OPERATOR_ID: undefined },
    { METER_RECONCILE_OPERATOR_ID: 'secret\noperator' },
    { METER_RECONCILE_OPERATOR_ID: 'x'.repeat(257) },
    { DATABASE_URL_MAINTENANCE: undefined },
    { DATABASE_URL_MAINTENANCE: 'LEAK_NOT_A_DATABASE_URL' },
    { INTERNAL_TOKEN_SECRET: 'LEAK_SHORT_SECRET' },
    { ASSET_SERVICE_URL: 'http://private:LEAK@127.0.0.1:1' },
    { DATABASE_URL_MAINTENANCE_MIGRATOR: ownerUrl },
    { DATABASE_URL_MAINTENANCE: ownerUrl },
  ])('refuses missing/malformed configuration and owner credentials safely %#', async (env) => {
    const result = await cli(undefined, env);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(
      /^command (refused|failed) \(code [a-z-]+\); diagnostics withheld;.*\n$/,
    );
    for (const secret of [
      'LEAK',
      'private',
      'secret',
      'invalid.invalid',
      operator,
      boundary,
      runId,
      ...assets,
    ])
      expect(result.stderr).not.toContain(secret);
  });
  it.each(
    [
      [],
      ['--run-id'],
      ['--run-id', 'bad\n'],
      ['--run-id', runId, '--run-id', runId],
      ['--run-id='],
      ['--run-id=RUN=OTHER'],
      ['--run-id=bad\n'],
      [`--run-id=${'x'.repeat(65)}`],
      [`--run-id=${runId}`, `--run-id=${runId}`],
      [`--run-id=${runId}`, '--run-id', 'RUN'],
      [`--run-id=${runId}`, 'extra'],
      ...['--apply', '--activate', '--seal', '--resume', '--unknown'].flatMap((flag) => [
        [flag],
        [`--run-id=${runId}`, flag],
      ]),
    ].map((args) => ({ args })),
  )('refuses bad arguments before database/config effects %#', async ({ args }) => {
    const result = await cli(args, {
      DATABASE_URL_MAINTENANCE: 'postgresql://private:LEAK@127.0.0.1:1/db',
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^command refused \(code usage\); diagnostics withheld;.*\n$/);
  });
  it('primitive rejects an ambient tenant before querying', async () => {
    const query = jest.spyOn(prisma.client, '$queryRaw');
    try {
      await expect(
        asActor({ organizationId: org.a }, () => new MeterFullRun(prisma).status(runId, operator)),
      ).rejects.toThrow('OPERATOR_CONTEXT_REQUIRED');
      expect(query).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
    }
  });
});
