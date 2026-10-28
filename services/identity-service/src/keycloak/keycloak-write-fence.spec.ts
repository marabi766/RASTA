import { MembershipExpiryScanner } from '../identity/membership-expiry.scanner';
import type { IdentityRepository } from '../identity/identity.repository';
import type { IdentityService } from '../identity/identity.service';
import { Logger } from '@nestjs/common';
import { COMMIT_RESERVE_MS } from '../prisma/cancellation';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { gate, modelledPool } from '../../test/modelled-engine';
import { KeycloakProjectionConsumer } from './keycloak-projection.consumer';
import type { KeycloakProjector } from './keycloak.projector';
import { KeycloakWriteFences, type KeycloakWriteAttempt } from './keycloak-write-fence';

/**
 * #458 r1 F1 and F2, on the fences' in-memory obligations and a stop's flush,
 * with interleavings a real database cannot be made to produce on demand.
 *
 * The pool is the **real** `PrismaService` — its `transaction` and its
 * `stop` — over the model of Prisma's engine in `test/modelled-engine.ts`;
 * every step is logged, so a test can say exactly what reached the
 * "database" and when.
 */

/** A business transaction that holds the user lock with all its budget left. */
const lockHolder = {
  $queryRaw: async () => [{ elapsed_ms: 0 }],
} as unknown as ExtendedPrismaClient;

async function setup() {
  let now = 0;
  const model = modelledPool();
  const fences = new KeycloakWriteFences(model.pool, { monotonicNow: () => now });
  const sent = async (): Promise<KeycloakWriteAttempt> => {
    const attempt = await fences.open(lockHolder, {
      userId: 'USR_F1',
      keycloakId: 'kc-f1',
      operation: 'replace_attributes',
      timeoutMs: 10,
      settleSeconds: 1,
      transactionTimeoutMs: 1_000,
    });
    attempt.assertDispatchable();
    return attempt;
  };
  return {
    ...model,
    fences,
    sent,
    at(ms: number) {
      now = ms;
    },
  };
}

describe('#458 r1 F1: an obligation is cleared only by a write of its own generation', () => {
  it('the reviewer’s interleaving: an old flush’s late completion never erases a newer, unwritten obligation', async () => {
    const t = await setup();
    const attempt = await t.sent();
    t.at(11);

    // 1. A flush writes obligation A (still unanswered past its deadline);
    //    its COMMIT's answer is held back.
    const commitA = gate();
    t.steps.push({ commit: commitA.opened });
    const oldFlush = t.fences.recoverOwed();
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.fences.owedCount).toBe(1);

    // 2. That fresh fence is taken over and repaired elsewhere; then the
    //    sender hears back, late: a new obligation B for the same attempt.
    t.at(3_000);
    expect(attempt.observeReply()).toBe(true);
    expect(t.fences.owedCount).toBe(1);

    // 3. B's own write fails (a cancelled scope, a failed database).
    t.steps.push({ fail: true });
    expect(await t.fences.recoverLate(attempt, false)).toBe(false);
    expect(t.fences.owedCount).toBe(1);

    // 4. A's write completes now — and leaves B owed.
    commitA.open();
    expect(await oldFlush).toBe(1);
    expect(t.fences.owedCount).toBe(1);

    // 5. Never without a fence or an obligation: the next flush writes B.
    t.log.length = 0;
    expect(await t.fences.recoverOwed()).toBe(0);
    expect(t.log.filter((step) => step === 'INSERT')).toHaveLength(1);
  });

  it('what the sender heard makes a newer obligation than the one a flush is still writing', async () => {
    const t = await setup();
    const attempt = await t.sent();
    t.at(11);
    expect(attempt.observeReply()).toBe(true);

    // A flush writes the unknown obligation; its COMMIT's answer is held.
    const commit = gate();
    t.steps.push({ commit: commit.opened });
    const flush = t.fences.recoverOwed();
    await new Promise((resolve) => setImmediate(resolve));

    // The sender says it landed; that write fails.
    t.steps.push({ fail: true });
    expect(await t.fences.recoverLate(attempt, true)).toBe(false);

    // The flush's completion clears only what it wrote.
    commit.open();
    expect(await flush).toBe(1);
    expect(t.fences.owedCount).toBe(1);
  });

  it('a completed write of the current generation clears it', async () => {
    const t = await setup();
    const attempt = await t.sent();
    t.at(11);
    expect(attempt.observeReply()).toBe(true);
    expect(await t.fences.recoverLate(attempt, true)).toBe(true);
    expect(t.fences.owedCount).toBe(0);
  });
});

describe('#458 r1 F1/F5: a timeout is not lateness — the observation decides', () => {
  it('observed before the deadline (the abort timer fired a fraction early): not late, nothing owed', async () => {
    const t = await setup();
    const attempt = await t.sent();
    t.at(9.5);
    expect(attempt.observeReply()).toBe(false);
    // The verdict is the first observation's, whatever the clock says later.
    t.at(50);
    expect(attempt.observeReply()).toBe(false);
    expect(t.fences.owedCount).toBe(0);
  });

  it('observed at or after the deadline: late, and owed', async () => {
    const t = await setup();
    const attempt = await t.sent();
    t.at(10);
    expect(attempt.observeReply()).toBe(true);
    expect(t.fences.owedCount).toBe(1);
  });
});

