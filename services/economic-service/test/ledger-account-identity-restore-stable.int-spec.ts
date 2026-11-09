import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '../src/generated/prisma';
import { ownerDatabaseUrl } from './helpers';

/**
 * `trg_ledger_account_identity_fixed` in the form PostgreSQL prints back (FU-308 B, migration
 * 20261109200000_ledger_account_identity_restore_stable): the rewritten condition refuses and
 * allows exactly what 20261104120000's did, a restore prints it as its source does, and the down
 * script gives 20261104120000's back.
 *
 * Every statement under test is read from its migration file, never copied here, so a change to
 * either file is what these run.
 */
jest.setTimeout(120_000);

type Tx = Prisma.TransactionClient;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const BEFORE = '20261104120000_settlement_reversal';
const AFTER = '20261109200000_ledger_account_identity_restore_stable';
const TRIGGER = 'trg_ledger_account_identity_fixed';
const TABLE = 'ON "ledger_account"';
const REFUSES = 'EXECUTE FUNCTION reject_ledger_account_identity_change()';

/** The one statement of that file which defines the trigger, as the file wrote it. */
function statement(migration: string, file: 'migration.sql' | 'down.sql'): string {
  const sql = readFileSync(join(MIGRATIONS, migration, file), 'utf8');
  const found = sql.match(new RegExp(`^CREATE (?:OR REPLACE )?TRIGGER "${TRIGGER}"[^;]*;`, 'gm'));
  if (found?.length !== 1) {
    throw new Error(`${migration}/${file}: expected one definition of the trigger`);
  }
  return found[0];
}

/** The identity columns, each with two values of its own type. */
const COLUMNS = [
  ['id', 'TEXT', 'ACC_A', 'ACC_B'],
  ['organization_id', 'TEXT', 'ORG-A', 'ORG-B'],
  ['account_type', '"AccountType"', 'ASSET', 'LIABILITY'],
  ['purpose', '"AccountPurpose"', 'WALLET', 'ESCROW'],
  ['currency', 'TEXT', 'IRR', 'USD'],
] as const;

/** What an UPDATE can do to one column, and whether that is a change of it. */
const MOVES = [
  ['unchanged', (a: string) => [a, a], false],
  ['changed', (a: string, b: string) => [a, b], true],
  ['NULL to a value', (a: string) => [null, a], true],
  ['a value to NULL', (a: string) => [a, null], true],
  ['NULL to NULL', () => [null, null], false],
] as const;

interface Case {
  n: number;
  /** One move per column, by index into MOVES. */
  moves: number[];
  changed: boolean;
  row: Record<string, string | null>;
}

/** Every combination of the five moves over the five columns: 5^5 rows. */
function truthTable(): Case[] {
  const cases: Case[] = [];
  for (let n = 0; n < MOVES.length ** COLUMNS.length; n += 1) {
    const moves = COLUMNS.map((_column, at) => Math.floor(n / MOVES.length ** at) % MOVES.length);
    const row: Record<string, string | null> = {};
    COLUMNS.forEach(([name, , a, b], at) => {
      const [before, after] = MOVES[moves[at]!]![1](a, b);
      row[`old_${name}`] = before ?? null;
      row[`new_${name}`] = after ?? null;
    });
    cases.push({ n, moves, changed: moves.some((move) => MOVES[move]![2]), row });
  }
  return cases;
}

