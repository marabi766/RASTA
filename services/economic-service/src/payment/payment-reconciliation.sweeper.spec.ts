import { loadEconomicEnv, type EconomicEnv } from '../config/env';
import { Logger } from '@nestjs/common';
import { WorkerAbandonedError } from '@rasta/nest-common';
import type { PrismaService } from '../prisma/prisma.service';
import type { PaymentService } from './payment.service';
import type { PaymentProvider } from './provider';
import type { LedgerService } from '../ledger/ledger.service';
import type { WalletRepository } from '../wallet/wallet.repository';
import {
  paymentReconciliationTotal,
  paymentProviderRefundStatusTotal,
} from '../observability/metrics';
import { PaymentReconciliationSweeper } from './payment-reconciliation.sweeper';
import type {
  PaymentReconciliationRepository,
  ClaimedTask,
} from './payment-reconciliation.repository';
import { PaymentReconciler, type ReconcileResult } from './payment-reconciler';

/**
 * The sweeper's own behaviour, apart from the database (ADR-064 step B2): it
 * runs on its timer, never overlaps itself, survives a failed sweep and a
 * failed task, tallies every result, and waits for a running sweep on
 * shutdown. The database side is `test/payment-reconciler.int-spec.ts`.
 */
const NO_CURSOR = { missing: null, stale: null };

