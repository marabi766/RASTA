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
 * window — so a run can get either. Both are accepted, and only these two.
 *
 * The second form names no timeout, so the refusal alone cannot say which one
 * applied (FU-041, Codex r1 on #630): a 300 ms default plus a 340 ms delay in
 * acquiring the transaction refuses after 640 ms, which passed for an expected
 * 600; Prisma's own 5 000 ms passes for an expected 300 or 600. Elapsed time is a
 * lower bound, never an identity. So the timeout is read where it is decided,
 * at the Prisma boundary: {@link watchStarts} wraps the engine call that starts
 * a transaction and records the `timeout` it is handed — the value the engine
 * enforces. {@link endedByTimeout} demands that it is exactly the expected one,
 * and the refusal is then only what is left to prove: the rollback happened and
 * the commit was refused in one of the two forms. The wrapper adds nothing to
 * the transaction but, in the negative cases, a delay before the start.
 */
const CLOSED_AT = (ms: number): RegExp =>
  new RegExp(
    'Transaction already closed: A commit cannot be executed on an expired transaction\\. ' +
      `The timeout for this transaction was ${ms} ms`,
  );
const NOT_FOUND = /Transaction not found\. Transaction ID is invalid, refers to an old closed/;

/** What one transaction run on a {@link PrismaService} showed. */
interface Observation {
  /** Whether the run committed (it must not). */
  readonly committed: boolean;
  /** The refusal; `undefined` when the run committed. */
  readonly error: unknown;
  /** From the request to the refusal. */
  readonly elapsedMs: number;
  /** The `timeout` of every transaction start Prisma's engine was handed, in order. */
  readonly startedTimeouts: readonly unknown[];
}

/**
 * Whether `observation` is the client ending the transaction at `ms` — and not
 * the default, a longer or shorter timeout, a pool timeout (`Unable to start a
 * transaction in the given time` is P2028 as well), a rolled-back body or any
 * other failure.
 *
 * - exactly one transaction was started, with exactly `ms` as its timeout — the
 *   identity, read at the Prisma boundary;
 * - code `P2028`, and a message that is one of the two forms above, the first
 *   naming `ms`;
 * - `elapsedMs >= ms`: the engine ends a transaction only when its timeout runs
 *   out, so a refusal that came sooner was not the commit meeting that timeout.
 */
const endedByTimeout = (observation: Observation, ms: number): boolean => {
  const { committed, error, elapsedMs, startedTimeouts } = observation;
  if (committed || startedTimeouts.length !== 1 || startedTimeouts[0] !== ms) return false;
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (code !== 'P2028' || typeof message !== 'string') return false;
  return (CLOSED_AT(ms).test(message) || NOT_FOUND.test(message)) && elapsedMs >= ms;
};

/** The one engine call this spec wraps: Prisma 6's `transaction(action, headers, options)`. */
interface TransactionEngine {
  transaction: (action: string, headers: unknown, options: unknown) => Promise<unknown>;
}

/**
 * Runs `run` on `service` and reports what happened, recording the `timeout` of
 * every transaction start the engine was handed (and, when `delayStartMs` is
 * set, holding each start back that long — the acquisition delay of a loaded
 * machine). The engine is restored afterwards.
 *
 * Fails, rather than records nothing, when Prisma no longer has the engine
 * where this reads it: an unreadable timeout must not look like a pass.
 */
const watchStarts = async (
  service: PrismaService,
  run: () => Promise<unknown>,
  delayStartMs = 0,
): Promise<Observation> => {
  const base = (service as unknown as { base?: { _engine?: Partial<TransactionEngine> } }).base;
  const engine = base?._engine;
  if (engine === undefined || typeof engine.transaction !== 'function') {
    throw new Error('Prisma no longer exposes _engine.transaction; the timeout cannot be read');
  }
  const original = engine.transaction;
  const startedTimeouts: unknown[] = [];
  engine.transaction = async function (this: unknown, action, headers, options) {
    if (action === 'start') {
      startedTimeouts.push((options as { timeout?: unknown } | undefined)?.timeout);
      if (delayStartMs > 0) await new Promise((resolve) => setTimeout(resolve, delayStartMs));
    }
    return original.call(this, action, headers, options);
  };
  const started = performance.now();
  try {
    const outcome = await run().then(
      () => ({ committed: true, error: undefined }),
      (error: unknown) => ({ committed: false, error }),
    );
    return { ...outcome, elapsedMs: performance.now() - started, startedTimeouts };
  } finally {
    engine.transaction = original;
  }
};

describe('the interactive transaction timeout', () => {
  /** A deliberately short budget, so the client ends the transaction quickly. */
  const BUDGET_MS = 300;
  /** Names the connections under test in `pg_stat_activity`. */
  const APPLICATION = `construction-tx-timeout-${process.pid}`;
  let prisma: PrismaService;
  /** A connection outside every transaction under test, to watch them from (the same role). */
  let observer: PrismaClient;

  /** A service on the connections `untilRolledBack` watches, with its own client-wide timeout. */
  const serviceWith = (timeoutMs: number): PrismaService => {
    const url = new URL(databaseUrl());
    url.searchParams.set('application_name', APPLICATION);
    return new PrismaService(url.toString(), timeoutMs);
  };

  beforeAll(() => {
    prisma = serviceWith(BUDGET_MS);
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

  /** Runs `run` on `service`, which must be refused, and checks that the client ended it at `ms`. */
  const refusedAtTimeout = async (
    run: () => Promise<unknown>,
    ms: number,
    service: PrismaService = prisma,
  ): Promise<void> => {
    const observation = await watchStarts(service, run);
    // On a failure the report shows the error, the clock and the started timeouts, not just `false`.
    expect({ ended: endedByTimeout(observation, ms), ms, ...observation }).toEqual(
      expect.objectContaining({ ended: true }),
    );
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

  /**
   * The same four callers, with no wait and no clock: the timeout Prisma's engine is handed is the
   * whole claim, and it is read directly. A transaction that commits is enough to read it.
   */
  describe('the timeout the engine is handed to start a transaction', () => {
    const startedBy = async (
      run: (service: PrismaService) => Promise<unknown>,
      service: PrismaService = prisma,
    ): Promise<readonly unknown[]> => {
      const observation = await watchStarts(service, () => run(service));
      expect(observation.committed).toBe(true);
      return observation.startedTimeouts;
    };
    const one = (tx: { $queryRawUnsafe: (sql: string) => Promise<unknown> }): Promise<unknown> =>
      tx.$queryRawUnsafe('SELECT 1 AS one');

    it('is the constructor’s for transaction, snapshot and the client’s own $transaction', async () => {
      expect(await startedBy((s) => s.transaction(one))).toEqual([BUDGET_MS]);
      expect(await startedBy((s) => s.snapshot(one))).toEqual([BUDGET_MS]);
      expect(await startedBy((s) => s.client.$transaction(one))).toEqual([BUDGET_MS]);
    });

    it('is the caller’s own where one is named, and only for that call', async () => {
      const own = BUDGET_MS * 2;
      expect(await startedBy((s) => s.transaction(one, { timeoutMs: own }))).toEqual([own]);
      expect(await startedBy((s) => s.transaction(one))).toEqual([BUDGET_MS]);
    });

    it('follows the constructor argument — a longer one is handed on as it is', async () => {
      const longer = serviceWith(BUDGET_MS * 4);
      try {
        expect(await startedBy((s) => s.transaction(one), longer)).toEqual([BUDGET_MS * 4]);
        expect(await startedBy((s) => s.snapshot(one), longer)).toEqual([BUDGET_MS * 4]);
      } finally {
        await longer.onModuleDestroy();
      }
    });

    it('cannot be read from a client without the engine hook: that fails instead of passing', async () => {
      const unreadable = { base: {} } as unknown as PrismaService;
      await expect(watchStarts(unreadable, () => Promise.resolve())).rejects.toThrow(
        /no longer exposes _engine\.transaction/,
      );
    });
  });

  /**
   * What the old check let through, on a real engine. Neither refusal can be told from a correct
   * one by its message or its clock — a late or long refusal is still P2028 and still after the
   * expected time — and each is refused here only because of the timeout the engine was handed.
   */
  describe('a transaction that ends at another timeout than the one expected is not accepted', () => {
    it('refuses a shorter timeout held back by a slow start (300 ms + 340 ms ≥ an expected 600)', async () => {
      const own = BUDGET_MS * 2;
      const observation = await watchStarts(prisma, () => prisma.transaction(untilRolledBack), 340);
      expect(observation.startedTimeouts).toEqual([BUDGET_MS]);
      // The refusal is a genuine one, and late enough for the clock bound — the old check's whole test.
      expect(observation.elapsedMs).toBeGreaterThanOrEqual(own);
      expect(endedByTimeout(observation, own)).toBe(false);
      expect(endedByTimeout(observation, BUDGET_MS)).toBe(true);
    });

    it('refuses a longer timeout (a service left on more than the caller asked for)', async () => {
      const longer = serviceWith(BUDGET_MS * 4);
      try {
        const observation = await watchStarts(longer, () => longer.transaction(untilRolledBack));
        expect(observation.startedTimeouts).toEqual([BUDGET_MS * 4]);
        expect(observation.elapsedMs).toBeGreaterThanOrEqual(BUDGET_MS);
        expect(endedByTimeout(observation, BUDGET_MS)).toBe(false);
        expect(endedByTimeout(observation, BUDGET_MS * 4)).toBe(true);
      } finally {
        await longer.onModuleDestroy();
      }
    });
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
    /** A refusal `elapsedMs` after a request whose transaction the engine was started with `started`. */
    const seen = (error: unknown, elapsedMs: number, ...started: unknown[]): Observation => ({
      committed: false,
      error,
      elapsedMs,
      startedTimeouts: started,
    });

    it('accepts both forms the engine gives at the timeout', () => {
      expect(endedByTimeout(seen(closed(600), 640, 600), 600)).toBe(true);
      expect(endedByTimeout(seen(notFound, 640, 600), 600)).toBe(true);
      expect(endedByTimeout(seen(notFound, 600, 600), 600)).toBe(true);
    });

    // The two executed counterexamples of FU-041, which the old predicate (code, form, elapsed >= ms)
    // accepted: "not found" names no timeout and the clock cannot supply one.
    it('refuses a shorter timeout whose refusal was delayed past the expected one', () => {
      // 300 ms default + 340 ms to acquire the transaction = 640 ms, expected 600.
      expect(endedByTimeout(seen(notFound, 640, 300), 600)).toBe(false);
      expect(endedByTimeout(seen(closed(300), 640, 300), 600)).toBe(false);
    });

    it('refuses a longer timeout, Prisma’s own 5 000 ms included', () => {
      expect(endedByTimeout(seen(notFound, 5_040, 5_000), 300)).toBe(false);
      expect(endedByTimeout(seen(notFound, 5_040, 5_000), 600)).toBe(false);
      expect(endedByTimeout(seen(closed(5_000), 5_040, 5_000), 600)).toBe(false);
    });

    it('refuses a refusal that does not match the timeout the engine was handed', () => {
      // The message names 600, the engine was started with 300: one of the two is not what ran.
      expect(endedByTimeout(seen(closed(600), 640, 300), 600)).toBe(false);
      expect(endedByTimeout(seen(closed(300), 640, 600), 600)).toBe(false);
    });

    it('refuses a run whose start was not seen once, or not with a number', () => {
      expect(endedByTimeout(seen(notFound, 640), 600)).toBe(false);
      expect(endedByTimeout(seen(notFound, 640, 600, 600), 600)).toBe(false);
      expect(endedByTimeout(seen(notFound, 640, undefined), 600)).toBe(false);
      expect(endedByTimeout(seen(notFound, 640, '600'), 600)).toBe(false);
    });

    it('refuses the default timeout, whichever form it comes in', () => {
      expect(endedByTimeout(seen(closed(BUDGET_MS), 640, BUDGET_MS), 600)).toBe(false);
      // Not found names nothing: only the timeout the engine was handed tells the default from the caller's own.
      expect(endedByTimeout(seen(notFound, BUDGET_MS + 20, BUDGET_MS), 600)).toBe(false);
    });

    it('refuses a commit that was not refused', () => {
      expect(endedByTimeout({ ...seen(undefined, 700, 600), committed: true }, 600)).toBe(false);
    });

    it('refuses any other failure, P2028 included', () => {
      const pool = Object.assign(
        new Error('Transaction API error: Unable to start a transaction in the given time.'),
        {
          code: 'P2028',
        },
      );
      expect(endedByTimeout(seen(pool, 700, 600), 600)).toBe(false);
      expect(
        endedByTimeout(
          seen(Object.assign(new Error(closed(600).message), { code: 'P2002' }), 700, 600),
          600,
        ),
      ).toBe(false);
      expect(endedByTimeout(seen(new Error(closed(600).message), 700, 600), 600)).toBe(false);
      expect(endedByTimeout(seen(new Error('boom'), 700, 600), 600)).toBe(false);
      expect(endedByTimeout(seen(undefined, 700, 600), 600)).toBe(false);
    });
  });

  /**
   * Wires the service on `env`, commits one transaction on it and returns the timeout the service
   * reports and the one Prisma's engine was handed — which must be the same.
   */
  const commitsOn = async (env: ReturnType<typeof testEnv>): Promise<[unknown, unknown]> => {
    const w = wire(env);
    try {
      const observation = await watchStarts(w.prisma, () =>
        w.prisma.transaction(async (tx) => {
          expect(await tx.$queryRawUnsafe<{ one: number }[]>('SELECT 1 AS one')).toEqual([
            { one: 1 },
          ]);
        }),
      );
      expect(observation.committed).toBe(true);
      expect(observation.startedTimeouts).toHaveLength(1);
      return [w.prisma.transactionTimeoutMs, observation.startedTimeouts[0]];
    } finally {
      await w.close();
    }
  };

  // Whatever the run is configured with — the 15 s default (env.spec.ts) or an
  // exported value. Any value the service accepts is a valid run, 5 000 ms
  // included (Codex r1 on #271: this once demanded more than 5 000).
  it('runs the suites on the configured value, within the bounds the service accepts', async () => {
    const env = testEnv();
    const configured = env.CONSTRUCTION_TRANSACTION_TIMEOUT_MS;
    expect(configured).toBeGreaterThanOrEqual(5_000);
    expect(configured).toBeLessThanOrEqual(60_000);
    expect(await commitsOn(env)).toEqual([configured, configured]);
  });

  it('wires a value set explicitly — both bounds and one above the default — and commits on it', async () => {
    for (const ms of [5_000, 30_000, 60_000]) {
      const env = testEnv({
        CONSTRUCTION_TRANSACTION_TIMEOUT_MS: String(ms),
        // FU-320: longer transaction bounds require feasible sweeper leases too.
        CONSTRUCTION_RECONCILE_LEASE_SECONDS: '300',
        CONSTRUCTION_TENDER_CLOSE_LEASE_SECONDS: '300',
        CONSTRUCTION_AWARD_CHECK_LEASE_SECONDS: '300',
      });
      expect(await commitsOn(env)).toEqual([ms, ms]);
    }
  });
});
