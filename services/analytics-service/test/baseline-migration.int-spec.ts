import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import { baselineFixture, cleanupBaselines } from './baseline-helpers';
import { databaseUrl, newOrganizationId, ownerClient, ownerDatabaseUrl } from './helpers';

describe('baseline append-only database controls', () => {
  const organizationId = newOrganizationId();
  const owner = ownerClient();
  const runtime = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
  const data = baselineFixture(organizationId, { recordedAt: new Date('2000-01-01T00:00:00Z') });
  beforeAll(async () => {
    await owner.baselineMetric.create({ data });
  });
  afterAll(async () => {
    await cleanupBaselines([organizationId]);
    await Promise.all([runtime.$disconnect(), owner.$disconnect()]);
  });

  it('stamps recorded_at from the database, ignoring a supplied/backdated instant', async () => {
    const row = await owner.baselineMetric.findFirstOrThrow({ where: { organizationId } });
    expect(row.recordedAt.getUTCFullYear()).toBeGreaterThan(2000);
  });

  it.each(['UPDATE', 'DELETE'] as const)(
    'runtime %s is refused by the trigger on a real row',
    async (operation) => {
      const action =
        operation === 'UPDATE'
          ? runtime.baselineMetric.updateMany({ where: { organizationId }, data: { value: 0n } })
          : runtime.baselineMetric.deleteMany({ where: { organizationId } });
      await expect(action).rejects.toThrow(/ck_baseline_metric_append_only/);
      expect(
        (await owner.baselineMetric.findFirstOrThrow({ where: { organizationId } })).value,
      ).toBe(600n);
    },
  );

  it('TRUNCATE is refused even to the table owner', async () => {
    await expect(owner.$executeRawUnsafe('TRUNCATE TABLE baseline_metric')).rejects.toThrow(
      /ck_baseline_metric_append_only/,
    );
  });
});

describe('baseline migration reversibility on a non-empty isolated schema', () => {
  const schema = `kpi_rollback_${ulid().toLowerCase()}`;
  const owner = ownerClient();
  const url = new URL(ownerDatabaseUrl());
  url.searchParams.set('schema', schema);
  const scratch = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const migrations = join(__dirname, '..', 'prisma', 'migrations');
  const initial = join(migrations, '20261017140000_init_analytics');
  const baseline = join(migrations, '20261024120000_baseline_metric');

  function apply(directory: string, file: string): void {
    // Run the repository's supported file runner in native ESM. It uses libpqInvocation,
    // keeps passwords out of argv and pins search_path before applying the file atomically.
    // A native subprocess avoids requiring the ESM tool through Jest's CommonJS transformer.
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import { psqlFileRunner } from './scripts/verify-migration-reversible-lib.mjs';
        const result = psqlFileRunner(process.env.DATABASE_URL_ANALYTICS_MIGRATOR, process.argv[1])(process.argv[2]);
        if (!result.ok) { process.stderr.write(result.output); process.exit(1); }
      `,
        schema,
        join(directory, file),
      ],
      {
        encoding: 'utf8',
        cwd: join(__dirname, '..', '..', '..'),
        env: { ...process.env, DATABASE_URL_ANALYTICS_MIGRATOR: ownerDatabaseUrl() },
      },
    );
    if (result.error || result.status !== 0)
      throw new Error(`Migration file ${file} failed: ${result.error?.message ?? result.stderr}`);
  }

  beforeAll(async () => {
    await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    apply(initial, 'migration.sql');
    await scratch.$executeRawUnsafe(
      'CREATE TABLE "_prisma_migrations" ("migration_name" text PRIMARY KEY)',
    );
  });
  afterAll(async () => {
    await scratch.$disconnect();
    await owner.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await owner.$disconnect();
  });

  it('up → populated → down → up preserves PR 1 data and reinstalls every baseline guard', async () => {
    const organizationId = newOrganizationId();
    await scratch.factMaintenance.create({
      data: {
        organizationId,
        requestId: 'preserved-request',
        assetId: 'test-asset',
        maintenanceType: 'PREVENTIVE',
        completedAt: new Date('2026-10-01T00:00:00Z'),
        downtimeMinutes: 5,
        totalCostMinor: 9n,
        currency: 'IRR',
        sourceEventId: ulid(),
      },
    });
    await scratch.processedEvent.create({
      data: { eventId: 'preserved-event', consumerName: 'test-consumer' },
    });
    apply(baseline, 'migration.sql');
    await scratch.$executeRawUnsafe(
      "INSERT INTO _prisma_migrations VALUES ('20261024120000_baseline_metric')",
    );
    await scratch.baselineMetric.create({ data: baselineFixture(organizationId) });
    expect(await scratch.baselineMetric.count()).toBe(1);

    apply(baseline, 'down.sql');
    const [catalog] = await scratch.$queryRaw<
      { tables: bigint; functions: bigint; triggers: bigint; ledger: bigint }[]
    >`
      SELECT
        (SELECT count(*) FROM information_schema.tables WHERE table_schema = ${schema} AND table_name = 'baseline_metric') AS tables,
        (SELECT count(*) FROM information_schema.routines WHERE routine_schema = ${schema} AND routine_name = 'baseline_metric_append_only') AS functions,
        (SELECT count(*) FROM information_schema.triggers WHERE trigger_schema = ${schema} AND trigger_name LIKE 'tg_baseline_metric%') AS triggers,
        (SELECT count(*) FROM _prisma_migrations WHERE migration_name = '20261024120000_baseline_metric') AS ledger`;
    expect(catalog).toEqual({ tables: 0n, functions: 0n, triggers: 0n, ledger: 0n });
    expect(await scratch.factMaintenance.count()).toBe(1);
    expect(await scratch.processedEvent.count()).toBe(1);

    apply(baseline, 'migration.sql');
    const inserted = await scratch.baselineMetric.create({ data: baselineFixture(organizationId) });
    await expect(scratch.baselineMetric.updateMany({ data: { value: 0n } })).rejects.toThrow(
      /ck_baseline_metric_append_only/,
    );
    await expect(scratch.baselineMetric.deleteMany()).rejects.toThrow(
      /ck_baseline_metric_append_only/,
    );
    await expect(scratch.$executeRawUnsafe('TRUNCATE baseline_metric')).rejects.toThrow(
      /ck_baseline_metric_append_only/,
    );
    expect(
      (await scratch.baselineMetric.findFirstOrThrow({ where: { id: inserted.id } })).value,
    ).toBe(600n);
    expect(await scratch.factMaintenance.count()).toBe(1);
  });
});
