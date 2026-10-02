import { PrismaClient } from '../src/generated/prisma';
import { databaseUrl } from './helpers';

/**
 * The runtime role cannot remove the guarantees construction's triggers give
 * (D-045).
 *
 * The criteria freeze (C3), the append-only criteria template, the tender's
 * status transitions and its publish rule, and the tender key guard are
 * database triggers. A trigger binds every role, but its table's owner can
 * DISABLE, DROP or ALTER it away — and until D-045 the service connected as
 * that owner. Now `rasta_construction_migrator` owns the database and every
 * object in it (infrastructure/docker/postgres/lib/service-privilege-split.bash),
 * migrations and test cleanup connect as it, and the service connects as
 * `rasta_construction`, which holds DML and nothing more.
 *
 * Every statement below runs **as the runtime role** and must fail with
 * SQLSTATE 42501 (insufficient privilege) — never reaching the table, let
 * alone a trigger. The triggers themselves are proved in the domain suites,
 * which run as the same role.
 */

const DENIED = /Code: `42501`/;

/** The guards this service keeps in the database, by table: none may vanish unnoticed. */
const GUARDS = [
  ['tender_criterion', 'tg_tender_criterion_freeze'],
  ['tender', 'tg_tender_publish_requires_criteria'],
  ['tender', 'tg_tender_status_transition'],
  ['criteria_template', 'tg_criteria_template_append_only'],
  ['criteria_template', 'tg_criteria_template_no_truncate'],
  ['tender_key', 'tg_tender_key_guard'],
] as const;

describe('the runtime role cannot lift an integrity guard (D-045)', () => {
  let runtime: PrismaClient;

  beforeAll(() => {
    runtime = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
  });

  afterAll(async () => {
    await runtime.$disconnect();
  });

  const refused = (sql: string) => expect(runtime.$executeRawUnsafe(sql)).rejects.toThrow(DENIED);

  it('connects as rasta_construction, which owns neither the database nor any schema', async () => {
    const [row] = await runtime.$queryRaw<
      { role: string; databaseOwner: boolean; ownsASchema: boolean; createDb: boolean }[]
    >`
      SELECT current_user::text AS role,
             pg_has_role(current_user, d.datdba, 'USAGE') AS "databaseOwner",
             EXISTS (SELECT 1 FROM pg_namespace n
                      WHERE pg_has_role(current_user, n.nspowner, 'USAGE')
                        AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema')
               AS "ownsASchema",
             r.rolcreatedb AS "createDb"
        FROM pg_database d, pg_roles r
       WHERE d.datname = current_database() AND r.rolname = current_user`;
    expect(row).toEqual({
      role: 'rasta_construction',
      databaseOwner: false,
      ownsASchema: false,
      createDb: false,
    });
  });

  it('may not DISABLE any trigger in the schema — every one of them, the six guards included', async () => {
    const triggers = await runtime.$queryRaw<{ table: string; trigger: string }[]>`
      SELECT c.relname AS "table", t.tgname AS "trigger"
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
       ORDER BY 1, 2`;
    for (const [table, trigger] of GUARDS) {
      expect(triggers).toContainEqual({ table, trigger });
    }
    for (const { table, trigger } of triggers) {
      await refused(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
    }
    await refused('ALTER TABLE "tender_criterion" DISABLE TRIGGER ALL');
  });

  it('may not DROP a trigger, or the function behind it', async () => {
    await refused('DROP TRIGGER "tg_tender_criterion_freeze" ON "tender_criterion"');
    await refused('DROP FUNCTION IF EXISTS "criteria_template_append_only"() CASCADE');
  });

  it('may not ALTER, DROP or TRUNCATE a table', async () => {
    await refused('ALTER TABLE "tender" ADD COLUMN "d045_probe" integer');
    await refused('ALTER TABLE "tender_criterion" DROP CONSTRAINT IF EXISTS "d045_none"');
    await refused('ALTER TABLE "tender" OWNER TO rasta_construction');
    await refused('DROP TABLE "tender_criterion"');
    await refused('TRUNCATE "tender_key"');
  });

  it('may not create an object it would own, or drop the database', async () => {
    await refused('CREATE TABLE "public"."d045_probe" (id integer)');
    await refused('CREATE SCHEMA "d045_probe"');
    await refused(
      'CREATE FUNCTION "public"."d045_probe"() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
    );
    await refused('ALTER DATABASE "rasta_construction" RENAME TO "d045_probe"');
  });

  it('cannot widen its own grants: a GRANT to itself changes nothing', async () => {
    // A non-owner's GRANT is a warning, not an error — so the proof is the ACL after.
    await runtime.$executeRawUnsafe('GRANT TRUNCATE, TRIGGER ON "tender" TO rasta_construction');
    const [row] = await runtime.$queryRaw<{ truncate: boolean; trigger: boolean }[]>`
      SELECT has_table_privilege('tender', 'TRUNCATE') AS truncate,
             has_table_privilege('tender', 'TRIGGER') AS trigger`;
    expect(row).toEqual({ truncate: false, trigger: false });
  });

  it('holds exactly DML on every table its migrations made, and nothing on the migration ledger', async () => {
    const rows = await runtime.$queryRaw<{ table: string; privileges: string[] }[]>`
      SELECT t.tablename AS "table",
             ARRAY(SELECT p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                                              'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
                    WHERE has_table_privilege(format('%I.%I', t.schemaname, t.tablename), p)
                    ORDER BY p) AS privileges
        FROM pg_tables t
       WHERE t.schemaname = 'public'
         AND NOT EXISTS (
           SELECT 1 FROM pg_depend d
            WHERE d.classid = 'pg_class'::regclass
              AND d.objid = format('%I.%I', t.schemaname, t.tablename)::regclass
              AND d.deptype = 'e')
       ORDER BY 1`;
    expect(rows.length).toBeGreaterThan(10);
    for (const { table, privileges } of rows) {
      expect([table, privileges]).toEqual([
        table,
        table === '_prisma_migrations' ? [] : ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      ]);
    }
  });
});
