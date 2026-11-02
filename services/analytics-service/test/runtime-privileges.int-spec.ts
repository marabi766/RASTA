import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { Prisma, PrismaClient } from '../src/generated/prisma';
import { baselineFixture } from './baseline-helpers';
import { databaseUrl, ownerClient, ownerDatabaseUrl } from './helpers';
import { applyMigration } from './migration-helpers';

const SEQUENCE_OWNER_GRANTS = ['SELECT', 'UPDATE', 'USAGE'];
const OWNER_GRANTS = ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'];
// Application ACLs are exact; DBA-owned extensions are checked separately below.
const APPLICATION_RELATION = Prisma.sql`NOT EXISTS (
  SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
    AND d.objid = c.oid AND d.deptype = 'e'
)`;
const migrations = join(__dirname, '..', 'prisma', 'migrations');
const privilegeMigration = join(
  migrations,
  '20261024130000_analytics_runtime_privileges',
  'migration.sql',
);
const coverageMigration = join(migrations, '20261029120000_projection_coverage', 'migration.sql');
const repositoryRoot = join(__dirname, '..', '..', '..');

// Inspect raw ACLs, including defaults and columns, to prove a refused run did
// not partially change privileges before reaching its guard.
async function aclSnapshot(client: PrismaClient): Promise<unknown> {
  return Promise.all([
    client.$queryRaw`SELECT c.relname, c.relkind::text, c.relacl::text
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v','m','f')
      ORDER BY c.relname`,
    client.$queryRaw`SELECT defaclrole::text, defaclnamespace::text,
      defaclobjtype::text, defaclacl::text FROM pg_default_acl
      ORDER BY defaclrole, defaclnamespace, defaclobjtype`,
    client.$queryRaw`SELECT c.relname, a.attname, a.attacl::text FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND a.attacl IS NOT NULL ORDER BY c.relname, a.attname`,
    client.$queryRaw`SELECT nspname, nspacl::text FROM pg_namespace
      WHERE nspname = 'public'`,
  ]);
}

it('every default-privilege revoke explicitly names the migrator and public schema', () => {
  const sql = readFileSync(privilegeMigration, 'utf8').replace(/--[^\n]*/g, '');
  const statements = sql.match(/ALTER\s+DEFAULT\s+PRIVILEGES\b[^;]*;/gi) ?? [];
  expect(statements).toHaveLength(2);
  for (const statement of statements) {
    expect(statement).toMatch(
      /^ALTER\s+DEFAULT\s+PRIVILEGES\s+FOR\s+ROLE\s+rasta_analytics_migrator\s+IN\s+SCHEMA\s+public\s+REVOKE\s+ALL\s+ON\s+(TABLES|SEQUENCES)\s+FROM\s+rasta_analytics\s*;$/i,
    );
  }
});

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

