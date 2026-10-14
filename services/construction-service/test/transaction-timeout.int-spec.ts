import { PrismaClient } from '../src/generated/prisma';
import { PrismaService } from '../src/prisma/prisma.service';
import { databaseUrl, testEnv, wire } from './helpers';

/**
 * Every interactive transaction this service runs is bounded by
 * `CONSTRUCTION_TRANSACTION_TIMEOUT_MS`, never by Prisma's own unwritten
 * default of 5 000 ms.
 *
 * main 2883320 (run 38531029337, attempt 1): `PolicyService.submit` — four
 * statements, ~20 ms on an idle machine — was stalled on a loaded CI runner and
 * expired at Prisma's 5 000 ms ("5936 ms passed"), failing a command that did
 * nothing wrong. The same stall in production is a 500.
 *
 * No sleep and no clock in the test. Each transaction body below runs no
 * statement: it waits until PostgreSQL shows no open transaction on the
 * connections under test — the client rolled it back when its timeout ran out —
 * and only then returns. The commit that follows is refused, and the refusal
 * names the timeout the client enforced. However long the machine stalls, the
 * outcome depends only on which timeout that is.
 */
describe('the interactive transaction timeout', () => {
  /** A deliberately short budget, so the client ends the transaction quickly. */
  const BUDGET_MS = 300;
  /** Names the connections under test in `pg_stat_activity`. */
  const APPLICATION = `construction-tx-timeout-${process.pid}`;
  let prisma: PrismaService;
  /** A connection outside every transaction under test, to watch them from (the same role). */
  let observer: PrismaClient;

  beforeAll(() => {
    const url = new URL(databaseUrl());
    url.searchParams.set('application_name', APPLICATION);
    prisma = new PrismaService(url.toString(), BUDGET_MS);
    observer = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
  });

  afterAll(async () => {
    await observer.$disconnect();
    await prisma.onModuleDestroy();
  });

  /** Returns once no connection under test is inside a transaction. */
  const untilRolledBack = async (): Promise<void> => {
    for (;;) {
      const [open] = await observer.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE application_name = $1 AND state LIKE 'idle in transaction%'`,
        APPLICATION,
      );
      if (open!.n === 0) return;
    }
  };

  const expiredAt = (ms: number): RegExp =>
    new RegExp(
      'Transaction already closed: A commit cannot be executed on an expired transaction\\. ' +
        `The timeout for this transaction was ${ms} ms`,
    );

  it('ends a transaction at the configured timeout, not at Prisma’s 5 000 ms', async () => {
    await expect(prisma.transaction(untilRolledBack)).rejects.toThrow(expiredAt(BUDGET_MS));
  });

  it('holds a snapshot read to the same timeout', async () => {
    await expect(prisma.snapshot(untilRolledBack)).rejects.toThrow(expiredAt(BUDGET_MS));
  });

  it('holds a transaction opened on the client directly to the same timeout', async () => {
    await expect(prisma.client.$transaction(untilRolledBack)).rejects.toThrow(expiredAt(BUDGET_MS));
  });

  it('lets a caller that names its own timeout keep it (the idempotency wait does)', async () => {
    const own = BUDGET_MS * 2;
    await expect(prisma.transaction(untilRolledBack, { timeoutMs: own })).rejects.toThrow(
      expiredAt(own),
    );
  });

  it('runs the suites on the configured value, above Prisma’s 5 000 ms, and commits on it', async () => {
    const env = testEnv();
    const w = wire(env);
    try {
      expect(w.prisma.transactionTimeoutMs).toBe(env.CONSTRUCTION_TRANSACTION_TIMEOUT_MS);
      expect(env.CONSTRUCTION_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(5_000);
      await expect(
        w.prisma.transaction((tx) => tx.$queryRawUnsafe<{ one: number }[]>('SELECT 1 AS one')),
      ).resolves.toEqual([{ one: 1 }]);
    } finally {
      await w.close();
    }
  });
});
