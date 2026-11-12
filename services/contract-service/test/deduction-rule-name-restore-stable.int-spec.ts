import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '../src/generated/prisma';
import { isCanonicalDeductionRuleName } from '../src/deduction/deduction-rule-name';
import { ownerDatabaseUrl } from './helpers';

/**
 * `deduction_rule_name_is_canonical` in the form PostgreSQL prints back (FU-308 B, migration
 * 20261109200000_deduction_rule_name_canonical_restore_stable): the rewritten body answers exactly
 * as 20261104100000's did, a restore prints it as its source does, and the down script gives
 * 20261104100000's back.
 *
 * Every definition under test is read from its migration file, never copied here.
 */
jest.setTimeout(240_000);

type Tx = Prisma.TransactionClient;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const BEFORE = '20261104100000_deduction_rule_changes';
const AFTER = '20261109200000_deduction_rule_name_canonical_restore_stable';
const NAME = '"deduction_rule_name_is_canonical"';

/** The one statement of that file which defines the function, as the file wrote it. */
function statement(migration: string, file: 'migration.sql' | 'down.sql'): string {
  const sql = readFileSync(join(MIGRATIONS, migration, file), 'utf8');
  const found = sql.match(new RegExp(`^CREATE (?:OR REPLACE )?FUNCTION ${NAME}[^;]*;`, 'gm'));
  if (found?.length !== 1) {
    throw new Error(`${migration}/${file}: expected one definition of the function`);
  }
  return found[0];
}

/**
 * Names around both bounds and on each side of every pattern: each piece alone, and padded on
 * either side to one under, at, and one and two over the limit, in one-byte and two-byte letters.
 */
function candidates(): string[] {
  const pieces = [
    ...['a', 'ب', 'a b', 'ب‌ب', 'هٔ', '«٪»'],
    // A character outside the form; a blank, the mark and a half-space out of place.
    ...['é', 'ي', '\t', 'ـ', '😀'],
    ...[' a', 'a ', 'a  b', '‌ب', 'ب‌', 'ب‌‌ب', 'ب ‌ب'],
    ...['ٔ', 'aٔ', 'هٔٔ'],
    ...['a‌b', 'ب‌1', '1‌ب'],
  ];
  const all = new Set<string>(['']);
  for (const pad of ['x', 'ب']) {
    for (const length of [1, 2, 3, 198, 199, 200, 201, 202, 203]) all.add(pad.repeat(length));
    for (const piece of pieces) {
      all.add(piece);
      for (const length of [199, 200, 201, 202]) {
        const padding = pad.repeat(length - [...piece].length);
        all.add(padding + piece);
        all.add(piece + padding);
      }
    }
  }
  return [...all];
}

