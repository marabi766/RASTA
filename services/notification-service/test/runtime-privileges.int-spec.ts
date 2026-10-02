import {
  INSUFFICIENT_PRIVILEGE,
  createAttempts,
  expectedTablePrivileges,
  liftAttempts,
  runtimeRoleFacts,
  schemaTriggers,
  tablePrivileges,
} from '@rasta/testing';
import { PrismaClient } from '../src/generated/prisma';
import { databaseUrl } from './helpers';

/**
 * The runtime role cannot remove the guarantees notification-service's database
 * guards give (D-045).
 *
 * Delivery attempts are append-only (`delivery_attempt_append_only`), an
 * in-app notification's read and dismiss state is write-once
 * (`in_app_notification_state_write_once`), and a published template version
 * is immutable (`trg_template_version_immutable`).
 *
 * Until D-045 the service connected as the owner of these tables, which could
 * DISABLE, DROP or ALTER each guard away. Now `rasta_notification_migrator` owns the
 * database and every object in it
 * (infrastructure/docker/postgres/lib/service-privilege-split.bash), migrations
 * connect as it, and the service connects as `rasta_notification`, which holds DML
 * and nothing more. Every statement below runs **as the runtime role** and must
 * fail with SQLSTATE 42501 — it never reaches the table, let alone a trigger.
 */

/** The guards this service keeps in the database: none may vanish unnoticed. */
const GUARDS: readonly (readonly [table: string, trigger: string])[] = [
  ['delivery_attempt', 'delivery_attempt_append_only'],
  ['in_app_notification', 'in_app_notification_state_write_once'],
  ['notification_template_version', 'trg_template_version_immutable'],
];

describe('the runtime role cannot lift an integrity guard (D-045)', () => {
  let runtime: PrismaClient;

  beforeAll(() => {
    runtime = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
  });

  afterAll(async () => {
    await runtime.$disconnect();
  });

  const refused = (sql: string) =>
    expect(runtime.$executeRawUnsafe(sql)).rejects.toThrow(INSUFFICIENT_PRIVILEGE);

  it('connects as rasta_notification, which owns neither the database nor a schema and cannot create one', async () => {
    expect(await runtimeRoleFacts(runtime)).toEqual({
      role: 'rasta_notification',
      databaseOwner: false,
      ownsASchema: false,
      createDb: false,
      createRole: false,
      bypassRls: false,
    });
  });

  it('may not DISABLE any trigger in the schema — the guards included', async () => {
    const triggers = await schemaTriggers(runtime);
    for (const [table, trigger] of GUARDS) {
      expect(triggers).toContainEqual({ table, trigger });
    }
    for (const { table, trigger } of triggers) {
      await refused(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
    }
  });

  it.each(GUARDS)(
    'may not lift or remove the guard on %s, or the table itself',
    async (table, trigger) => {
      for (const sql of liftAttempts(table, trigger)) await refused(sql);
    },
  );

  it('may not create an object it would own, or alter its database', async () => {
    for (const sql of createAttempts('rasta_notification')) await refused(sql);
  });

  it('cannot widen its own grants: a GRANT to itself changes nothing', async () => {
    // A non-owner's GRANT is a warning, not an error — so the proof is the ACL after.
    await runtime.$executeRawUnsafe(
      'GRANT TRUNCATE, TRIGGER, REFERENCES ON "delivery_attempt" TO CURRENT_USER',
    );
    const rows = await tablePrivileges(runtime);
    expect(rows.find((row) => row.table === 'delivery_attempt')?.privileges).toEqual([
      'DELETE',
      'INSERT',
      'SELECT',
      'UPDATE',
    ]);
  });

  it('holds exactly DML on every table its migrations made, and nothing on the migration ledger', async () => {
    const rows = await tablePrivileges(runtime);
    expect(rows.map((row) => row.table)).toEqual(
      expect.arrayContaining([
        'delivery_attempt',
        'in_app_notification',
        'notification_template_version',
        '_prisma_migrations',
      ]),
    );
    for (const { table, privileges } of rows) {
      expect([table, privileges]).toEqual([table, expectedTablePrivileges(table)]);
    }
  });
});
