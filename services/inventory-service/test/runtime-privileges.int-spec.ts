import type { PrismaClient } from '../src/generated/prisma';
import { runtimeClient } from './helpers';

/**
 * The runtime role cannot remove the guarantees inventory's triggers give (D-045,
 * `docs/runbooks/db-role-split.md` § 7.5).
 *
 * The append-only ledger, the balance that moves only with its movement, the reservation that
 * ends once and the warehouse that is never erased are database triggers. A trigger binds every
 * role, but its table's owner can DISABLE, DROP or ALTER it away. `rasta_inventory_migrator` owns
 * the database and everything in it; the service connects as `rasta_inventory`, which holds DML
 * and nothing more. Every statement below runs **as the runtime role** and must fail with
 * SQLSTATE 42501 (insufficient privilege).
 */

const DENIED = /Code: `42501`/;

/** The guards this service keeps in the database, by table: none may vanish unnoticed. */
const GUARDS = [
  ['warehouse', 'tg_warehouse_guard'],
  ['warehouse', 'tg_warehouse_no_truncate'],
  ['stock_item', 'tg_stock_item_guard'],
  ['stock_item', 'tg_stock_item_no_truncate'],
  ['stock_item', 'tg_stock_item_ledger_check'],
  ['stock_movement', 'tg_stock_movement_append_only'],
  ['stock_movement', 'tg_stock_movement_no_truncate'],
  ['stock_movement', 'tg_stock_movement_chain'],
  ['stock_reservation', 'tg_stock_reservation_guard'],
  ['stock_reservation', 'tg_stock_reservation_no_truncate'],
  ['stock_reservation', 'tg_stock_reservation_ledger_check'],
  ['shipment', 'tg_shipment_guard'],
  ['shipment', 'tg_shipment_no_truncate'],
  ['shipment', 'tg_shipment_history_check'],
  ['shipment_leg', 'tg_shipment_leg_guard'],
  ['shipment_leg', 'tg_shipment_leg_no_truncate'],
  ['tracking_event', 'tg_tracking_event_guard'],
  ['tracking_event', 'tg_tracking_event_no_truncate'],
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

  it('connects as rasta_inventory, which owns neither the database nor any schema', async () => {
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
      role: 'rasta_inventory',
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
    await refused('ALTER TABLE "stock_movement" DISABLE TRIGGER ALL');
  });

  it('may not DROP a trigger, or the function behind it', async () => {
    await refused('DROP TRIGGER "tg_stock_movement_append_only" ON "stock_movement"');
    await refused('DROP FUNCTION IF EXISTS "stock_movement_chain"() CASCADE');
  });

  it('may not ALTER, DROP or TRUNCATE a table', async () => {
    await refused('ALTER TABLE "stock_item" ADD COLUMN "d045_probe" integer');
    await refused(
      'ALTER TABLE "stock_item" DROP CONSTRAINT IF EXISTS "ck_stock_item_reserved_within_on_hand"',
    );
    await refused('ALTER TABLE "stock_movement" OWNER TO rasta_inventory');
    await refused('DROP TABLE "stock_movement"');
    await refused('TRUNCATE "stock_reservation"');
    await refused('TRUNCATE "tracking_event"');
    await refused('ALTER TABLE "shipment" DROP CONSTRAINT IF EXISTS "ck_shipment_status"');
  });

  it('may not create an object it would own, or rename the database', async () => {
    await refused('CREATE TABLE "public"."d045_probe" (id integer)');
    await refused('CREATE SCHEMA "d045_probe"');
    await refused(
      'CREATE FUNCTION "public"."d045_probe"() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
    );
    await refused('ALTER DATABASE "rasta_inventory" RENAME TO "d045_probe"');
  });

  it('cannot widen its own grants: a GRANT to itself changes nothing', async () => {
    await runtime.$executeRawUnsafe(
      'GRANT TRUNCATE, TRIGGER ON "stock_movement" TO rasta_inventory',
    );
    const [row] = await runtime.$queryRaw<{ truncate: boolean; trigger: boolean }[]>`
      SELECT has_table_privilege('stock_movement', 'TRUNCATE') AS truncate,
             has_table_privilege('stock_movement', 'TRIGGER') AS trigger`;
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
      'idempotency_key',
      'outbox_message',
      'outbox_stream_sequence',
      'return_shipment',
      'return_shipment_line',
      'return_tracking_event',
      'shipment',
      'shipment_leg',
      'stock_item',
      'stock_movement',
      'stock_reservation',
      'tracking_event',
      'warehouse',
    ]);
    for (const { table, privileges } of rows) {
      expect([table, privileges]).toEqual([
        table,
        table === '_prisma_migrations' ? [] : ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      ]);
    }
  });
});