describe('the canonical rule name function, rewritten as PostgreSQL prints it (real database)', () => {
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
          result = await act(tx);
          throw undone;
        },
        { timeout: 200_000 },
      )
      .catch((error: unknown) => {
        if (error !== undone) throw error;
      });
    return result as T;
  };

  /** The function as PostgreSQL prints it, body included: what a dump writes and a restore reads. */
  const printed = async (tx: Tx) => {
    const found = await tx.$queryRawUnsafe<{ definition: string }[]>(
      `SELECT pg_get_functiondef('deduction_rule_name_is_canonical(text)'::regprocedure) AS definition`,
    );
    return found[0]!.definition;
  };

  /** What a restore does with a printed function: reads it. */
  const restored = async (tx: Tx, definition: string) => {
    await tx.$executeRawUnsafe(definition);
    return printed(tx);
  };

  /** That definition under a name of this session's own, beside the real one. */
  const beside = async (tx: Tx, name: string, definition: string) => {
    expect(definition).toContain(`FUNCTION ${NAME}(`);
    await tx.$executeRawUnsafe(
      definition
        .replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION')
        .replace(`FUNCTION ${NAME}(`, `FUNCTION pg_temp."${name}"(`),
    );
  };

  const three = (tx: Tx) =>
    Promise.all([
      beside(tx, 'fu308_before', statement(BEFORE, 'migration.sql')),
      beside(tx, 'fu308_after', statement(AFTER, 'migration.sql')),
      beside(tx, 'fu308_reversed', statement(AFTER, 'down.sql')),
    ]);

  it('answers as the old body did around both bounds, for NULL, and on each side of every pattern', async () => {
    const names = candidates();
    const answers = await rolledBack(async (tx) => {
      await three(tx);
      return tx.$queryRawUnsafe<
        { n: bigint; before: boolean | null; after: boolean | null; reversed: boolean | null }[]
      >(
        `SELECT c.n, pg_temp.fu308_before(c.name) AS before, pg_temp.fu308_after(c.name) AS after,
                pg_temp.fu308_reversed(c.name) AS reversed
           FROM (SELECT n, name FROM jsonb_array_elements_text($1::jsonb) WITH ORDINALITY AS e(name, n)
                 UNION ALL SELECT 0, NULL) c
          ORDER BY c.n`,
        JSON.stringify(names),
      );
    });
    expect(answers).toHaveLength(names.length + 1);
    // NULL in, NULL out, from all three: never false, never true.
    expect(answers[0]).toEqual({ n: 0n, before: null, after: null, reversed: null });
    const answered = (which: 'before' | 'after' | 'reversed') =>
      names.filter((_name, at) => answers[at + 1]![which] === true);
    const refused = (which: 'before' | 'after' | 'reversed') =>
      names.filter((_name, at) => answers[at + 1]![which] === false);
    // Old against new, name by name; then against the application, which states it a third way.
    expect(answered('after')).toEqual(answered('before'));
    expect(refused('after')).toEqual(refused('before'));
    expect(answered('reversed')).toEqual(answered('before'));
    expect(refused('reversed')).toEqual(refused('before'));
    expect(answered('after')).toEqual(names.filter(isCanonicalDeductionRuleName));
    // Not vacuous: both sides of each bound are in the table and answered differently.
    const accepted = new Set(answered('after'));
    expect([
      accepted.has(''),
      accepted.has('x'),
      accepted.has('x'.repeat(200)),
      accepted.has('x'.repeat(201)),
      accepted.has('ب'.repeat(200)),
      accepted.has('ب'.repeat(201)),
    ]).toEqual([false, true, true, false, true, false]);
    expect(accepted.size).toBeGreaterThan(40);
    expect(names.length - accepted.size).toBeGreaterThan(100);
  });

  it('answers as the old body did for every code point, alone and inside a name', async () => {
    const [differing] = await rolledBack(async (tx) => {
      await three(tx);
      return tx.$queryRawUnsafe<{ count: bigint; seen: bigint }[]>(
        `SELECT count(*) FILTER (
                  WHERE pg_temp.fu308_before(name) IS DISTINCT FROM pg_temp.fu308_after(name)
                     OR pg_temp.fu308_before(name) IS DISTINCT FROM pg_temp.fu308_reversed(name)
                ) AS count, count(*) AS seen
           FROM generate_series(1, 1114111) cp,
                (VALUES ('', ''), ('T', 'x'), ('ب', 'ب'), ('ه', 'ب')) AS around(head, tail),
                LATERAL (SELECT around.head || chr(cp) || around.tail) AS candidate(name)
          WHERE cp NOT BETWEEN 55296 AND 57343`,
      );
    });
    expect(differing).toEqual({ count: 0n, seen: BigInt(4 * (0x10ffff - 2048)) });
  });

  it('is the function the database carries, still granted, and a restore prints it as its source does', async () => {
    const carried = await printed(owner);
    const [granted] = await owner.$queryRawUnsafe<{ granted: boolean }[]>(
      `SELECT has_function_privilege('rasta_contract',
                'deduction_rule_name_is_canonical(text)'::regprocedure, 'EXECUTE') AS granted`,
    );
    expect(granted).toEqual({ granted: true });
    const [written, again] = await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe(statement(AFTER, 'migration.sql'));
      const fresh = await printed(tx);
      return [fresh, await restored(tx, fresh)];
    });
    expect(carried).toBe(written);
    expect(again).toBe(written);
  });

  it('the old form was not: a restore printed it as the new one, character for character', async () => {
    const carried = await printed(owner);
    const [before, after] = await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe(statement(AFTER, 'down.sql'));
      const old = await printed(tx);
      return [old, await restored(tx, old)];
    });
    expect(after).not.toBe(before);
    expect(after).toBe(carried);
  });

  it("down.sql gives back 20261104100000's function: PostgreSQL prints the two alike", async () => {
    // Not byte for byte: the rollback path refuses a backslash outside an E'…' string, so the down
    // spells each pattern E'\u…' where 20261104100000 wrote U&'\…'. What is stored is the same.
    const original = statement(BEFORE, 'migration.sql');
    const reverse = statement(AFTER, 'down.sql');
    expect(reverse).not.toContain('U&');
    expect(reverse.split(' RETURN ')[0]).toBe(
      original.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION').split(' RETURN ')[0],
    );
    const [first, reversed] = await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe(original.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
      const created = await printed(tx);
      await tx.$executeRawUnsafe(statement(AFTER, 'migration.sql'));
      await tx.$executeRawUnsafe(reverse);
      return [created, await printed(tx)];
    });
    expect(reversed).toBe(first);
  });
});
