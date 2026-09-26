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

/**
 * The relations this service's migrations created: every table in the schema
 * except an extension's. The bootstrap installs postgis into every service
 * database, and postgis puts `spatial_ref_sys` into `public`, owned by the
 * superuser — a table no migration made and no grant of ours touches.
 * Recognised by extension membership (pg_depend, deptype 'e'), never by name:
 * the same rule the reversibility verifier applies.
 */
const NOT_AN_EXTENSION_TABLE = `
  NOT EXISTS (
    SELECT 1 FROM pg_depend d
     WHERE d.classid = 'pg_class'::regclass
       AND d.objid = format('%I.%I', t.schemaname, t.tablename)::regclass
       AND d.deptype = 'e'
  )`;

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
        `SELECT DISTINCT t.tableowner::text AS owner FROM pg_tables t
          WHERE t.schemaname = current_schema() AND ${NOT_AN_EXTENSION_TABLE}`,
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
          WHERE t.schemaname = current_schema() AND ${NOT_AN_EXTENSION_TABLE}
          ORDER BY 1`,
      ),
    );
    const actual = Object.fromEntries(rows.map((row) => [row.table, row.privileges ?? []]));

    expect(actual).toEqual(
      Object.fromEntries(Object.entries(EXPECTED_GRANTS).map(([t, p]) => [t, [...p].sort()])),
    );
  });

  it('gets nothing from an extension’s tables beyond what the extension grants everyone', async () => {
    // The other half of excluding them above: postgis's tables are the
    // superuser's, and the runtime role may at most read them — never own,
    // write, truncate or alter them. On a cluster without postgis there are
    // none, and this holds trivially.
    const rows = await raw(() =>
      owner.client.$queryRawUnsafe<{ table: string; owner: string; writes: string[] | null }[]>(
        `SELECT t.tablename::text AS "table", t.tableowner::text AS "owner",
                (SELECT array_agg(p ORDER BY p)
                   FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
                  WHERE has_table_privilege('rasta_supplier', format('%I.%I', t.schemaname, t.tablename), p)
                ) AS writes
           FROM pg_tables t
          WHERE t.schemaname = current_schema() AND NOT (${NOT_AN_EXTENSION_TABLE})`,
      ),
    );

    for (const row of rows) {
      expect(row.owner).not.toBe('rasta_supplier');
      expect({ table: row.table, writes: row.writes ?? [] }).toEqual({
        table: row.table,
        writes: [],
      });
    }
  });

  it('still does the work the service needs: insert and read a formula draft', async () => {
    const { id } = await seedDraft(runtime);
    const found = await raw(() =>
      runtime.client.performanceFormulaVersion.findUnique({ where: { id } }),
    );

    expect(found?.status).toBe('DRAFT');
  });

  describe('functions (Codex review of #120, round 3)', () => {
    // PostgreSQL grants EXECUTE on a new function to PUBLIC. The split
    // removes that default for the migrator — in its global form, because a
    // per-schema default cannot revoke a global one — and strips EXECUTE
    // from the functions it already owns.

    const executable = async (signature: string): Promise<boolean> => {
      const [row] = await raw(() =>
        owner.client.$queryRawUnsafe<{ can: boolean }[]>(
          `SELECT has_function_privilege('rasta_supplier', '${signature}', 'EXECUTE') AS "can"`,
        ),
      );
      return row?.can ?? true;
    };

    it.each([
      ['a plain function', ''],
      ['a SECURITY DEFINER function', 'SECURITY DEFINER'],
    ])(
      'does not let the runtime role execute %s the migrator creates later',
      async (_label, mode) => {
        const name = `probe_${process.pid}_${mode ? 'definer' : 'plain'}_${Date.now()}`;
        await raw(() =>
          owner.client.$executeRawUnsafe(
            `CREATE FUNCTION "${name}"() RETURNS int LANGUAGE sql ${mode} AS 'SELECT 1'`,
          ),
        );
        try {
          expect(await executable(`"${name}"()`)).toBe(false);
          await expect(asRuntime(`SELECT "${name}"()`)).rejects.toThrow(DENIED);
        } finally {
          await raw(() => owner.client.$executeRawUnsafe(`DROP FUNCTION "${name}"()`));
        }
      },
    );

    it('lets the runtime role execute none of the functions the migrations created', async () => {
      const rows = await raw(() =>
        owner.client.$queryRawUnsafe<{ fn: string; can: boolean }[]>(
          `SELECT p.oid::regprocedure::text AS "fn",
                  has_function_privilege('rasta_supplier', p.oid, 'EXECUTE') AS "can"
             FROM pg_proc p
            WHERE p.pronamespace = current_schema()::regnamespace
              AND NOT EXISTS (
                SELECT 1 FROM pg_depend d
                 WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
              )`,
        ),
      );

      // Not vacuous: the three performance migrations create eight functions.
      expect(rows.length).toBeGreaterThanOrEqual(8);
      expect(rows.filter((row) => row.can)).toEqual([]);
    });

    it('still runs every trigger for the runtime role — firing needs no EXECUTE', async () => {
      // A version with no weights: the deferred 100% trigger must refuse it at
      // commit, which it can only do if it runs.
      await expect(
        raw(() =>
          runtime.client.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
              `INSERT INTO "performance_formula_version" ("id", "formula_version", "window_days",
                 "min_sample_count", "min_coverage_bp", "rating_scale_min", "rating_scale_max",
                 "rating_min_score_centis", "rating_max_score_centis", "created_by", "created_correlation_id")
               VALUES ('PFV_TRIGGER_PROBE_${process.pid}', 2000000000 - ${process.pid}, 180, 5, 5000, 1, 5, 0, 10000, 'U', 'C')`,
            );
          }),
        ),
      ).rejects.toThrow(/exactly 10000 bp is required/);

      // And the row-level guard on UPDATE, which the runtime role may issue.
      const { id } = await seedDraft(runtime);
      await expect(
        asRuntime(
          `UPDATE "performance_formula_version" SET "status" = 'RETIRED' WHERE "id" = '${id}'`,
        ),
      ).rejects.toThrow(/may go from DRAFT only to ACTIVE/);
    });
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
