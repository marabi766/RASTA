import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { Prisma, PrismaClient } from '../src/generated/prisma';
import { baselineFixture } from './baseline-helpers';
import { databaseUrl, ownerClient, ownerDatabaseUrl } from './helpers';
import { applyMigration } from './migration-helpers';

const EXPECTED_GRANTS: Record<string, string[]> = {
  _prisma_migrations: [],
  baseline_metric: ['SELECT'],
  fact_maintenance: ['INSERT', 'SELECT'],
  processed_event: ['INSERT', 'SELECT'],
};
const OWNER_GRANTS = ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'];
const migrations = join(__dirname, '..', 'prisma', 'migrations');
const privilegeMigration = join(
  migrations,
  '20261024130000_analytics_runtime_privileges',
  'migration.sql',
);
const repositoryRoot = join(__dirname, '..', '..', '..');

/** Execute the actual split script's grant step, with psql replaced by SQL capture.
 * No role/password/ownership operations are invoked by this test helper. */
function currentGrantStep(mode: 'configured' | 'default'): string {
  const result = spawnSync(
    'bash',
    [
      '-eu',
      '-c',
      `
    source infrastructure/docker/postgres/lib/role-passwords.bash
    source infrastructure/docker/postgres/lib/service-privilege-split.bash
    _svc_split_psql() { printf '%s;\\n' "$2"; }
    grant_service_tables analytics ignored ${mode === 'default' ? 'default' : '"$(privilege_split_grants_mode analytics)"'}
  `,
    ],
    { encoding: 'utf8', cwd: repositoryRoot },
  );
  if (result.status !== 0) throw new Error(`grant step failed: ${result.stderr}`);
  return result.stdout;
}

