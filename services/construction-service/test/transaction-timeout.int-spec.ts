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
 *
 * The refusal has two forms, and which one a run gets is a race inside Prisma's
 * query engine, not something the service decides (FU-034, train run
 * 41573587535). The engine rolls the transaction back at its timeout and only
 * afterwards records it as expired; a commit that lands between the two finds no
 * record and says `Transaction not found` instead of `Transaction already
 * closed … The timeout for this transaction was N ms`. Both are P2028, and the
 * wait below ends the instant PostgreSQL shows the rollback — exactly that
 * window — so a run can get either. Both are accepted, and only these two
 * ({@link endedByTimeout}). The second form names no timeout, so every refusal
 * is also held to the clock: it cannot come before the timeout the caller named.
 */
const CLOSED_AT = (ms: number): RegExp =>
  new RegExp(
    'Transaction already closed: A commit cannot be executed on an expired transaction\\. ' +
      `The timeout for this transaction was ${ms} ms`,
  );
const NOT_FOUND = /Transaction not found\. Transaction ID is invalid, refers to an old closed/;

/**
 * Whether `error`, raised `elapsedMs` after the transaction was requested, is
 * the client ending it at `ms` — and not the default, a pool timeout
 * (`Unable to start a transaction in the given time` is P2028 as well), a
 * rolled-back body or any other failure.
 *
 * - code `P2028`, and a message that is one of the two forms above;
 * - the first form must name `ms`; the second names nothing, so
 * - in both, `elapsedMs >= ms`: the engine ends a transaction only when its
 *   timeout runs out, so a refusal that came sooner was ended by a shorter one.
 */
const endedByTimeout = (error: unknown, elapsedMs: number, ms: number): boolean => {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (code !== 'P2028' || typeof message !== 'string') return false;
  return (CLOSED_AT(ms).test(message) || NOT_FOUND.test(message)) && elapsedMs >= ms;
};

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

  /** Runs `run`, which must be refused, and checks that the client ended it at `ms`. */
  const refusedAtTimeout = async (run: () => Promise<unknown>, ms: number): Promise<void> => {
    const started = performance.now();
    const refusal = await run().then(
      () => undefined,
      (error: unknown) => ({ error }),
    );
    const elapsedMs = performance.now() - started;
    if (refusal === undefined) throw new Error('the transaction committed; it had to be refused');
    // On a failure the report shows the error and the time, not just `false`.
    expect({
      ended: endedByTimeout(refusal.error, elapsedMs, ms),
      ms,
      elapsedMs,
      ...refusal,
    }).toEqual(expect.objectContaining({ ended: true }));
  };

  it('ends a transaction at the configured timeout, not at Prisma’s 5 000 ms', async () => {
    await refusedAtTimeout(() => prisma.transaction(untilRolledBack), BUDGET_MS);
  });

  it('holds a snapshot read to the same timeout', async () => {
    await refusedAtTimeout(() => prisma.snapshot(untilRolledBack), BUDGET_MS);
  });

  it('holds a transaction opened on the client directly to the same timeout', async () => {
    await refusedAtTimeout(() => prisma.client.$transaction(untilRolledBack), BUDGET_MS);
  });

  it('lets a caller that names its own timeout keep it (the idempotency wait does)', async () => {
    const own = BUDGET_MS * 2;
    await refusedAtTimeout(() => prisma.transaction(untilRolledBack, { timeoutMs: own }), own);
  });

  describe('what counts as the client ending a transaction at its timeout', () => {
    const closed = (ms: number): Error & { code: string } =>
      Object.assign(
        new Error(
          'Transaction API error: Transaction already closed: A commit cannot be executed on an ' +
            `expired transaction. The timeout for this transaction was ${ms} ms, however ` +
            `${ms + 4} ms passed since the start of the transaction.`,
        ),
        { code: 'P2028' },
      );
    const notFound = Object.assign(
      new Error(
        'Transaction API error: Transaction not found. Transaction ID is invalid, refers to an old ' +
          "closed transaction Prisma doesn't have information about anymore, or was obtained before " +
          'disconnecting.',
      ),
      { code: 'P2028' },
    );

    it('accepts both forms the engine gives at the timeout', () => {
      expect(endedByTimeout(closed(600), 640, 600)).toBe(true);
      expect(endedByTimeout(notFound, 640, 600)).toBe(true);
      expect(endedByTimeout(notFound, 600, 600)).toBe(true);
    });

    it('refuses the default timeout, whichever form it comes in', () => {
      expect(endedByTimeout(closed(BUDGET_MS), 640, 600)).toBe(false);
      // Not found names nothing: only the clock tells the default from the caller's own.
      expect(endedByTimeout(notFound, BUDGET_MS + 20, 600)).toBe(false);
    });

    it('refuses any other failure, P2028 included', () => {
      const pool = Object.assign(
        new Error('Transaction API error: Unable to start a transaction in the given time.'),
        {
          code: 'P2028',
        },
      );
      expect(endedByTimeout(pool, 700, 600)).toBe(false);
      expect(
        endedByTimeout(Object.assign(new Error(closed(600).message), { code: 'P2002' }), 700, 600),
      ).toBe(false);
      expect(endedByTimeout(new Error(closed(600).message), 700, 600)).toBe(false);
      expect(endedByTimeout(new Error('boom'), 700, 600)).toBe(false);
      expect(endedByTimeout(undefined, 700, 600)).toBe(false);
    });
  });

  /** Wires the service on `env` and commits one transaction on it. */
  const commitsOn = async (env: ReturnType<typeof testEnv>): Promise<number> => {
    const w = wire(env);
    try {
      await expect(
        w.prisma.transaction((tx) => tx.$queryRawUnsafe<{ one: number }[]>('SELECT 1 AS one')),
      ).resolves.toEqual([{ one: 1 }]);
      return w.prisma.transactionTimeoutMs;
    } finally {
      await w.close();
    }
  };

  // Whatever the run is configured with — the 15 s default (env.spec.ts) or an
  // exported value. Any value the service accepts is a valid run, 5 000 ms
  // included (Codex r1 on #271: this once demanded more than 5 000).
  it('runs the suites on the configured value, within the bounds the service accepts', async () => {
    const env = testEnv();
    expect(env.CONSTRUCTION_TRANSACTION_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(env.CONSTRUCTION_TRANSACTION_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
    expect(await commitsOn(env)).toBe(env.CONSTRUCTION_TRANSACTION_TIMEOUT_MS);
  });

  it('wires a value set explicitly — both bounds and one above the default — and commits on it', async () => {
    for (const ms of [5_000, 30_000, 60_000]) {
      const env = testEnv({ CONSTRUCTION_TRANSACTION_TIMEOUT_MS: String(ms) });
      expect(await commitsOn(env)).toBe(ms);
    }
  });
});