describe('PaymentReconciliationSweeper', () => {
  const env: EconomicEnv = loadEconomicEnv({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/rasta_economic?schema=public',
    KAFKA_BROKERS: 'localhost:9092',
    OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
    OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: 'a_secret_that_is_at_least_thirty_two_chars',
    MAINTENANCE_SERVICE_URL: 'http://localhost:3105',
    FLEET_SERVICE_URL: 'http://localhost:3104',
    CONTRACT_SERVICE_URL: 'http://localhost:3111',
  });

  const task = (id: string): ClaimedTask => ({
    id,
    organizationId: 'ORG-SWEEP',
    paymentIntentId: `PAY_${id}`,
    kind: 'REFUND',
    attempts: 0,
    createdAt: new Date(),
    correlationId: `COR-${id}`,
    leaseToken: 'token',
  });

  function build(results: (ReconcileResult | Error)[], backlogFails = false) {
    const claimed = results.map((_, index) => task(`T${index}`));
    const tasks = {
      heal: jest.fn().mockResolvedValue({ opened: 0, closed: 0, cursor: NO_CURSOR }),
      claimDue: jest.fn().mockResolvedValue(claimed),
      backlog: backlogFails
        ? jest.fn().mockRejectedValue('database gone')
        : jest.fn().mockResolvedValue({ open: 1, escalated: 0, oldestDueAgeSeconds: 0 }),
    };
    let index = 0;
    const reconciler = {
      reconcile: jest.fn(async () => {
        const next = results[index++];
        if (next instanceof Error) throw next;
        return next;
      }),
    };
    const sweeper = new PaymentReconciliationSweeper(
      tasks as unknown as PaymentReconciliationRepository,
      reconciler as unknown as PaymentReconciler,
      env,
    );
    return { sweeper, tasks, reconciler };
  }

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each(['transaction', 'provider'] as const)(
    'drops both late %s outcomes without success, failure classification or retry',
    async (stage) => {
      for (const rejects of [false, true]) {
        const { tasks } = build(['noop']);
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const wait = async () => {
          entered();
          await held;
          if (rejects) throw new Error('late database/provider rejection');
          return { action: 'RECORD_REFUNDED', resolution: 'REFUNDED' };
        };
        const retry = jest.fn().mockResolvedValue(1);
        const transaction = jest.fn(wait);
        const reconciler = new PaymentReconciler(
          {
            client: {
              paymentIntent: {
                findUnique: async () => ({
                  organizationId: 'ORG-SWEEP',
                  failureReason: stage === 'provider' ? 'REFUND_UNKNOWN' : null,
                }),
              },
            },
            transaction,
          } as unknown as PrismaService,
          {} as PaymentService,
          {
            ownershipOf: () => ({}),
            retryLater: retry,
          } as unknown as PaymentReconciliationRepository,
          { getRefundStatus: wait } as unknown as PaymentProvider,
          {} as LedgerService,
          {} as WalletRepository,
          env,
        );
        const sweeper = new PaymentReconciliationSweeper(
          tasks as unknown as PaymentReconciliationRepository,
          reconciler,
          env,
        );
        const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
        const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        const metric = jest.spyOn(paymentReconciliationTotal, 'inc');
        const providerMetric = jest.spyOn(paymentProviderRefundStatusTotal, 'inc');
        const run = sweeper.runOnce(); // Operator/test entry is tracked too, without a timer.
        const result = expect(run).rejects.toBeInstanceOf(WorkerAbandonedError);
        await started;
        let stopped = false;
        const first = sweeper.stop().then(() => {
          stopped = true;
        });
        sweeper.stop({ deadlineAt: Date.now() - 1 });
        for (let i = 0; i < 30; i++) await Promise.resolve();
        expect(stopped).toBe(true);
        await first;
        const warningsAtStop = warn.mock.calls.length;
        release();
        await result;
        // Boundary warnings may repeat UNCONFIRMED, never claim a rollback/result.
        expect(
          warn.mock.calls
            .slice(warningsAtStop)
            .every(([message]) => String(message).includes('UNCONFIRMED')),
        ).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('UNCONFIRMED'));
        expect(log).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(metric).not.toHaveBeenCalled();
        expect(providerMetric).not.toHaveBeenCalled();
        expect(retry).not.toHaveBeenCalled();
        expect(tasks.backlog).not.toHaveBeenCalled();
        if (stage === 'provider') expect(transaction).not.toHaveBeenCalled();
        await expect(sweeper.runOnce()).rejects.toBeInstanceOf(WorkerAbandonedError);
        jest.restoreAllMocks();
      }
    },
  );

  it('carries the heal window from one sweep to the next (Codex on #164)', async () => {
    const { sweeper, tasks } = build([]);
    const next = {
      missing: { createdAt: new Date('2026-09-30T10:00:00Z'), id: 'PAY_A' },
      stale: null,
    };
    tasks.heal.mockResolvedValueOnce({ opened: 0, closed: 0, cursor: next });

    await sweeper.runOnce();
    await sweeper.runOnce();

    expect(tasks.heal).toHaveBeenNthCalledWith(
      1,
      env.ECONOMIC_PAYMENT_RECONCILER_BATCH_SIZE,
      NO_CURSOR,
    );
    expect(tasks.heal).toHaveBeenNthCalledWith(2, env.ECONOMIC_PAYMENT_RECONCILER_BATCH_SIZE, next);
  });

  it('tallies every result, and a task that throws does not stall the batch', async () => {
    const { sweeper, reconciler } = build([
      'resolved_refunded',
      'resolved_declined',
      'resolved_not_reached',
      'resolved_uncredited',
      'noop',
      'retried',
      'deferred',
      'escalated',
      'lost_lease',
      new Error('beyond its own handling'),
    ]);

    expect(await sweeper.runOnce()).toEqual({
      claimed: 10,
      resolved: 4,
      noop: 1,
      retried: 1,
      deferred: 1,
      escalated: 1,
      lost: 2,
      healedOpened: 0,
      healedClosed: 0,
    });
    expect(reconciler.reconcile).toHaveBeenCalledTimes(10);
  });

  it('reports heals, and sweeps even when the backlog cannot be sampled', async () => {
    const { sweeper, tasks } = build([], true);
    tasks.heal.mockResolvedValue({ opened: 2, closed: 3, cursor: NO_CURSOR });
    await expect(sweeper.runOnce()).resolves.toMatchObject({
      claimed: 0,
      healedOpened: 2,
      healedClosed: 3,
    });
  });

  it('sweeps on its timer, never overlapping itself, and survives a failed sweep', async () => {
    jest.useFakeTimers();
    const { sweeper } = build([]);
    let finish!: () => void;
    const run = jest
      .spyOn(sweeper, 'runOnce')
      .mockRejectedValueOnce(new Error('database down'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({} as never);
          }),
      );

    sweeper.onModuleInit();
    const interval = env.ECONOMIC_PAYMENT_RECONCILER_INTERVAL_SECONDS * 1000;

    await jest.advanceTimersByTimeAsync(interval); // fails, is caught
    await jest.advanceTimersByTimeAsync(interval); // starts, hangs
    await jest.advanceTimersByTimeAsync(interval); // skipped: still running
    expect(run).toHaveBeenCalledTimes(2);

    const stopped = sweeper.onApplicationShutdown();
    finish();
    await stopped;
    await jest.advanceTimersByTimeAsync(interval * 3);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not start when switched off', async () => {
    jest.useFakeTimers();
    const { tasks } = build([]);
    const off = new PaymentReconciliationSweeper(
      tasks as unknown as PaymentReconciliationRepository,
      { reconcile: jest.fn() } as unknown as PaymentReconciler,
      { ...env, ECONOMIC_PAYMENT_RECONCILER_ENABLED: false },
    );
    off.onModuleInit();
    await jest.advanceTimersByTimeAsync(env.ECONOMIC_PAYMENT_RECONCILER_INTERVAL_SECONDS * 5000);
    expect(tasks.claimDue).not.toHaveBeenCalled();
    await off.onApplicationShutdown();
  });

  /**
   * D-052: the sweep stops with the relay and the purge, in the destroy phase,
   * by their shared deadline — no new task once stopping, and no wait past the
   * deadline for the one being reconciled.
   */
  describe('stop', () => {
    const interval = env.ECONOMIC_PAYMENT_RECONCILER_INTERVAL_SECONDS * 1000;

    /** A sweep the timer started over three tasks, held in reconciling the first. */
    async function heldInTheFirstTask() {
      jest.useFakeTimers();
      const built = build(['noop', 'noop', 'noop']);
      let finish: () => void = () => undefined;
      built.reconciler.reconcile.mockImplementationOnce(
        () =>
          new Promise<ReconcileResult>((resolve) => {
            finish = () => resolve('noop');
          }),
      );
      built.sweeper.onModuleInit();
      await jest.advanceTimersByTimeAsync(interval);
      expect(built.reconciler.reconcile).toHaveBeenCalledTimes(1);
      return { ...built, finish: () => finish() };
    }

    it.each([
      [undefined, 10],
      [1000, 10],
      [undefined, -1],
      [1000, -1],
    ] as const)('re-arms initial %s stop to %s ms without extension', async (initial, delay) => {
      const { sweeper, tasks, finish } = await heldInTheFirstTask();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      let stopped = false;
      const first = sweeper.stop(initial === undefined ? {} : { deadlineAt: Date.now() + initial });
      const joined = first.then(() => {
        stopped = true;
      });
      expect(sweeper.stop({ deadlineAt: Date.now() + delay })).toBe(first);
      // Wall-clock correction and a later/omitted deadline cannot extend a monotonic wait.
      jest.setSystemTime(Date.now() - 60_000);
      expect(sweeper.stop({ deadlineAt: Date.now() + 70_000 })).toBe(first);
      expect(sweeper.onApplicationShutdown()).toBe(first);
      if (delay > 0) {
        await jest.advanceTimersByTimeAsync(delay - 1);
        expect(stopped).toBe(false);
      }
      await jest.advanceTimersByTimeAsync(delay > 0 ? 1 : 0);
      expect(stopped).toBe(true);
      await joined;
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('UNCONFIRMED'));
      finish();
      await jest.advanceTimersByTimeAsync(0);
      expect(tasks.backlog).not.toHaveBeenCalled();
    });

    it.each([0, 1])('joins timer/direct work in completion order %s', async (firstIndex) => {
      jest.useFakeTimers();
      const { sweeper, tasks } = build([]);
      const releases: (() => void)[] = [];
      tasks.heal.mockImplementation(
        () =>
          new Promise((resolve) => {
            releases.push(() => resolve({ opened: 0, closed: 0, cursor: NO_CURSOR }));
          }),
      );
      sweeper.onModuleInit();
      await jest.advanceTimersByTimeAsync(interval);
      const direct = sweeper.runOnce();
      expect(releases).toHaveLength(2);
      let stopped = false;
      const stop = sweeper.stop().then(() => {
        stopped = true;
      });
      releases[firstIndex]!();
      await jest.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      releases[1 - firstIndex]!();
      await jest.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(true);
      await Promise.all([stop, direct]);
    });

    it.each([1, 2])(
      'propagates %s raw sweep failures only after all work settles',
      async (count) => {
        jest.useFakeTimers();
        const { sweeper, tasks } = build([]);
        const releases: ((error?: Error) => void)[] = [];
        tasks.heal.mockImplementation(
          () =>
            new Promise((resolve, reject) => {
              releases.push((error) =>
                error ? reject(error) : resolve({ opened: 0, closed: 0, cursor: NO_CURSOR }),
              );
            }),
        );
        const runs = [sweeper.runOnce(), sweeper.runOnce()].map((run) =>
          run.catch(() => undefined),
        );
        let stopped = false;
        const first = sweeper.stop();
        const result = first.catch((error: unknown) => {
          stopped = true;
          return error;
        });
        // Tightening must not observe the same failure twice.
        expect(sweeper.stop({ deadlineAt: Date.now() + 1000 })).toBe(first);
        const failures = [new Error('first sweep failed'), new Error('second sweep failed')];
        releases[0]!(failures[0]);
        await jest.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);
        releases[1]!(count === 2 ? failures[1] : undefined);
        await jest.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(true);
        const error = await result;
        if (count === 1) expect(error).toBe(failures[0]);
        else {
          expect(error).toBeInstanceOf(AggregateError);
          expect((error as AggregateError).errors).toEqual(failures);
        }
        await Promise.all(runs);
      },
    );

    it('retains an early failure when another sweep is abandoned', async () => {
      jest.useFakeTimers();
      const { sweeper, tasks } = build([]);
      const failure = new Error('first sweep failed');
      let reject!: (error: Error) => void;
      let release!: () => void;
      tasks.heal
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, fail) => {
              reject = fail;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = () => resolve({ opened: 0, closed: 0, cursor: NO_CURSOR });
            }),
        );
      const failed = sweeper.runOnce().catch((error: unknown) => error);
      const late = sweeper.runOnce().catch((error: unknown) => error);
      let stopped = false;
      const first = sweeper.stop();
      const result = first.catch((error: unknown) => {
        stopped = true;
        return error;
      });
      expect(sweeper.stop({ deadlineAt: Date.now() + 10 })).toBe(first);
      reject(failure);
      await jest.advanceTimersByTimeAsync(9);
      expect(stopped).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(stopped).toBe(true);
      expect(await result).toBe(failure);
      expect(await failed).toBe(failure);
      release();
      expect(await late).toBeInstanceOf(WorkerAbandonedError);
    });

    it('starts no further task once stopping, and waits for the one in flight', async () => {
      const { sweeper, reconciler, finish } = await heldInTheFirstTask();

      let stopped = false;
      const stopping = sweeper.stop({ deadlineAt: Date.now() + 5000 }).then(() => {
        stopped = true;
      });
      await jest.advanceTimersByTimeAsync(100);
      expect(stopped).toBe(false);

      finish();
      await stopping;
      expect(reconciler.reconcile).toHaveBeenCalledTimes(1);
    });

    it('returns by the deadline when the task in flight never finishes', async () => {
      const { sweeper, tasks, finish } = await heldInTheFirstTask();

      let stopped = false;
      const stopping = sweeper.stop({ deadlineAt: Date.now() + 300 }).then(() => {
        stopped = true;
      });
      await jest.advanceTimersByTimeAsync(299);
      expect(stopped).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await stopping;
      expect(stopped).toBe(true);
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      finish();
      await jest.advanceTimersByTimeAsync(0);
      expect(tasks.backlog).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

    it('clears its timer, returns at once when idle, and is one stop', async () => {
      jest.useFakeTimers();
      const { sweeper, tasks } = build([]);
      sweeper.onModuleInit();

      const first = sweeper.stop({ deadlineAt: Date.now() + 1000 });
      expect(sweeper.stop()).toBe(first);
      expect(sweeper.onApplicationShutdown()).toBe(first);
      await first;
      sweeper.onModuleInit(); // A late lifecycle hook cannot restart a stopped timer.
      await jest.advanceTimersByTimeAsync(interval * 3);
      expect(tasks.claimDue).not.toHaveBeenCalled();
    });
  });
});
