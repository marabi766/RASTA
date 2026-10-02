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
 * The runtime role cannot remove the guarantees economic-service's database
 * guards give (D-045).
 *
 * The ledger is immutable and balanced only because the database says so: a
 * posted entry or journal cannot be updated or deleted
 * (`trg_ledger_entry_immutable`, `trg_journal_immutable`), every journal
 * balances at COMMIT (`trg_journal_balanced`), a journal is posted whole
 * (`trg_journal_has_entries`, `trg_ledger_entry_open_journal`), a wallet's
 * balances agree (`ck_wallet_balances`), and the reward evaluation cutover only
 * moves forward (`reward_evaluation_cutover_forward_only`,
 * `reward_evaluation_cutover_no_truncate`).
 *
 * Until D-045 the service connected as the owner of these tables, which could
 * DISABLE, DROP or ALTER each guard away — and so could any SQL that reached
 * the service's connection. Now `rasta_economic_migrator` owns the database and
 * every object in it (infrastructure/docker/postgres/lib/service-privilege-split.bash),
 * migrations connect as it, and the service connects as `rasta_economic`, which
 * holds DML and nothing more. Every statement below runs **as the runtime
 * role** and must fail with SQLSTATE 42501 — it never reaches the table, let
 * alone a trigger.
 */

/** The guards this service keeps in the database: none may vanish unnoticed. */
const GUARDS: readonly (readonly [table: string, trigger: string])[] = [
  ['ledger_entry', 'trg_ledger_entry_immutable'],
  ['ledger_entry', 'trg_journal_balanced'],
  ['ledger_entry', 'trg_ledger_entry_open_journal'],
  ['journal', 'trg_journal_immutable'],
  ['journal', 'trg_journal_has_entries'],
  ['reward_evaluation_cutover', 'reward_evaluation_cutover_forward_only'],
  ['reward_evaluation_cutover', 'reward_evaluation_cutover_no_truncate'],
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

  it('connects as rasta_economic, which owns neither the database nor a schema and cannot create one', async () => {
    expect(await runtimeRoleFacts(runtime)).toEqual({
      role: 'rasta_economic',
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
      // ISOLATION-ALLOW-UNBOUNDED: asserts the runtime role is refused (42501)
      // before the statement reaches the table; nothing is changed.
      await refused(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
    }
  });

  it.each(GUARDS)(
    'may not lift or remove the guard on %s (%s), or the table itself',
    async (table, trigger) => {
      for (const sql of liftAttempts(table, trigger)) await refused(sql);
    },
  );

  it('may not drop the CHECK that keeps a wallet’s balances in agreement', async () => {
    // ISOLATION-ALLOW-UNBOUNDED: asserts the refusal (42501); nothing is changed.
    await refused('ALTER TABLE "wallet" DROP CONSTRAINT "ck_wallet_balances"');
    for (const sql of liftAttempts('wallet')) await refused(sql);
  });

  it('may not create an object it would own, or alter its database', async () => {
    for (const sql of createAttempts('rasta_economic')) await refused(sql);
  });

  it('cannot widen its own grants: a GRANT to itself changes nothing', async () => {
    // A non-owner's GRANT is a warning, not an error — so the proof is the ACL after.
    // ISOLATION-ALLOW-UNBOUNDED: a GRANT, not a TRUNCATE; a non-owner's GRANT
    // changes nothing, which the ACL read below proves.
    await runtime.$executeRawUnsafe(
      'GRANT TRUNCATE, TRIGGER, REFERENCES ON "ledger_entry", "journal" TO CURRENT_USER',
    );
    const rows = await tablePrivileges(runtime);
    for (const table of ['ledger_entry', 'journal']) {
      expect(rows.find((row) => row.table === table)?.privileges).toEqual([
        'DELETE',
        'INSERT',
        'SELECT',
        'UPDATE',
      ]);
    }
  });

  it('holds exactly DML on every table its migrations made, and nothing on the migration ledger', async () => {
    const rows = await tablePrivileges(runtime);
    expect(rows.map((row) => row.table)).toEqual(
      expect.arrayContaining([
        'ledger_entry',
        'journal',
        'wallet',
        'reward_evaluation_cutover',
        '_prisma_migrations',
      ]),
    );
    for (const { table, privileges } of rows) {
      expect([table, privileges]).toEqual([table, expectedTablePrivileges(table)]);
    }
  });
});
