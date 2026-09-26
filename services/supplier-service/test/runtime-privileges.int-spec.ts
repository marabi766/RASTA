import { PrismaService } from '../src/prisma/prisma.service';
import { newPrisma } from './helpers';
import { ownerPrisma, raw, seedDraft } from './performance-helpers';

/**
 * The runtime role cannot remove the guarantees the triggers give (Codex
 * review of #120, finding 2).
 *
 * The performance tables are frozen, append-only or insert-only by trigger,
 * and a trigger binds only a role that cannot disable, alter or drop it. The
 * service connects as `rasta_supplier`; the database and every table in it
 * belong to `rasta_supplier_migrator` (lib/supplier-privilege-split.bash). Every statement below is run
 * **as the runtime role** and must fail with SQLSTATE 42501 — insufficient
 * privilege — rather than with a trigger message: the point is that it never
 * reaches the table at all.
 *
 * The trigger layer itself is proved as the owner in the three
 * `performance-*.int-spec.ts` suites.
 */

const DENIED = /Code: `42501`/;

/** What the runtime role must hold on every table in the schema — no more, no less. */
const EXPECTED_GRANTS: Record<string, readonly string[]> = {
  supplier: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  supplier_capability: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  qualification: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  qualification_evidence: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  suspension: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  outbox_message: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  outbox_stream_sequence: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  processed_event: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  performance_formula_version: ['INSERT', 'SELECT', 'UPDATE'],
  performance_formula_weight: ['INSERT', 'SELECT'],
  performance_event: ['INSERT', 'SELECT'],
  performance_score_snapshot: ['INSERT', 'SELECT'],
  performance_score_component: ['INSERT', 'SELECT'],
  performance_score_source_event: ['INSERT', 'SELECT'],
  // Prisma's ledger: migration tooling only.
  _prisma_migrations: [],
};

const PROTECTED_TABLES = [
  'performance_formula_version',
  'performance_formula_weight',
  'performance_event',
  'performance_score_snapshot',
  'performance_score_component',
  'performance_score_source_event',
] as const;

/** One trigger per protected table, by name, for the DROP TRIGGER attempt. */
const A_TRIGGER: Record<(typeof PROTECTED_TABLES)[number], string> = {
  performance_formula_version: 'trg_performance_formula_version_guard',
  performance_formula_weight: 'trg_performance_formula_weight_sum',
  performance_event: 'trg_performance_event_append_only',
  performance_score_snapshot: 'trg_performance_score_snapshot_consistent',
  performance_score_component: 'trg_performance_score_component_sealed',
  performance_score_source_event: 'trg_performance_score_source_event_sealed',
};

