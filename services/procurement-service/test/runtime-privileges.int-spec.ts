import type { PrismaClient } from '../src/generated/prisma';
import { runtimeClient } from './helpers';

/**
 * The runtime role cannot remove the guarantees procurement's triggers give (D-045,
 * `docs/runbooks/db-role-split.md` § 7.5).
 *
 * A demand that joins only an open window and only inside it, a window whose contents freeze when
 * it ends, totals that are always their demands' and rows that are never erased are database
 * triggers. A trigger binds every
 * role, but its table's owner can DISABLE, DROP or ALTER it away. `rasta_procurement_migrator` owns
 * the database and everything in it; the service connects as `rasta_procurement`, which holds DML
 * and nothing more. Every statement below runs **as the runtime role** and must fail with
 * SQLSTATE 42501 (insufficient privilege).
 */

const DENIED = /Code: `42501`/;

/** The guards this service keeps in the database, by table: none may vanish unnoticed. */
const GUARDS = [
  ['aggregation_setting', 'tg_aggregation_setting_guard'],
  ['aggregation_setting', 'tg_aggregation_setting_no_truncate'],
  ['demand_aggregation', 'tg_demand_aggregation_born'],
  ['demand_aggregation', 'tg_demand_aggregation_snapshot'],
  ['demand_aggregation', 'tg_demand_aggregation_guard'],
  ['demand_aggregation', 'tg_demand_aggregation_no_truncate'],
  ['demand_aggregation', 'tg_demand_aggregation_totals_check'],
  ['demand_request', 'tg_demand_request_guard'],
  ['demand_request', 'tg_demand_request_no_truncate'],
  ['demand_request', 'tg_demand_request_totals_check'],
] as const;

describe('the runtime role cannot lift an integrity guard (D-045)', () => {
  let runtime: PrismaClient;

  beforeAll(() => {
    runtime = runtimeClient();
  });

  afterAll(async () => {
    await runtime.$disconnect();
  });

  const refused = (sql: string) => expect(runtime.$executeRawUnsafe(sql)).rejects.toThrow(DENIED);

  it('connects as rasta_procurement, which owns neither the database nor any schema', async () => {
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
      role: 'rasta_procurement',
      databaseOwner: false,
      ownsASchema: false,
      createDb: false,
    });
  });

  it('may not DISABLE any trigger in the schema — every one of them, the guards included', async () => {
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
    await refused('ALTER TABLE "demand_request" DISABLE TRIGGER ALL');
  });

  it('may not DROP a trigger, or the function behind it', async () => {
    await refused('DROP TRIGGER "tg_demand_request_guard" ON "demand_request"');
    await refused('DROP FUNCTION IF EXISTS "demand_aggregation_totals_check"() CASCADE');
  });

  it('may not ALTER, DROP or TRUNCATE a table', async () => {
    await refused('ALTER TABLE "demand_request" ADD COLUMN "d045_probe" integer');
    await refused(
      'ALTER TABLE "demand_request" DROP CONSTRAINT IF EXISTS "fk_demand_request_aggregation"',
    );
    await refused('ALTER TABLE "demand_aggregation" OWNER TO rasta_procurement');
    await refused('DROP TABLE "demand_request"');
    await refused('TRUNCATE "demand_aggregation"');
    await refused('DROP INDEX IF EXISTS "ux_demand_aggregation_open"');
    await refused(
      'ALTER TABLE "demand_aggregation" DROP CONSTRAINT IF EXISTS "ck_demand_aggregation_status"',
    );
  });

  it('may not create an object it would own, or rename the database', async () => {
    await refused('CREATE TABLE "public"."d045_probe" (id integer)');
    await refused('CREATE SCHEMA "d045_probe"');
    await refused(
      'CREATE FUNCTION "public"."d045_probe"() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
    );
    await refused('ALTER DATABASE "rasta_procurement" RENAME TO "d045_probe"');
  });

  it('cannot widen its own grants: a GRANT to itself changes nothing', async () => {
    await runtime.$executeRawUnsafe(
      'GRANT TRUNCATE, TRIGGER ON "demand_request" TO rasta_procurement',
    );
    const [row] = await runtime.$queryRaw<{ truncate: boolean; trigger: boolean }[]>`
      SELECT has_table_privilege('demand_request', 'TRUNCATE') AS truncate,
             has_table_privilege('demand_request', 'TRIGGER') AS trigger`;
    expect(row).toEqual({ truncate: false, trigger: false });
  });

  it('holds exactly DML on every table its migration made, and nothing on the migration ledger', async () => {
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
    expect(rows.map((row) => row.table)).toEqual([
      '_prisma_migrations',
      'demand_aggregation',
      'demand_request',
      'idempotency_key',
      'outbox_message',
      'outbox_stream_sequence',
    ]);
    for (const { table, privileges } of rows) {
      expect([table, privileges]).toEqual([
        table,
        table === '_prisma_migrations' ? [] : ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      ]);
    }
  });
});