describe('the ledger account identity trigger, rewritten as PostgreSQL prints it (real database)', () => {
  let owner: PrismaClient;

  beforeAll(() => {
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  });

  afterAll(async () => {
    await owner.$disconnect();
  });

  /** Runs `act` as the owner and undoes it: no definition tried here outlives its test. */
  const rolledBack = async <T>(act: (tx: Tx) => Promise<T>): Promise<T> => {
    const undone = new Error('rolled back');
    let result: T | undefined;
    await owner
      .$transaction(
        async (tx) => {
          // A definition tried on the real table waits for its lock briefly, never for long.
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '10s'`);
          result = await act(tx);
          throw undone;
        },
        { timeout: 60_000 },
      )
      .catch((error: unknown) => {
        if (error !== undone) throw error;
      });
    return result as T;
  };

  /** The trigger as PostgreSQL prints it: what a dump writes and a restore reads. */
  const printed = async (tx: Tx, table = 'ledger_account') => {
    const found = await tx.$queryRawUnsafe<{ definition: string; enabled: string }[]>(
      `SELECT pg_get_triggerdef(t.oid) AS definition, t.tgenabled::text AS enabled
         FROM pg_trigger t WHERE t.tgrelid = $1::regclass AND t.tgname = $2`,
      table,
      TRIGGER,
    );
    expect(found).toHaveLength(1);
    return found[0]!;
  };

  /** What a restore does with a printed trigger: reads it. Replaced in place, so never absent. */
  const restored = async (tx: Tx, definition: string) => {
    expect(definition.startsWith('CREATE TRIGGER ')).toBe(true);
    await tx.$executeRawUnsafe(definition.replace('CREATE TRIGGER ', 'CREATE OR REPLACE TRIGGER '));
    return (await printed(tx)).definition;
  };

  /**
   * Which rows of the truth table that definition fires on. The table is the five columns of
   * `ledger_account` with their own types but nullable (the real ones are NOT NULL), and the
   * trigger marks a row instead of refusing the statement, so one UPDATE answers for every row.
   */
  const firesOn = async (tx: Tx, name: string, definition: string, cases: Case[]) => {
    expect(definition).toContain(TABLE);
    expect(definition).toContain(REFUSES);
    const columns = COLUMNS.map(([column]) => column);
    await tx.$executeRawUnsafe(
      `CREATE TEMP TABLE "${name}" ON COMMIT DROP AS
         SELECT 0 AS n, false AS fired, false AS touched, ${columns.join(', ')}
           FROM ledger_account WITH NO DATA`,
    );
    await tx.$executeRawUnsafe(
      definition
        .replace(TABLE, `ON "${name}"`)
        .replace(REFUSES, 'EXECUTE FUNCTION pg_temp.fu308_fired()'),
    );
    const input = `jsonb_to_recordset($1::jsonb) AS c(n INT, ${COLUMNS.map(
      ([column, type]) => `old_${column} ${type}, new_${column} ${type}`,
    ).join(', ')})`;
    const rows = JSON.stringify(cases.map(({ n, row }) => ({ n, ...row })));
    await tx.$executeRawUnsafe(
      `INSERT INTO "${name}" (n, fired, touched, ${columns.join(', ')})
       SELECT c.n, false, false, ${columns.map((column) => `c.old_${column}`).join(', ')} FROM ${input}`,
      rows,
    );
    // `touched` changes in every row: a column that is not the account's identity never fires it.
    await tx.$executeRawUnsafe(
      `UPDATE "${name}" p SET touched = true, ${columns
        .map((column) => `${column} = c.new_${column}`)
        .join(', ')} FROM ${input} WHERE p.n = c.n`,
      rows,
    );
    const marked = await tx.$queryRawUnsafe<{ n: number; fired: boolean }[]>(
      `SELECT n, fired FROM "${name}" WHERE touched ORDER BY n`,
    );
    expect(marked).toHaveLength(cases.length);
    return marked.map(({ fired }) => fired);
  };

  it('fires on exactly the rows the old condition fired on, over every NULL and every column', async () => {
    const cases = truthTable();
    const [before, after, reversed] = await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe(
        `CREATE FUNCTION pg_temp.fu308_fired() RETURNS TRIGGER LANGUAGE plpgsql
           AS $$ BEGIN NEW.fired := true; RETURN NEW; END; $$`,
      );
      return [
        await firesOn(tx, 'fu308_before', statement(BEFORE, 'migration.sql'), cases),
        await firesOn(tx, 'fu308_after', statement(AFTER, 'migration.sql'), cases),
        await firesOn(tx, 'fu308_reversed', statement(AFTER, 'down.sql'), cases),
      ];
    });
    const describeCase = ({ moves }: Case) =>
      moves.map((move, at) => `${COLUMNS[at]![0]}: ${MOVES[move]![0]}`).join(', ');
    const differing = (left: boolean[], right: boolean[]) =>
      cases.filter(({ n }) => left[n] !== right[n]).map(describeCase);

    expect(cases).toHaveLength(3125);
    // Old against new, row by row; then both against what the rule says, stated a third way.
    expect(differing(before, after)).toEqual([]);
    expect(differing(before, reversed)).toEqual([]);
    expect(
      differing(
        after,
        cases.map(({ changed }) => changed),
      ),
    ).toEqual([]);
    // Not vacuous: only the 2^5 rows where no column changes are let through.
    expect(after.filter((fired) => !fired)).toHaveLength(32);
  });

  it('is the trigger the database carries, enabled, and a restore prints it as its source does', async () => {
    const carried = await printed(owner);
    expect(carried.enabled).toBe('O');
    const [written, again] = await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe(statement(AFTER, 'migration.sql'));
      const fresh = (await printed(tx)).definition;
      return [fresh, await restored(tx, fresh)];
    });
    expect(carried.definition).toBe(written);
    expect(again).toBe(written);
  });

  it('the old form was not: a restore printed it as the new one, character for character', async () => {
    const carried = (await printed(owner)).definition;
    const [before, after] = await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe(statement(AFTER, 'down.sql'));
      const old = (await printed(tx)).definition;
      return [old, await restored(tx, old)];
    });
    expect(after).not.toBe(before);
    expect(after).toBe(carried);
    // And the condition is all that moved: same table, event, timing, level and function.
    const outside = (definition: string) => {
      const [head, rest] = definition.split(' WHEN (');
      return [head, rest?.slice(rest.lastIndexOf(') EXECUTE FUNCTION '))];
    };
    expect(outside(before)).toEqual(outside(carried));
    expect(outside(carried)[1]).toBe(') EXECUTE FUNCTION reject_ledger_account_identity_change()');
  });

  it("down.sql gives back 20261104120000's trigger, byte for byte and enabled", async () => {
    const original = statement(BEFORE, 'migration.sql');
    // Both files wait for the table's lock for three seconds and then stop with nothing changed.
    for (const file of ['migration.sql', 'down.sql'] as const) {
      const sql = readFileSync(join(MIGRATIONS, AFTER, file), 'utf8');
      const [before] = sql.split(statement(AFTER, file));
      expect(before).toMatch(/^SET LOCAL lock_timeout = '3s';$/m);
    }
    expect(
      statement(AFTER, 'down.sql').replace('CREATE OR REPLACE TRIGGER', 'CREATE TRIGGER'),
    ).toBe(original);
    const [first, reversed] = await rolledBack(async (tx) => {
      // 20261104120000's own statement, replaced in place so the guard is never absent.
      await tx.$executeRawUnsafe(original.replace('CREATE TRIGGER', 'CREATE OR REPLACE TRIGGER'));
      const created = await printed(tx);
      // ISOLATION-ALLOW-UNBOUNDED: DDL cannot carry a WHERE; undone with this owner transaction.
      // Disabled first: the replacement comes back enabled.
      await tx.$executeRawUnsafe(`ALTER TABLE "ledger_account" DISABLE TRIGGER "${TRIGGER}"`);
      await tx.$executeRawUnsafe(statement(AFTER, 'migration.sql'));
      expect((await printed(tx)).enabled).toBe('O');
      // ISOLATION-ALLOW-UNBOUNDED: as above.
      await tx.$executeRawUnsafe(`ALTER TABLE "ledger_account" DISABLE TRIGGER "${TRIGGER}"`);
      await tx.$executeRawUnsafe(statement(AFTER, 'down.sql'));
      return [created, await printed(tx)];
    });
    expect(reversed).toEqual(first);
    expect(reversed.enabled).toBe('O');
  });
});
