import 'reflect-metadata';
import { OutboxShutdown, WorkerAbandonedError } from '@rasta/nest-common';
import { outboxPendingTotal } from '@rasta/observability';
import { AppModule } from '../app.module';
import { ENV } from '../tokens';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxRelay } from '@rasta/nest-common';
import { WalletService } from '../wallet/wallet.service';
import { holdsActiveTotal } from './metrics';
import { EconomicGaugeSampler } from './gauge-sampler';

function setup() {
  const store = {
    pendingCount: jest.fn(async () => 2),
    activeLeaseCount: jest.fn(async () => 3),
    oldestPendingAgeSeconds: jest.fn(async () => 4),
  };
  const repository = { countActiveHolds: jest.fn(async () => 5) };
  const wallets = new WalletService(repository as never, {} as never, {} as never);
  const transactions = { countByStatus: jest.fn(async () => 6) };
  const idempotency = { purgeExpired: jest.fn(async () => 0) };
  const sampler = new EconomicGaugeSampler(
    store as never,
    transactions as never,
    wallets,
    idempotency as never,
  );
  return { sampler, store, repository, wallets, transactions, idempotency };
}

describe('economic gauge sampler shutdown (FU-323 C)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each(['lone rejection', 'sibling success', 'sibling abandonment'] as const)(
    'wallet sampling retains direct failure through %s before database close',
    async (mode) => {
      const { repository, wallets } = setup();
      let reject!: (error: Error) => void;
      let release!: (count: number) => void;
      repository.countActiveHolds.mockImplementationOnce(
        () =>
          new Promise<number>((_yes, no) => {
            reject = no;
          }),
      );
      repository.countActiveHolds.mockImplementationOnce(
        () =>
          new Promise<number>((yes) => {
            release = yes;
          }),
      );
      const failure = new Error('direct wallet sample failed');
      const work = wallets.sampleGauges().catch((error: unknown) => error);
      const other =
        mode === 'lone rejection'
          ? undefined
          : wallets.sampleGauges().catch((error: unknown) => error);
      const first = wallets.stopSampling({ deadlineAt: Date.now() + 100 });
      const outcome = first.catch((error: unknown) => error);
      const database = jest.fn(async () => undefined);
      const shutdown = new OutboxShutdown({
        relay: { stop: async () => undefined },
        workers: [{ stop: (options) => wallets.stopSampling(options) }],
        databases: [{ stop: database }],
        budgetMs: 100,
        logger: { error: jest.fn() },
      });
      const closed = shutdown.stop().catch((error: unknown) => error);
      reject(failure);
      expect(await work).toBe(failure);
      if (other) {
        await jest.advanceTimersByTimeAsync(0);
        expect(database).not.toHaveBeenCalled();
        if (mode === 'sibling success') release(9);
        else await jest.advanceTimersByTimeAsync(100);
      }
      expect(await outcome).toBe(failure);
      expect(await closed).toBe(failure);
      expect(database).toHaveBeenCalledTimes(1);
      if (other) {
        release(9);
        if (mode === 'sibling success') await expect(other).resolves.toBeUndefined();
        else expect(await other).toBeInstanceOf(WorkerAbandonedError);
      }
    },
  );

  it('keeps sampler-owned errors caught when they reject during stop', async () => {
    const { sampler, store, transactions, idempotency } = setup();
    let reject!: (error: Error) => void;
    store.pendingCount.mockImplementationOnce(
      () =>
        new Promise<number>((_yes, no) => {
          reject = no;
        }),
    );
    const running = sampler.sample();
    const stopped = sampler.stop();
    reject(new Error('sampling failed'));
    await expect(running).resolves.toBeUndefined();
    await expect(stopped).resolves.toBeUndefined();
    expect(transactions.countByStatus).not.toHaveBeenCalled();
    expect(idempotency.purgeExpired).not.toHaveBeenCalled();
  });

  it('preserves scheduled and direct sampling and upkeep; stop prevents timer restart', async () => {
    const { sampler, store, repository, transactions, idempotency } = setup();
    const holds = jest.spyOn(holdsActiveTotal, 'set');
    sampler.start();
    await jest.advanceTimersByTimeAsync(15_000);
    await sampler.sample();
    expect(store.pendingCount).toHaveBeenCalledTimes(2);
    expect(transactions.countByStatus.mock.calls).toEqual([
      ['PENDING_SETTLEMENT'],
      ['DISPUTED'],
      ['PENDING_SETTLEMENT'],
      ['DISPUTED'],
    ]);
    expect(holds).toHaveBeenLastCalledWith({ service: 'economic-service' }, 5);
    expect(repository.countActiveHolds).toHaveBeenCalledTimes(2);
    expect(idempotency.purgeExpired).toHaveBeenCalledTimes(2);
    await sampler.stop();
    sampler.start();
    await sampler.sample();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(store.pendingCount).toHaveBeenCalledTimes(2);
  });

  it.each(['scheduled', 'direct', 'wallet'] as const)(
    '%s calls tighten an unbounded stop; both late outcomes are silent',
    async (entry) => {
      const { sampler, store, repository, wallets, transactions, idempotency } = setup();
      const pending = jest.spyOn(outboxPendingTotal, 'set');
      const holds = jest.spyOn(holdsActiveTotal, 'set');
      const resolve: ((value: number) => void)[] = [];
      const reject: ((error: Error) => void)[] = [];
      const blocked = entry === 'wallet' ? repository.countActiveHolds : store.pendingCount;
      blocked.mockImplementation(
        () =>
          new Promise<number>((yes, no) => {
            resolve.push(yes);
            reject.push(no);
          }),
      );
      const running =
        entry === 'wallet'
          ? [
              wallets.sampleGauges().catch(() => undefined),
              wallets.sampleGauges().catch(() => undefined),
            ]
          : entry === 'direct'
            ? [sampler.sample(), sampler.sample()]
            : [];
      if (entry === 'scheduled') {
        sampler.start();
        await jest.advanceTimersByTimeAsync(30_000);
      }
      expect(blocked).toHaveBeenCalledTimes(2);
      let stopped = false;
      const first = sampler.stop();
      void first.then(() => {
        stopped = true;
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      expect(sampler.stop({ deadlineAt: Date.now() - 1 })).toBe(first);
      await jest.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(true);
      resolve[0](9);
      reject[1](new Error('late private database detail'));
      await Promise.all(running);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(pending).not.toHaveBeenCalled();
      expect(holds).not.toHaveBeenCalled();
      expect(transactions.countByStatus).not.toHaveBeenCalled();
      expect(idempotency.purgeExpired).not.toHaveBeenCalled();
      await sampler.sample();
      await wallets.sampleGauges();
      expect(blocked).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['sampler', 'wallet'] as const)(
    'rechecks activity immediately before a %s gauge',
    async (entry) => {
      jest.useRealTimers();
      const { sampler, store, repository, wallets, idempotency } = setup();
      const pending = jest.spyOn(outboxPendingTotal, 'set');
      const holds = jest.spyOn(holdsActiveTotal, 'set');
      const boundary = entry === 'sampler' ? sampler['worker'] : wallets['samplingWorker'];
      const read = entry === 'sampler' ? store.pendingCount : repository.countActiveHolds;
      read.mockImplementation(() => {
        // Abandon after workerOperation's check, before its caller resumes.
        queueMicrotask(() => queueMicrotask(() => boundary.abandon()));
        return Promise.resolve(7);
      });
      await (entry === 'sampler' ? sampler.sample() : wallets.sampleGauges()).catch(
        () => undefined,
      );
      expect(pending).not.toHaveBeenCalled();
      expect(holds).not.toHaveBeenCalled();
      expect(idempotency.purgeExpired).not.toHaveBeenCalled();
      await sampler.stop();
    },
  );

  it('the real coordinator factory waits for abandonment despite a sibling rejection before DB close', async () => {
    const { sampler, store, transactions, idempotency } = setup();
    let release!: (value: number) => void;
    store.pendingCount.mockImplementation(
      () =>
        new Promise<number>((yes) => {
          release = yes;
        }),
    );
    const pending = jest.spyOn(outboxPendingTotal, 'set');
    const running = sampler.sample();
    const database = { stop: jest.fn(async () => undefined) };
    const failure = new Error('relay stop failed');
    const providers = Reflect.getMetadata('providers', AppModule) as {
      provide?: unknown;
      inject: unknown[];
      useFactory: (...args: unknown[]) => OutboxShutdown;
    }[];
    const factory = providers.find((provider) => provider.provide === OutboxShutdown)!;
    const coordinator = factory.useFactory(
      ...factory.inject.map((token) =>
        token === ENV
          ? { SHUTDOWN_TIMEOUT_MS: 2100 }
          : token === EconomicGaugeSampler
            ? sampler
            : token === PrismaService
              ? database
              : token === OutboxRelay
                ? {
                    stop: async () => {
                      throw failure;
                    },
                  }
                : { stop: async () => undefined },
      ),
    );
    const stopped = coordinator.stop().catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(0);
    expect(database.stop).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(101);
    expect(await stopped).toBe(failure);
    expect(database.stop).toHaveBeenCalledTimes(1);
    release(8);
    await running;
    expect(pending).not.toHaveBeenCalled();
    expect(transactions.countByStatus).not.toHaveBeenCalled();
    expect(idempotency.purgeExpired).not.toHaveBeenCalled();
  });
});
