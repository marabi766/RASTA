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
 * The runtime role cannot alter, drop or empty marketplace-service's tables
 * (D-045).
 *
 * This service keeps no trigger guards, but its CHECK constraints, unique
 * indexes and foreign keys are the database's half of its invariants, and the
 * tables themselves are its data. Until D-045 the service connected as their
 * owner, which could drop any constraint, ALTER, DROP or TRUNCATE any table.
 * Now `rasta_marketplace_migrator` owns the database and every object in it
 * (infrastructure/docker/postgres/lib/service-privilege-split.bash), migrations
 * connect as it, and the service connects as `rasta_marketplace`, which holds DML
 * and nothing more. Every statement below runs **as the runtime role** and must
 * fail with SQLSTATE 42501.
 */

/** Tables whose loss or change would hurt most: the aggregate and its outbox. */
const TABLES = ['order', 'offer', 'outbox_message'];

describe('the runtime role cannot alter, drop or empty a table (D-045)', () => {
  let runtime: PrismaClient;

  beforeAll(() => {
    runtime = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
  });

  afterAll(async () => {
    await runtime.$disconnect();
  });

  const refused = (sql: string) =>
    expect(runtime.$executeRawUnsafe(sql)).rejects.toThrow(INSUFFICIENT_PRIVILEGE);

  it('connects as rasta_marketplace, which owns neither the database nor a schema and cannot create one', async () => {
    expect(await runtimeRoleFacts(runtime)).toEqual({
      role: 'rasta_marketplace',
      databaseOwner: false,
      ownsASchema: false,
      createDb: false,
      createRole: false,
      bypassRls: false,
    });
  });

  it('may not DISABLE any trigger in the schema', async () => {
    for (const { table, trigger } of await schemaTriggers(runtime)) {
      await refused(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
    }
  });

  it.each(TABLES)(
    'may not lift a constraint on %s, or alter, drop or truncate it',
    async (table) => {
      for (const sql of liftAttempts(table)) await refused(sql);
    },
  );

  it('may not create an object it would own, or alter its database', async () => {
    for (const sql of createAttempts('rasta_marketplace')) await refused(sql);
  });

  it('cannot widen its own grants: a GRANT to itself changes nothing', async () => {
    // A non-owner's GRANT is a warning, not an error — so the proof is the ACL after.
    await runtime.$executeRawUnsafe(
      `GRANT TRUNCATE, TRIGGER, REFERENCES ON "${TABLES[0]}" TO CURRENT_USER`,
    );
    const rows = await tablePrivileges(runtime);
    expect(rows.find((row) => row.table === TABLES[0])?.privileges).toEqual([
      'DELETE',
      'INSERT',
      'SELECT',
      'UPDATE',
    ]);
  });

  it('holds exactly DML on every table its migrations made, and nothing on the migration ledger', async () => {
    const rows = await tablePrivileges(runtime);
    expect(rows.map((row) => row.table)).toEqual(
      expect.arrayContaining([...TABLES, '_prisma_migrations']),
    );
    for (const { table, privileges } of rows) {
      expect([table, privileges]).toEqual([table, expectedTablePrivileges(table)]);
    }
  });
});