describe('#458 r1 F2: a stop’s flush begins, inserts and commits nothing after the stop returned', () => {
  async function twoOwed() {
    const t = await setup();
    const attempts = [await t.sent(), await t.sent()];
    t.at(20);
    for (const attempt of attempts) expect(attempt.observeReply()).toBe(true);
    t.log.length = 0;
    return t;
  }

  const stops: Array<
    [string, (t: Awaited<ReturnType<typeof twoOwed>>, deadlineAt: number) => Promise<void>]
  > = [
    [
      'the expiry scanner',
      (t, deadlineAt) =>
        new MembershipExpiryScanner(
          {} as IdentityRepository,
          {} as IdentityService,
          { enabled: false, intervalSeconds: 60, batchSize: 50 },
          {} as KeycloakProjector,
          t.fences,
        ).stop({ deadlineAt }),
    ],
    [
      'the projection consumer',
      async (t, deadlineAt) => {
        const consumer = new KeycloakProjectionConsumer(
          () => ({ start: async () => undefined, stop: async () => undefined }) as never,
          { recoverOwed: () => t.fences.recoverOwed() } as unknown as KeycloakProjector,
        );
        await consumer.onModuleInit();
        await consumer.stop({ deadlineAt });
      },
    ],
  ];

  it.each(stops)(
    '%s: the reviewer’s probe — the first transaction waits past the deadline for its connection',
    async (_name, stop) => {
      const t = await twoOwed();
      const connection = gate();
      t.steps.push({ connection: connection.opened });

      await stop(t, Date.now() + 50);
      t.log.push('STOP RETURNED');
      connection.open();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const after = t.log.slice(t.log.indexOf('STOP RETURNED') + 1);
      expect(after.filter((step) => /^(BEGIN|SET|INSERT|COMMIT)/.test(step))).toEqual([]);
      // Nothing written, nothing forgotten: both are still owed in the process.
      expect(t.fences.owedCount).toBe(2);
    },
  );

  it.each(stops)(
    '%s: a callback held past its budget is rolled back by the engine’s own timeout before the stop returns',
    async (_name, stop) => {
      const t = await twoOwed();
      // Its statement's answer is held for good: only the engine's timeout —
      // inside the one budget — ends the transaction.
      const held = gate();
      const original = t.pool.transaction.bind(t.pool);
      jest.spyOn(t.pool, 'transaction').mockImplementationOnce((fn, options) =>
        original(async (tx) => {
          const result = await fn(tx);
          await held.opened;
          return result;
        }, options),
      );

      await stop(t, Date.now() + COMMIT_RESERVE_MS + 100);
      t.log.push('STOP RETURNED');
      held.open();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // (Transactions 1 and 2 opened the two fences.) The flush's first is
      // rolled back by its own timeout, within the window; the second is
      // written in what is left; nothing at all after the stop returned.
      expect(t.log).toEqual([
        'BEGIN 3',
        'SET',
        'INSERT',
        'ROLLBACK 3',
        'BEGIN 4',
        'SET',
        'INSERT',
        'COMMIT 4',
        'STOP RETURNED',
      ]);
      expect(t.fences.owedCount).toBe(1);
    },
  );

  it('within its deadline, the stop writes them all', async () => {
    const t = await twoOwed();
    await new MembershipExpiryScanner(
      {} as IdentityRepository,
      {} as IdentityService,
      { enabled: false, intervalSeconds: 60, batchSize: 50 },
      {} as KeycloakProjector,
      t.fences,
    ).stop({ deadlineAt: Date.now() + 5_000 });
    expect(t.log.filter((step) => step.startsWith('COMMIT'))).toHaveLength(2);
    expect(t.log.filter((step) => step === 'INSERT')).toHaveLength(2);
    expect(t.fences.owedCount).toBe(0);
  });
});