function currentExtensionStep(): string {
  const result = spawnSync(
    'bash',
    [
      '-eu',
      '-c',
      `
    source infrastructure/docker/postgres/lib/service-privilege-split.bash
    _svc_split_psql() { printf '%s;\\n' "$2"; }
    restrict_extension_relations ignored rasta_analytics
  `,
    ],
    { encoding: 'utf8', cwd: repositoryRoot },
  );
  if (result.status !== 0) throw new Error(`extension step failed: ${result.stderr}`);
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

  const expectedRelations = [
    { relation: '_prisma_migrations', kind: 'r', privileges: [] },
    { relation: 'baseline_metric', kind: 'r', privileges: ['SELECT'] },
    { relation: 'baseline_metric_version_seq', kind: 'S', privileges: [] },
    { relation: 'fact_maintenance', kind: 'r', privileges: ['INSERT', 'SELECT'] },
    ...(history === 'upgraded'
      ? [{ relation: 'legacy_runtime_seq', kind: 'S', privileges: [] }]
      : []),
    { relation: 'processed_event', kind: 'r', privileges: ['INSERT', 'SELECT'] },
    // Q-154: the consumer inserts the coverage start once, the KPI read selects it; never more.
    { relation: 'projection_coverage', kind: 'r', privileges: ['INSERT', 'SELECT'] },
  ];
  let creationGrants: unknown;
  let creationInsertError: unknown;
  let wrongRole: { before: unknown; after: unknown; error: unknown };

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
      // Independent of L3's baseline sequence: the cleanup mutant must still
      // leak these old rights even when baseline creation already fails closed.
      await owner.$executeRawUnsafe('CREATE SEQUENCE legacy_runtime_seq');
      expect(
        await runtime.$queryRaw`SELECT
        has_sequence_privilege('legacy_runtime_seq', 'USAGE') AS usage,
        has_sequence_privilege('legacy_runtime_seq', 'SELECT') AS select,
        has_sequence_privilege('legacy_runtime_seq', 'UPDATE') AS update`,
      ).toEqual([{ usage: true, select: true, update: false }]);
    }
    for (const migration of ['20261017140000_init_analytics', '20261024120000_baseline_metric']) {
      applyMigration(ownerUrl.toString(), 'public', join(migrations, migration, 'migration.sql'));
    }
    // Fresh is a control: only upgraded defaults distinguish B's REVOKEs.
    creationGrants = await runtime.$queryRaw`SELECT
      has_table_privilege('baseline_metric','SELECT') AS select,
      has_table_privilege('baseline_metric','INSERT') AS insert,
      has_sequence_privilege('baseline_metric_version_seq','USAGE') AS sequence_usage,
      has_sequence_privilege('baseline_metric_version_seq','SELECT') AS sequence_select,
      has_sequence_privilege('baseline_metric_version_seq','UPDATE') AS sequence_update`;
    try {
      await runtime.$executeRawUnsafe(`INSERT INTO baseline_metric
        (organization_id,id,metric_key,scope_kind,period_start,period_end,value,unit,source,recorded_by)
        VALUES ('creation','creation','METRIC','ORGANIZATION','2026-10-01','2026-11-01',1,'COUNT','test','test')`);
    } catch (error) {
      creationInsertError = error;
    }
    const before = await aclSnapshot(owner);
    let wrongRoleError: unknown;
    try {
      const adminUrl = process.env.TEST_ANALYTICS_ADMIN_URL;
      if (!adminUrl) throw new Error('TEST_ANALYTICS_ADMIN_URL is required');
      const wrongUrl = new URL(adminUrl);
      wrongUrl.pathname = `/${name}`;
      const wrongClient = new PrismaClient({ datasources: { db: { url: wrongUrl.toString() } } });
      try {
        expect(
          await wrongClient.$queryRaw`SELECT current_setting('is_superuser') AS superuser`,
        ).toEqual([{ superuser: 'on' }]);
      } finally {
        await wrongClient.$disconnect();
      }
      // A proven superuser can change every ACL/default if the guard is removed.
      applyMigration(wrongUrl.toString(), 'public', privilegeMigration);
    } catch (error) {
      wrongRoleError = error;
    }
    wrongRole = { before, after: await aclSnapshot(owner), error: wrongRoleError };
    applyMigration(ownerUrl.toString(), 'public', privilegeMigration);
    // Real order: the coverage table is born after the privilege migration revoked the defaults,
    // so its explicit GRANT is the only thing giving the runtime role anything on it.
    applyMigration(ownerUrl.toString(), 'public', coverageMigration);
    const adminUrl = process.env.TEST_ANALYTICS_ADMIN_URL;
    if (!adminUrl) throw new Error('TEST_ANALYTICS_ADMIN_URL is required');
    const extensionUrl = new URL(adminUrl);
    extensionUrl.pathname = `/${name}`;
    const extensionAdmin = new PrismaClient({
      datasources: { db: { url: extensionUrl.toString() } },
    });
    try {
      await extensionAdmin.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS postgis');
      await extensionAdmin.$executeRawUnsafe(
        'GRANT UPDATE (srtext) ON spatial_ref_sys TO rasta_analytics',
      );
      expect(
        await runtime.$queryRaw`SELECT has_any_column_privilege('spatial_ref_sys', 'UPDATE') AS forbidden`,
      ).toEqual([{ forbidden: true }]);
      // psql accepts the DO block as one statement; Prisma sends that block atomically too.
      const cleanup = currentExtensionStep().trim().replace(/;$/, '');
      if (cleanup) await extensionAdmin.$executeRawUnsafe(cleanup);
      expect(
        await runtime.$queryRaw`SELECT has_any_column_privilege('spatial_ref_sys', 'UPDATE') AS forbidden`,
      ).toEqual([{ forbidden: false }]);
    } finally {
      await extensionAdmin.$disconnect();
    }
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

  it(`after ONLY 120000 (${history === 'fresh' ? 'control: no legacy defaults' : 'legacy-default regression'}), runtime baseline INSERT is refused with 42501 and its sequence has no rights`, () => {
    expect(creationGrants).toEqual([
      {
        select: true,
        insert: false,
        sequence_usage: false,
        sequence_select: false,
        sequence_update: false,
      },
    ]);
    expect(creationInsertError).toBeInstanceOf(Error);
    expect((creationInsertError as Error).message).toMatch(/Code: `42501`/);
  });

  it('wrong-role migration refuses before any ACL change, including old defaults', () => {
    expect(wrongRole.after).toEqual(wrongRole.before);
    expect(wrongRole.error).toBeInstanceOf(Error);
    expect((wrongRole.error as Error).message).toContain(
      'analytics privilege migration requires the migrator role',
    );
    expect((wrongRole.error as Error).message).not.toContain('rasta_analytics');
  });

  it('uses the runtime identity, with every analytics relation owned by the migrator', async () => {
    expect(await runtime.$queryRaw`SELECT current_user::text AS role`).toEqual([
      { role: 'rasta_analytics' },
    ]);
    expect(
      await runtime.$queryRaw`
      SELECT DISTINCT pg_get_userbyid(c.relowner)::text AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f') AND ${APPLICATION_RELATION}`,
    ).toEqual([{ owner: 'rasta_analytics_migrator' }]);
  });

  it('has exactly the kind-specific relacl on EVERY analytics relation, including sequences and the ledger', async () => {
    const rows = await owner.$queryRaw`
      SELECT c.relname::text AS relation, c.relkind::text AS kind,
        pg_get_userbyid(a.grantee)::text AS grantee,
        array_agg(a.privilege_type ORDER BY a.privilege_type)::text[] AS privileges
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault(
        CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) a
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
        AND ${APPLICATION_RELATION}
      GROUP BY c.relname, c.relkind, a.grantee ORDER BY c.relname, grantee`;
    const expected = expectedRelations.flatMap(({ relation, kind, privileges }) => [
      ...(privileges.length ? [{ relation, kind, grantee: 'rasta_analytics', privileges }] : []),
      {
        relation,
        kind,
        grantee: 'rasta_analytics_migrator',
        privileges: kind === 'S' ? SEQUENCE_OWNER_GRANTS : OWNER_GRANTS,
      },
    ]);
    expect(rows).toEqual(expected);
    // No column-level write loopholes either.
    expect(
      await owner.$queryRaw`
      SELECT attname FROM pg_attribute WHERE attrelid = 'baseline_metric'::regclass AND attacl IS NOT NULL`,
    ).toEqual([]);
  });

  it('effective runtime rights match EVERY relation kind: no sequence USAGE, SELECT or UPDATE', async () => {
    const rows = await runtime.$queryRaw`
      SELECT c.relname::text AS relation, c.relkind::text AS kind,
        CASE WHEN c.relkind = 'S' THEN ARRAY(
          SELECT privilege FROM unnest(ARRAY['SELECT','UPDATE','USAGE']) privilege
          WHERE has_sequence_privilege('rasta_analytics', c.oid, privilege)
        ) ELSE ARRAY(
          SELECT privilege FROM unnest(ARRAY['DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']) privilege
          WHERE has_table_privilege('rasta_analytics', c.oid, privilege)
        ) END AS privileges
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
        AND ${APPLICATION_RELATION}
      ORDER BY c.relname`;
    expect(rows).toEqual(expectedRelations);
  });

  it('extension relations exist and runtime has at most SELECT, including effective column rights', async () => {
    const rows = await runtime.$queryRaw<{ relation: string; forbidden: boolean }[]>`
      SELECT c.relname::text AS relation,
        CASE WHEN c.relkind = 'S' THEN
          has_sequence_privilege(c.oid, 'USAGE,UPDATE')
        ELSE has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(c.oid, 'INSERT,UPDATE,REFERENCES') END AS forbidden
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v','m','f')
        AND NOT (${APPLICATION_RELATION})`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.relation)).toContain('spatial_ref_sys');
    expect(rows.filter((row) => row.forbidden)).toEqual([]);
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

  it('runtime records the coverage start once (insert-if-absent) and reads it; the database stamps the instant', async () => {
    const insert = () =>
      runtime.$executeRawUnsafe(
        "INSERT INTO projection_coverage (consumer_name, covered_from) VALUES ('probe', '2000-01-01') ON CONFLICT (consumer_name) DO NOTHING",
      );
    expect(await insert()).toBe(1);
    expect(await insert()).toBe(0);
    const [row] = await runtime.$queryRaw<{ covered_from: Date }[]>`
      SELECT covered_from FROM projection_coverage WHERE consumer_name = 'probe'`;
    // The supplied 2000-01-01 was ignored: coverage cannot be claimed for an unobserved past.
    expect(row?.covered_from.getUTCFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it.each([
    ['UPDATE', "UPDATE projection_coverage SET covered_from = '2000-01-01'"],
    ['DELETE', 'DELETE FROM projection_coverage'],
    ['TRUNCATE', 'TRUNCATE projection_coverage'],
  ])('runtime %s of the coverage start fails with SQLSTATE 42501', async (_operation, sql) => {
    await expect(runtime.$executeRawUnsafe(sql)).rejects.toThrow(/Code: `42501`/);
  });

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