describe('the runtime role cannot lift the performance tables’ guarantees', () => {
  let runtime: PrismaService;
  let owner: PrismaService;

  beforeAll(() => {
    runtime = newPrisma();
    owner = ownerPrisma();
  });

  afterAll(async () => {
    await runtime.onModuleDestroy();
    await owner.onModuleDestroy();
  });

  function asRuntime(sql: string): Promise<number> {
    return raw(() => runtime.client.$executeRawUnsafe(sql));
  }

  it('is connected as rasta_supplier, and the tables belong to someone else', async () => {
    const [who] = await raw(() =>
      runtime.client.$queryRawUnsafe<{ role: string; schema: string }[]>(
        'SELECT current_user::text AS role, current_schema()::text AS schema',
      ),
    );
    const owners = await raw(() =>
      runtime.client.$queryRawUnsafe<{ owner: string }[]>(
        `SELECT DISTINCT tableowner::text AS owner FROM pg_tables WHERE schemaname = current_schema()`,
      ),
    );

    expect(who).toEqual({ role: 'rasta_supplier', schema: 'public' });
    expect(owners.map((row) => row.owner)).toEqual(['rasta_supplier_migrator']);
  });

  describe.each(PROTECTED_TABLES)('%s', (table) => {
    it.each([
      ['disable its triggers', `ALTER TABLE "${table}" DISABLE TRIGGER ALL`],
      ['disable one trigger', `ALTER TABLE "${table}" DISABLE TRIGGER "${A_TRIGGER[table]}"`],
      ['drop a trigger', `DROP TRIGGER "${A_TRIGGER[table]}" ON "${table}"`],
      ['alter the table', `ALTER TABLE "${table}" ADD COLUMN "smuggled" TEXT`],
      ['drop the table', `DROP TABLE "${table}"`],
      ['truncate it', `TRUNCATE "${table}"`],
    ])('refuses to %s with 42501', async (_label, sql) => {
      await expect(asRuntime(sql)).rejects.toThrow(DENIED);
    });
  });

  it.each([
    ['UPDATE a performance event', `UPDATE "performance_event" SET "correlation_id" = 'X'`],
    ['DELETE a performance event', 'DELETE FROM "performance_event"'],
    ['UPDATE a snapshot', `UPDATE "performance_score_snapshot" SET "score_centis" = 0`],
    ['DELETE a snapshot', 'DELETE FROM "performance_score_snapshot"'],
    ['UPDATE a snapshot component', 'UPDATE "performance_score_component" SET "sample_count" = 0'],
    ['DELETE a snapshot component', 'DELETE FROM "performance_score_component"'],
    ['DELETE a snapshot source event', 'DELETE FROM "performance_score_source_event"'],
    ['DELETE a formula version', 'DELETE FROM "performance_formula_version"'],
    [
      'UPDATE a formula weight',
      'UPDATE "performance_formula_weight" SET "weight_bp" = "weight_bp"',
    ],
    ['DELETE a formula weight', 'DELETE FROM "performance_formula_weight"'],
    ['rewrite the migration ledger', 'DELETE FROM "_prisma_migrations"'],
  ])('refuses to %s with 42501', async (_label, sql) => {
    await expect(asRuntime(sql)).rejects.toThrow(DENIED);
  });

  it.each([
    ['create a table in the schema', 'CREATE TABLE "shadow" ("id" TEXT)'],
    [
      'create a function in the schema',
      'CREATE FUNCTION "noop"() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
    ],
    ['drop the schema', 'DROP SCHEMA "public" CASCADE'],
    ['drop a trigger function', 'DROP FUNCTION "performance_event_append_only"()'],
  ])('refuses to %s with 42501', async (_label, sql) => {
    await expect(asRuntime(sql)).rejects.toThrow(DENIED);
  });

  it('cannot grant itself what it was not given', async () => {
    // PostgreSQL answers a non-owner's GRANT with a WARNING, not an error, and
    // grants nothing. So the proof is the privilege afterwards.
    await asRuntime(
      'GRANT UPDATE, DELETE, TRUNCATE ON "performance_event" TO rasta_supplier',
    ).catch(() => undefined);
    const [row] = await raw(() =>
      runtime.client.$queryRawUnsafe<{ update: boolean; del: boolean; truncate: boolean }[]>(
        `SELECT has_table_privilege('performance_event', 'UPDATE') AS "update",
                has_table_privilege('performance_event', 'DELETE') AS "del",
                has_table_privilege('performance_event', 'TRUNCATE') AS "truncate"`,
      ),
    );

    expect(row).toEqual({ update: false, del: false, truncate: false });
  });

  it('holds exactly the expected grants on every table, and every table is accounted for', async () => {
    // A table added by a later migration without a grant — or with a wider
    // one — fails here rather than in production.
    const rows = await raw(() =>
      owner.client.$queryRawUnsafe<{ table: string; privileges: string[] | null }[]>(
        `SELECT t.tablename::text AS "table",
                (SELECT array_agg(p ORDER BY p)
                   FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
                  WHERE has_table_privilege('rasta_supplier', format('%I.%I', t.schemaname, t.tablename), p)
                ) AS privileges
           FROM pg_tables t
          WHERE t.schemaname = current_schema()
          ORDER BY 1`,
      ),
    );
    const actual = Object.fromEntries(rows.map((row) => [row.table, row.privileges ?? []]));

    expect(actual).toEqual(
      Object.fromEntries(Object.entries(EXPECTED_GRANTS).map(([t, p]) => [t, [...p].sort()])),
    );
  });

  it('still does the work the service needs: insert and read a formula draft', async () => {
    const { id } = await seedDraft(runtime);
    const found = await raw(() =>
      runtime.client.performanceFormulaVersion.findUnique({ where: { id } }),
    );

    expect(found?.status).toBe('DRAFT');
  });

  describe('the database itself (Codex review of #120, round 2 finding 2)', () => {
    /** The runtime role, connected to the maintenance database `postgres`. */
    let elsewhere: PrismaService;

    beforeAll(() => {
      const url = new URL(process.env.DATABASE_URL_SUPPLIER ?? '');
      url.pathname = '/postgres';
      elsewhere = new PrismaService(url.toString());
    });

    afterAll(async () => {
      await elsewhere.onModuleDestroy();
    });

    it('does not own the database and holds neither CREATEDB nor CREATEROLE', async () => {
      const [facts] = await raw(() =>
        runtime.client.$queryRawUnsafe<
          { owner: string; createDb: boolean; createRole: boolean; superuser: boolean }[]
        >(
          `SELECT pg_get_userbyid(d.datdba)::text AS "owner", r.rolcreatedb AS "createDb",
                  r.rolcreaterole AS "createRole", r.rolsuper AS "superuser"
             FROM pg_database d, pg_roles r
            WHERE d.datname = current_database() AND r.rolname = current_user`,
        ),
      );

      expect(facts).toEqual({
        owner: 'rasta_supplier_migrator',
        createDb: false,
        createRole: false,
        superuser: false,
      });
    });

    it.each([
      ['drop its own database from another', 'DROP DATABASE "rasta_supplier" WITH (FORCE)'],
      ['take the database back', 'ALTER DATABASE "rasta_supplier" OWNER TO rasta_supplier'],
      ['create a database', 'CREATE DATABASE "rasta_supplier_shadow_attempt"'],
    ])('refuses to %s with 42501', async (_label, sql) => {
      await expect(raw(() => elsewhere.client.$executeRawUnsafe(sql))).rejects.toThrow(DENIED);
    });

    it('refuses CREATE and TEMP on its own database', async () => {
      const [row] = await raw(() =>
        runtime.client.$queryRawUnsafe<{ create: boolean; temp: boolean; connect: boolean }[]>(
          `SELECT has_database_privilege(current_database(), 'CREATE') AS "create",
                  has_database_privilege(current_database(), 'TEMP') AS "temp",
                  has_database_privilege(current_database(), 'CONNECT') AS "connect"`,
        ),
      );

      expect(row).toEqual({ create: false, temp: false, connect: true });
      await expect(asRuntime('CREATE SCHEMA "smuggled"')).rejects.toThrow(DENIED);
    });
  });

  describe('startup refuses any role that could', () => {
    it('accepts the runtime role', async () => {
      await expect(runtime.assertRuntimeRole()).resolves.toBeUndefined();
    });

    it('refuses the migrator — it holds CREATEDB and owns the database', async () => {
      await expect(owner.assertRuntimeRole()).rejects.toThrow(
        /refuses to start.*rasta_supplier_migrator.*holds CREATEDB.*owner of database rasta_supplier/,
      );
    });
  });
});