describe('#458 r2 F2: one budget, and a COMMIT handed to the engine is waited for before the stop returns', () => {
  async function twoOwed() {
    const t = await setup();
    const attempts = [await t.sent(), await t.sent()];
    t.at(20);
    for (const attempt of attempts) expect(attempt.observeReply()).toBe(true);
    t.log.length = 0;
    t.bounds.length = 0;
    return t;
  }

  const stops: Array<
    [string, (t: Awaited<ReturnType<typeof twoOwed>>, deadlineAt: number) => Promise<void>]
  > = [
    [
      'the expiry scanner',
      (t, deadlineAt) =>
        new MembershipExpiryScanner(
          {} as IdentityRepository,
          {} as IdentityService,
          { enabled: false, intervalSeconds: 60, batchSize: 50 },
          {} as KeycloakProjector,
          t.fences,
        ).stop({ deadlineAt }),
    ],
    [
      'the projection consumer',
      async (t, deadlineAt) => {
        const consumer = new KeycloakProjectionConsumer(
          () => ({ start: async () => undefined, stop: async () => undefined }) as never,
          { recoverOwed: () => t.fences.recoverOwed() } as unknown as KeycloakProjector,
        );
        await consumer.onModuleInit();
        await consumer.stop({ deadlineAt });
      },
    ],
  ];

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(stops)(
    '%s: the reviewer’s engine-model probe — a COMMIT sent before the deadline is waited for; the stop returns after it',
    async (_name, stop) => {
      const t = await twoOwed();
      const startedAt = Date.now();
      // The first COMMIT is sent at once; its answer comes back after the
      // flush's own window closed, before the stop's deadline.
      const answer = gate();
      t.steps.push({ commit: answer.opened });
      setTimeout(answer.open, 100 + 150);

      await stop(t, startedAt + COMMIT_RESERVE_MS + 100);
      t.log.push('STOP RETURNED');
      await new Promise((resolve) => setTimeout(resolve, 50));

      // (Transactions 1 and 2 opened the two fences.) Not "BEGIN, SET,
      // INSERT, STOP RETURNED, COMMIT" — the reviewer's trace.
      expect(t.log).toEqual(['BEGIN 3', 'SET', 'INSERT', 'COMMIT 3', 'STOP RETURNED']);
      // The second began nothing once the window closed: still owed.
      expect(t.fences.owedCount).toBe(1);
    },
  );

  it.each(stops)(
    '%s: a COMMIT whose answer has not come back by the deadline is reported unsettled, never as drained',
    async (_name, stop) => {
      const t = await twoOwed();
      const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const answer = gate();
      t.steps.push({ commit: answer.opened });

      await stop(t, Date.now() + COMMIT_RESERVE_MS + 100);
      t.log.push('STOP RETURNED');
      answer.open();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(t.log).toEqual(['BEGIN 3', 'SET', 'INSERT', 'STOP RETURNED', 'COMMIT 3']);
      expect(errors.mock.calls.map(([message]) => String(message))).toEqual(
        expect.arrayContaining([expect.stringMatching(/with 1 transactions unsettled/)]),
      );
    },
  );

  it.each(stops)(
    '%s: the connection wait and the execution share one budget — a connection acquired late cannot run past the deadline',
    async (_name, stop) => {
      const t = await twoOwed();
      const startedAt = Date.now();
      const window = 200;
      // The connection comes free 40% into the window; its statement then
      // never answers. Only the transaction's own timeout can end it.
      const connection = gate();
      setTimeout(connection.open, window * 0.4);
      const held = gate();
      t.steps.push({ connection: connection.opened });
      const original = t.pool.transaction.bind(t.pool);
      jest.spyOn(t.pool, 'transaction').mockImplementationOnce((fn, options) =>
        original(async (tx) => {
          const result = await fn(tx);
          await held.opened;
          return result;
        }, options),
      );

      await stop(t, startedAt + COMMIT_RESERVE_MS + window);
      t.log.push('STOP RETURNED');
      held.open();
      await new Promise((resolve) => setTimeout(resolve, window));

      const [first] = t.bounds;
      expect(first!.maxWait! + first!.timeout!).toBeLessThanOrEqual(window);
      // Ended — rolled back by its own timeout — before the stop returned, and
      // nothing at all after it.
      expect(t.log.indexOf('ROLLBACK 3')).toBeGreaterThan(-1);
      expect(t.log.indexOf('ROLLBACK 3')).toBeLessThan(t.log.indexOf('STOP RETURNED'));
      expect(t.log.slice(t.log.indexOf('STOP RETURNED') + 1)).toEqual([]);
    },
  );

  it('the pool closes only once its transactions settled: a pending COMMIT comes back before DISCONNECT, and nothing begins after it', async () => {
    const t = await setup();
    const answer = gate();
    t.steps.push({ commit: answer.opened });
    const writing = t.pool.transaction((tx) => tx.$executeRawUnsafe('SET LOCAL x = 1'));

    const closing = t.pool.stop({ deadlineAt: Date.now() + 1_000 });
    // Closing: no transaction begins any more.
    expect(() => t.pool.transaction(async () => undefined)).toThrow(/pool is closed/);
    setTimeout(answer.open, 50);
    expect(await closing).toEqual({ drained: true, unsettled: 0 });
    await writing;
    expect(t.log).toEqual(['BEGIN 1', 'SET', 'COMMIT 1', 'DISCONNECT']);
  });

  it('a pool whose transaction has not settled by the deadline still closes then, and says how many it left', async () => {
    const t = await setup();
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const answer = gate();
    t.steps.push({ commit: answer.opened });
    const writing = t.pool.transaction((tx) => tx.$executeRawUnsafe('SET LOCAL x = 1'));

    expect(await t.pool.stop({ deadlineAt: Date.now() + 50 })).toEqual({
      drained: false,
      unsettled: 1,
    });
    expect(errors.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringMatching(/with 1 operations unsettled/),
      // No time was left for the disconnect: the close is abandoned, loudly.
      expect.stringMatching(/close ABANDONED.*1 operations still unsettled/),
    ]);
    answer.open();
    await writing;
    expect(t.log).toEqual(['BEGIN 1', 'SET', 'DISCONNECT', 'COMMIT 1']);
  });
});
