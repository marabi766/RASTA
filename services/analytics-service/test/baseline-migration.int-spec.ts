import { join } from 'node:path';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import { baselineFixture, cleanupBaselines } from './baseline-helpers';
import { applyMigration } from './migration-helpers';
import { createSystemContext, runWithContext } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { KpiRepository } from '../src/kpis/kpi.repository';
import { KPI_WINDOW } from './baseline-helpers';
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
    'owner %s is refused by the trigger on a real row',
    async (operation) => {
      const action =
        operation === 'UPDATE'
          ? owner.baselineMetric.updateMany({ where: { organizationId }, data: { value: 0n } })
          : owner.baselineMetric.deleteMany({ where: { organizationId } });
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
    applyMigration(ownerDatabaseUrl(), schema, join(directory, file));
  }

  beforeAll(async () => {
    await owner.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    apply(initial, 'migration.sql');
    await scratch.$executeRawUnsafe(
      'CREATE TABLE "_prisma_migrations" ("migration_name" text PRIMARY KEY)',
    );
    apply(baseline, 'migration.sql');
  });
  afterEach(async () => {
    // Each case starts without another case's synthetic reference measurements.
    await scratch.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE baseline_metric DISABLE TRIGGER tg_baseline_metric_append_only',
      );
      await tx.baselineMetric.deleteMany();
      await tx.$executeRawUnsafe(
        'ALTER TABLE baseline_metric ENABLE TRIGGER tg_baseline_metric_append_only',
      );
    });
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
    await scratch.$executeRawUnsafe(
      "INSERT INTO _prisma_migrations VALUES ('20261024120000_baseline_metric')",
    );
    await scratch.baselineMetric.create({ data: baselineFixture(organizationId) });
    expect(await scratch.baselineMetric.count()).toBe(1);

    const triggersBefore = await scratch.$queryRaw`
      SELECT tgname, tgenabled FROM pg_trigger
      WHERE tgrelid = 'baseline_metric'::regclass AND NOT tgisinternal ORDER BY tgname`;
    expect(triggersBefore).toHaveLength(3);
    expect(() => apply(baseline, 'down.sql')).toThrow(
      /contains reference evidence; rollback refused/,
    );
    expect(await scratch.baselineMetric.count()).toBe(1);
    expect(
      await scratch.$queryRaw`
      SELECT tgname, tgenabled FROM pg_trigger
      WHERE tgrelid = 'baseline_metric'::regclass AND NOT tgisinternal ORDER BY tgname`,
    ).toEqual(triggersBefore);
    expect(await scratch.$queryRaw`SELECT * FROM _prisma_migrations`).toEqual([
      { migration_name: '20261024120000_baseline_metric' },
    ]);
    await expect(scratch.baselineMetric.deleteMany()).rejects.toThrow(
      /ck_baseline_metric_append_only/,
    );

    // Owner removes only this scratch schema's synthetic rows, explicitly, before rollback.
    // There is no operator opt-in or bypass flag in down.sql.
    await scratch.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE baseline_metric DISABLE TRIGGER tg_baseline_metric_append_only',
      );
      await tx.baselineMetric.deleteMany();
      await tx.$executeRawUnsafe(
        'ALTER TABLE baseline_metric ENABLE TRIGGER tg_baseline_metric_append_only',
      );
    });
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

  it('database identity wins 50 real recorded_at collisions, including zero, independent of IDs', async () => {
    const prisma = new PrismaService(url.toString());
    const repository = new KpiRepository(prisma);
    try {
      for (let iteration = 0; iteration < 50; iteration += 1) {
        const organizationId = newOrganizationId();
        const [earlier, later] = await scratch.$transaction(async (tx) => {
          // Isolated scratch schema only. Production's stamping trigger stays enabled.
          await tx.$executeRawUnsafe(
            'ALTER TABLE baseline_metric DISABLE TRIGGER tg_baseline_metric_recorded_at',
          );
          const recordedAt = new Date('2026-10-10T00:00:00.000Z');
          const first = await tx.baselineMetric.create({
            data: baselineFixture(organizationId, {
              id: 'z-earlier',
              value: 999n,
              recordedAt,
            }),
          });
          const second = await tx.baselineMetric.create({
            data: baselineFixture(organizationId, {
              id: 'a-later',
              value: iteration % 2 === 0 ? 0n : 9223372036854775807n,
              recordedAt,
            }),
          });
          await tx.$executeRawUnsafe(
            'ALTER TABLE baseline_metric ENABLE TRIGGER tg_baseline_metric_recorded_at',
          );
          return [first, second] as const;
        });
        expect(earlier.recordedAt).toEqual(later.recordedAt);
        expect(later.version).toBeGreaterThan(earlier.version);
        const result = await runWithContext(
          createSystemContext({ organizationId, correlationId: 'collision-test' }),
          () => repository.read(new Date(KPI_WINDOW.from), new Date(KPI_WINDOW.to)),
        );
        expect(result.baseline_minutes).toBe(later.value.toString());
      }
    } finally {
      await prisma.disconnect();
    }
  });

  it('GENERATED ALWAYS refuses a writer-supplied version', async () => {
    await expect(
      scratch.$executeRawUnsafe(`
      INSERT INTO baseline_metric (organization_id,id,version,metric_key,scope_kind,period_start,period_end,value,unit,source,recorded_by)
      VALUES ('identity-probe','probe',999,'METRIC','ORGANIZATION','2026-10-01','2026-11-01',1,'COUNT','test','test')`),
    ).rejects.toThrow(/Code: `428C9`/);
  });

  it('uses the full equality index with LIMIT 1 on a populated table', async () => {
    await scratch.$executeRawUnsafe(`INSERT INTO baseline_metric
      (organization_id,id,metric_key,scope_kind,unit,currency,period_start,period_end,value,source,recorded_by)
      SELECT 'plan-org', 'plan-' || n, 'MAINTENANCE_DOWNTIME_BASELINE_MINUTES', 'ORGANIZATION',
        'MINUTES', NULL, '2026-10-01', '2026-11-01', n, 'test', 'test'
      FROM generate_series(1,10000) n`);
    await scratch.$executeRawUnsafe('ANALYZE baseline_metric');
    const plan = await scratch.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN (COSTS OFF)
      SELECT value::text FROM baseline_metric
      WHERE organization_id = 'plan-org' AND metric_key = 'MAINTENANCE_DOWNTIME_BASELINE_MINUTES'
        AND scope_kind = 'ORGANIZATION' AND unit = 'MINUTES' AND COALESCE(currency, '') = ''
        AND period_start = '2026-10-01'::timestamptz AND period_end = '2026-11-01'::timestamptz
      ORDER BY version DESC LIMIT 1`);
    const text = plan.map((row) => row['QUERY PLAN']).join('\n');
    expect(text).toMatch(/^Limit/);
    expect(text).toContain('Index Scan using ix_baseline_metric_org_key_scope_period');
    expect(text).not.toMatch(/Sort|Seq Scan|Filter:/);
    const indexCondition = plan.find((row) => row['QUERY PLAN'].includes('Index Cond:'))?.[
      'QUERY PLAN'
    ];
    expect(indexCondition).toBeDefined();
    for (const field of [
      'organization_id',
      'metric_key',
      'scope_kind',
      'unit',
      'currency',
      'period_start',
      'period_end',
    ]) {
      expect(indexCondition).toContain(field);
    }
  });
});