// Separate databases, not the integration database: both realistic provisioning
// histories can be inspected without changing any other suite's grants/defaults.
describe.each(['fresh', 'upgraded'] as const)('%s migration-managed runtime grants', (history) => {
  const name = `analytics_acl_${history}_${ulid().toLowerCase()}`;
  const admin = ownerClient();
  const ownerUrl = new URL(ownerDatabaseUrl());
  const runtimeUrl = new URL(databaseUrl());
  ownerUrl.pathname = `/${name}`;
  runtimeUrl.pathname = `/${name}`;
  ownerUrl.searchParams.set('schema', 'public');
  runtimeUrl.searchParams.set('schema', 'public');
  const owner = new PrismaClient({ datasources: { db: { url: ownerUrl.toString() } } });
  const runtime = new PrismaClient({ datasources: { db: { url: runtimeUrl.toString() } } });
  const organizationId = `acl-${ulid()}`;
  const row = baselineFixture(organizationId);

  beforeAll(async () => {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    await owner.$executeRawUnsafe('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await owner.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO rasta_analytics');
    await owner.$executeRawUnsafe(
      'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    );
    await owner.$executeRawUnsafe(
      'CREATE TABLE _prisma_migrations (migration_name text PRIMARY KEY)',
    );
    if (history === 'upgraded') {
      // OLD default-mode grant step, before any tables are migrated. The defaults
      // must really exist, otherwise dropping REVOKE would be a vacuous mutant.
      await owner.$executeRawUnsafe(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rasta_analytics',
      );
      await owner.$executeRawUnsafe(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rasta_analytics',
      );
      await owner.$executeRawUnsafe(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO rasta_analytics',
      );
      await owner.$executeRawUnsafe('REVOKE ALL ON _prisma_migrations FROM rasta_analytics');
    }
    for (const migration of ['20261017140000_init_analytics', '20261024120000_baseline_metric']) {
      applyMigration(ownerUrl.toString(), 'public', join(migrations, migration, 'migration.sql'));
    }
    if (history === 'upgraded') {
      const [legacy] = await runtime.$queryRaw<{ can_insert: boolean }[]>`
        SELECT has_table_privilege('baseline_metric','INSERT') AS can_insert`;
      expect(legacy?.can_insert).toBe(true);
    }
    applyMigration(ownerUrl.toString(), 'public', privilegeMigration);
    await owner.baselineMetric.create({ data: row });
  });

  afterAll(async () => {
    await Promise.all([runtime.$disconnect(), owner.$disconnect()]);
    try {
      // A disconnected Prisma pool's backends may still be closing. FORCE can
      // try to signal the other role, which the migrator must not be allowed to
      // do. Only retry the transient database-in-use state, with a fixed bound.
      const attempts = 5;
      const retryDelayMs = 100;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}"`);
          return;
        } catch (error) {
          const closingConnections =
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2010' &&
            error.meta?.['code'] === '55006';
          if (!closingConnections || attempt === attempts - 1) throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    } finally {
      await admin.$disconnect();
    }
  });

  it('uses the runtime identity, with every table owned by the migrator', async () => {
    expect(await runtime.$queryRaw`SELECT current_user::text AS role`).toEqual([
      { role: 'rasta_analytics' },
    ]);
    expect(
      await runtime.$queryRaw`
      SELECT DISTINCT tableowner::text AS owner FROM pg_tables WHERE schemaname = 'public'`,
    ).toEqual([{ owner: 'rasta_analytics_migrator' }]);
  });

  it('has exactly the expected relacl on EVERY analytics table, including the ledger', async () => {
    // Supplier's exhaustive inventory, extended to inspect relacl, not just effective grants.
    const rows = await owner.$queryRaw<{ table: string; grantee: string; privileges: string[] }[]>`
      SELECT c.relname::text AS "table", pg_get_userbyid(a.grantee)::text AS grantee,
        array_agg(a.privilege_type ORDER BY a.privilege_type)::text[] AS privileges
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      GROUP BY c.relname, a.grantee ORDER BY c.relname, grantee`;
    const expected = Object.entries(EXPECTED_GRANTS).flatMap(([table, privileges]) => [
      ...(privileges.length ? [{ table, grantee: 'rasta_analytics', privileges }] : []),
      { table, grantee: 'rasta_analytics_migrator', privileges: OWNER_GRANTS },
    ]);
    expect(rows).toEqual(expected);
    // No column-level write loopholes either.
    expect(
      await owner.$queryRaw`
      SELECT attname FROM pg_attribute WHERE attrelid = 'baseline_metric'::regclass AND attacl IS NOT NULL`,
    ).toEqual([]);
  });

  it('has exactly the expected pg_default_acl: no inherited table or sequence grants', async () => {
    const rows = await owner.$queryRaw`
      SELECT n.nspname::text AS schema, d.defaclobjtype::text AS type,
        pg_get_userbyid(a.grantee)::text AS grantee,
        array_agg(a.privilege_type ORDER BY a.privilege_type)::text[] AS privileges
      FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) a
      WHERE d.defaclrole = 'rasta_analytics_migrator'::regrole
      GROUP BY n.nspname, d.defaclobjtype, a.grantee ORDER BY 1,2,3`;
    expect(rows).toEqual([
      { schema: null, type: 'f', grantee: 'rasta_analytics_migrator', privileges: ['EXECUTE'] },
    ]);
  });

  it('SELECT works as runtime', async () => {
    expect((await runtime.baselineMetric.findFirstOrThrow()).value).toBe(600n);
  });

  it.each([
    [
      'INSERT',
      `INSERT INTO baseline_metric (organization_id,id,metric_key,scope_kind,period_start,period_end,value,unit,source,recorded_by)
      VALUES ('denied','denied','METRIC','ORGANIZATION','2026-10-01','2026-11-01',1,'COUNT','test','test')`,
    ],
    ['UPDATE', 'UPDATE baseline_metric SET value = 0'],
    ['DELETE', 'DELETE FROM baseline_metric'],
    ['TRUNCATE', 'TRUNCATE baseline_metric'],
  ])('runtime %s fails with SQLSTATE 42501', async (_operation, sql) => {
    await expect(runtime.$executeRawUnsafe(sql)).rejects.toThrow(/Code: `42501`/);
  });

  it.each(['configured', 'default'] as const)(
    'split grant step re-run (%s) cannot reopen baseline INSERT',
    async (mode) => {
      const sql = currentGrantStep(mode);
      // The real script performs no blanket grants for analytics, even on an old explicit caller.
      expect(sql.trim()).toBe('');
      if (sql.trim()) await owner.$executeRawUnsafe(sql);
      await expect(
        runtime.$executeRawUnsafe(`INSERT INTO baseline_metric
      (organization_id,id,metric_key,scope_kind,period_start,period_end,value,unit,source,recorded_by)
      VALUES ('rerun','rerun','METRIC','ORGANIZATION','2026-10-01','2026-11-01',1,'COUNT','test','test')`),
      ).rejects.toThrow(/Code: `42501`/);
    },
  );

  it('runtime still inserts/reads facts and markers in one transaction', async () => {
    await runtime.$transaction(async (tx) => {
      await tx.processedEvent.createMany({
        data: [{ eventId: 'needed-grant', consumerName: 'test' }],
        skipDuplicates: true,
      });
      await tx.factMaintenance.createMany({
        data: [
          {
            organizationId,
            requestId: 'needed-grant',
            assetId: 'test',
            maintenanceType: 'PREVENTIVE',
            completedAt: new Date(),
            totalCostMinor: 0n,
            currency: 'IRR',
            sourceEventId: 'needed-grant',
          },
        ],
        skipDuplicates: true,
      });
    });
    expect(await runtime.factMaintenance.count()).toBe(1);
    expect(await runtime.processedEvent.count()).toBe(1);
  });
});
