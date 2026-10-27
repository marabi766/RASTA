import { MembershipExpiryScanner } from '../identity/membership-expiry.scanner';
import type { IdentityRepository } from '../identity/identity.repository';
import type { IdentityService } from '../identity/identity.service';
import { throwIfCancelled } from '../prisma/cancellation';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { KeycloakProjectionConsumer } from './keycloak-projection.consumer';
import type { KeycloakProjector } from './keycloak.projector';
import { KeycloakWriteFences, type KeycloakWriteAttempt } from './keycloak-write-fence';

/**
 * #458 r1 F1 and F2, on the fences' in-memory obligations and a stop's flush,
 * with interleavings a real database cannot be made to produce on demand.
 *
 * The pool is the **real** `PrismaService.transaction` — its check before a
 * transaction begins and before its COMMIT — over a model of Prisma's engine:
 * a transaction waits for a connection at most `maxWait`, then BEGIN, its
 * callback's statements (each through the client extension's cancellation
 * check, as in `PrismaService`), then COMMIT, or ROLLBACK when the callback
 * throws. Every step is logged, so a test can say exactly what reached the
 * "database" and when.
 */

interface Step {
  /** Resolves when the connection is free; at most `maxWait` is waited. */
  connection?: Promise<void>;
  /** Fails the statement (the database failed, or the scope refused it). */
  fail?: boolean;
  /** Resolves when the COMMIT's answer comes back. */
  commit?: Promise<void>;
}

function modelledPool() {
  const log: string[] = [];
  const steps: Step[] = [];
  let transactions = 0;
  const statement = (sql: string) => {
    // The client extension's check (`PrismaService.buildClient`).
    throwIfCancelled();
    log.push(sql);
    return Promise.resolve(1);
  };
  const tx = {
    $executeRaw: (strings: TemplateStringsArray) =>
      statement(strings.join('?').includes('INSERT') ? 'INSERT' : 'STATEMENT'),
    $executeRawUnsafe: (sql: string) => statement(sql.startsWith('SET LOCAL') ? 'SET' : sql),
  };
  const client = {
    async $transaction<T>(
      callback: (client: unknown) => Promise<T>,
      options: { maxWait?: number } = {},
    ): Promise<T> {
      const number = ++transactions;
      const step = steps.shift() ?? {};
      if (step.connection) {
        let timer: NodeJS.Timeout | undefined;
        const waited = await Promise.race([
          step.connection.then(() => 'connected' as const),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), options.maxWait ?? 2_000);
          }),
        ]);
        clearTimeout(timer);
        if (waited === 'timeout') throw new Error(`transaction ${number}: no connection in time`);
      }
      log.push(`BEGIN ${number}`);
      try {
        if (step.fail) throw new Error(`transaction ${number}: refused`);
        const result = await callback(tx);
        await step.commit;
        log.push(`COMMIT ${number}`);
        return result;
      } catch (error) {
        log.push(`ROLLBACK ${number}`);
        throw error;
      }
    },
  };
  const pool = Object.create(PrismaService.prototype) as PrismaService;
  Object.assign(pool, { client });
  return { pool, log, steps };
}

/** A business transaction that holds the user lock with all its budget left. */
const lockHolder = {
  $queryRaw: async () => [{ elapsed_ms: 0 }],
} as unknown as ExtendedPrismaClient;

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

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
    '%s: a COMMIT whose callback resumes past the deadline is refused',
    async (_name, stop) => {
      const t = await twoOwed();
      // Its statement's answer is held past the deadline: the COMMIT check refuses.
      const held = gate();
      const original = t.pool.transaction.bind(t.pool);
      jest.spyOn(t.pool, 'transaction').mockImplementationOnce((fn, options) =>
        original(async (tx) => {
          const result = await fn(tx);
          await held.opened;
          return result;
        }, options),
      );

      await stop(t, Date.now() + 50);
      t.log.push('STOP RETURNED');
      held.open();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const after = t.log.slice(t.log.indexOf('STOP RETURNED') + 1);
      expect(after.filter((step) => /^(BEGIN|SET|INSERT|COMMIT)/.test(step))).toEqual([]);
      // The one transaction that had begun rolls back; the second never begins.
      expect(after.filter((step) => step.startsWith('ROLLBACK'))).toHaveLength(1);
      expect(t.fences.owedCount).toBe(2);
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
