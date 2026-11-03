import { OutboxRelay, type OutboxClaim, type OutboxRow, type OutboxStore } from './outbox';
import { OutboxPurgeScheduler, type OutboxPurgeStore } from './outbox-purge';
import { OutboxShutdown, type OutboxStoppable } from './outbox-shutdown';
import type { PurgePublishedBatch } from './outbox-sql';

/**
 * Codex r2 on #247: the purge drained in Nest's destroy phase and the relay's
 * grace began only in `onApplicationShutdown`, so two bounds that each fit
 * SHUTDOWN_TIMEOUT_MS added up past it; and a second `stop()` waited a whole
 * bound again on the batch the first had abandoned. These run the real relay
 * and the real scheduler, on real timers, with work that never ends.
 */

const row = (id: string): OutboxRow => ({
  id,
  aggregateType: 'Probe',
  aggregateId: id,
  eventName: 'PROBE',
  eventVersion: 1,
  topic: 'rasta.shutdown-spec.v1',
  partitionKey: id,
  payload: {},
  headers: {},
  organizationId: 'ORG-SPEC',
  correlationId: id,
  createdAt: new Date(0),
  publishedAt: null,
  attempts: 0,
  lastError: null,
});

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** A store whose one claim hands out `ids`; `release` may be made to hang. */
function claimingStore(ids: string[], options: { releaseHangs?: boolean } = {}) {
  const released: string[] = [];
  let claimed = false;
  const store: OutboxStore = {
    async claimPending(): Promise<OutboxClaim> {
      if (claimed) return { token: null, rows: [], reclaimed: 0 };
      claimed = true;
      return { token: 'tok', rows: ids.map(row), reclaimed: 0 };
    },
    markPublished: async (published) => published.length,
    markFailed: async () => 1,
    release: (toRelease) => {
      if (options.releaseHangs) return never<number>();
      released.push(...toRelease);
      return Promise.resolve(toRelease.length);
    },
    renew: async (owned) => [...owned],
    oldestPendingAgeSeconds: async () => 0,
  };
  return { store, released };
}

/** A relay with one batch whose publish never returns: the grace's worst case. */
async function relayStuckInPublish(graceSeconds: number) {
  const { store } = claimingStore(['R1']);
  const relay = new OutboxRelay({
    store,
    publisher: { publish: () => never<void>() },
    shutdownGraceSeconds: graceSeconds,
    leaseSeconds: 60,
  });
  void relay.tick();
  await new Promise((resolve) => setImmediate(resolve));
  return relay;
}

/** A purge with one batch that never returns: the batch bound's worst case (8 s here). */
async function purgeStuckInBatch() {
  const store: OutboxPurgeStore = { purgePublished: () => never<PurgePublishedBatch>() };
  const purge = new OutboxPurgeScheduler({
    store,
    service: 'shutdown-spec',
    enabled: true,
    retentionHours: 168,
    intervalMs: 300_000,
    batchSize: 100,
    maxBatchesPerRun: 1,
    statementTimeoutMs: 2000,
    maxWaitMs: 1000,
  });
  void purge.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  return purge;
}

const elapsed = async (work: () => Promise<void>): Promise<number> => {
  const startedAt = Date.now();
  await work();
  return Date.now() - startedAt;
};

describe('OutboxShutdown', () => {
  it('drains the relay and the purge concurrently, both by one deadline', async () => {
    const relay = await relayStuckInPublish(1);
    const purge = await purgeStuckInBatch();
    expect(purge.stopBoundMs).toBe(8000);
    const shutdown = new OutboxShutdown({ relay, purge, budgetMs: 1500 });

    // One after the other, the relay's 1 s grace and the purge's 8 s bound
    // would take 9 s. Concurrently, against a 1.5 s deadline:
    const ms = await elapsed(() => shutdown.stop());
    expect(ms).toBeGreaterThanOrEqual(1400);
    expect(ms).toBeLessThan(2500);
  });

  it('takes the longer of the two waits, not their sum, when both fit the budget', async () => {
    const relay = await relayStuckInPublish(1);
    const slowStop = { stop: () => new Promise<void>((resolve) => setTimeout(resolve, 1000)) };
    const shutdown = new OutboxShutdown({ relay, purge: slowStop, budgetMs: 5000 });
    const ms = await elapsed(() => shutdown.stop());
    expect(ms).toBeGreaterThanOrEqual(950);
    expect(ms).toBeLessThan(1800);
  });

  it('starts both stops at once and hands both the same deadline', async () => {
    const calls: { name: string; deadlineAt?: number }[] = [];
    const gates: (() => void)[] = [];
    const part = (name: string): OutboxStoppable => ({
      stop: (options) => {
        calls.push({ name, deadlineAt: options?.deadlineAt });
        return new Promise<void>((resolve) => gates.push(resolve));
      },
    });
    const shutdown = new OutboxShutdown({
      relay: part('relay'),
      purge: part('purge'),
      budgetMs: 23_000,
      now: () => 1_000_000,
    });

    const stopping = shutdown.stop();
    // Neither has returned, and both were asked already.
    expect(calls).toEqual([
      { name: 'relay', deadlineAt: 1_023_000 },
      { name: 'purge', deadlineAt: 1_023_000 },
    ]);
    for (const open of gates) open();
    await stopping;
  });

  it('stops the workers in the same call, by the same deadline, beside the relay and the purge', async () => {
    const calls: { name: string; deadlineAt?: number }[] = [];
    const gates: (() => void)[] = [];
    const part = (name: string): OutboxStoppable => ({
      stop: (options) => {
        calls.push({ name, deadlineAt: options?.deadlineAt });
        return new Promise<void>((resolve) => gates.push(resolve));
      },
    });
    const shutdown = new OutboxShutdown({
      relay: part('relay'),
      purge: part('purge'),
      workers: [part('scan'), part('sweep')],
      budgetMs: 23_000,
      now: () => 1_000_000,
    });

    let done = false;
    const stopping = shutdown.stop().then(() => {
      done = true;
    });
    expect(calls).toEqual([
      { name: 'relay', deadlineAt: 1_023_000 },
      { name: 'purge', deadlineAt: 1_023_000 },
      { name: 'scan', deadlineAt: 1_023_000 },
      { name: 'sweep', deadlineAt: 1_023_000 },
    ]);
    // Waits for every one of them, the workers included.
    for (const open of gates.slice(0, 3)) open();
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toBe(false);
    gates[3]!();
    await stopping;
    expect(done).toBe(true);
  });

  it('bounds a worker that never stops by the shared deadline, beside a stuck relay', async () => {
    const relay = await relayStuckInPublish(1);
    // A worker that honours the deadline, with a unit of work that never ends.
    const worker: OutboxStoppable = {
      stop: async (options) => {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, (options?.deadlineAt ?? Infinity) - Date.now())),
        );
      },
    };
    const shutdown = new OutboxShutdown({ relay, workers: [worker], budgetMs: 1500 });
    const ms = await elapsed(() => shutdown.stop());
    // The relay's 1 s grace and the worker's 1.5 s, concurrently: 1.5 s, not 2.5 s.
    expect(ms).toBeGreaterThanOrEqual(1400);
    expect(ms).toBeLessThan(2200);
  });

  it('is one stop: a repeated call joins it and, once it returned, returns at once', async () => {
    const relay = await relayStuckInPublish(1);
    const purge = await purgeStuckInBatch();
    const relayStop = jest.spyOn(relay, 'stop');
    const purgeStop = jest.spyOn(purge, 'stop');
    const shutdown = new OutboxShutdown({ relay, purge, budgetMs: 1000 });

    const first = shutdown.stop();
    expect(shutdown.stop()).toBe(first);
    await first;
    // onApplicationShutdown's confirmation, a second signal: no second wait.
    expect(await elapsed(() => shutdown.stop())).toBeLessThan(50);
    expect(await elapsed(() => shutdown.onModuleDestroy())).toBeLessThan(50);
    // The components' own repeated stops return at once too.
    expect(await elapsed(() => relay.stop())).toBeLessThan(50);
    expect(await elapsed(() => purge.stop())).toBeLessThan(50);
    expect(relayStop).toHaveBeenCalledTimes(2);
    expect(purgeStop).toHaveBeenCalledTimes(2);
  });

  describe('the publishers (D-052 phase 4b, Codex r1 on #293)', () => {
    /** A part whose stop is recorded and returns only when its gate opens. */
    function gatedParts() {
      const calls: { name: string; deadlineAt?: number }[] = [];
      const gates = new Map<string, () => void>();
      const part = (name: string): OutboxStoppable => ({
        stop: (options) => {
          calls.push({ name, deadlineAt: options?.deadlineAt });
          return new Promise<void>((resolve) => gates.set(name, resolve));
        },
      });
      const open = async (name: string): Promise<void> => {
        gates.get(name)!();
        await new Promise((resolve) => setImmediate(resolve));
      };
      return { calls, part, open };
    }

    it('closes the publishers only once the relay, the purge and every worker have returned', async () => {
      const { calls, part, open } = gatedParts();
      const shutdown = new OutboxShutdown({
        relay: part('relay'),
        purge: part('purge'),
        workers: [part('sweep')],
        publishers: [part('publisher')],
        budgetMs: 23_000,
        now: () => 1_000_000,
      });

      const stopping = shutdown.stop();
      const names = () => calls.map((call) => call.name);
      expect(names()).toEqual(['relay', 'purge', 'sweep']);
      await open('relay');
      await open('sweep');
      // The purge still runs: the publisher is not asked yet.
      expect(names()).toEqual(['relay', 'purge', 'sweep']);
      await open('purge');
      expect(names()).toEqual(['relay', 'purge', 'sweep', 'publisher']);
      await open('publisher');
      await stopping;
    });

    it('hands the publishers the drain’s deadline — one budget, not a second one from their start', async () => {
      let now = 1_000_000;
      const { calls, part, open } = gatedParts();
      const shutdown = new OutboxShutdown({
        relay: part('relay'),
        publishers: [part('publisher')],
        budgetMs: 23_000,
        now: () => now,
      });

      const stopping = shutdown.stop();
      // The relay drains for 20 s of the 23 s budget.
      now += 20_000;
      await open('relay');
      expect(calls).toEqual([
        { name: 'relay', deadlineAt: 1_023_000 },
        { name: 'publisher', deadlineAt: 1_023_000 },
      ]);
      await open('publisher');
      await stopping;
    });

    it('a stuck relay and a stuck producer close: the whole stop still ends at the one deadline', async () => {
      const relay = await relayStuckInPublish(1);
      // A publisher that honours the deadline, with a close that never ends.
      let publisherAskedAfterMs = -1;
      const startedAt = Date.now();
      const publisher: OutboxStoppable = {
        stop: async (options) => {
          publisherAskedAfterMs = Date.now() - startedAt;
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, (options?.deadlineAt ?? Infinity) - Date.now())),
          );
        },
      };
      const shutdown = new OutboxShutdown({ relay, publishers: [publisher], budgetMs: 1500 });

      const ms = await elapsed(() => shutdown.stop());
      // After the relay's 1 s grace, and within the 1.5 s: 1.5 s, not 1 s + 1.5 s.
      expect(publisherAskedAfterMs).toBeGreaterThanOrEqual(950);
      expect(ms).toBeGreaterThanOrEqual(1400);
      expect(ms).toBeLessThan(2200);
    });

    it('closes the publishers even when a drain fails, and still reports the failure', async () => {
      const closed: string[] = [];
      const shutdown = new OutboxShutdown({
        relay: { stop: async () => Promise.reject(new Error('relay stop failed')) },
        publishers: [{ stop: async () => void closed.push('publisher') }],
        budgetMs: 1000,
      });
      await expect(shutdown.stop()).rejects.toThrow('relay stop failed');
      expect(closed).toEqual(['publisher']);
    });

    it('a repeated stop joins: each publisher is closed once', async () => {
      const stop = jest.fn(async () => undefined);
      const shutdown = new OutboxShutdown({
        relay: { stop: async () => undefined },
        publishers: [{ stop }],
        budgetMs: 1000,
      });
      await Promise.all([shutdown.stop(), shutdown.onModuleDestroy()]);
      await shutdown.stop();
      expect(stop).toHaveBeenCalledTimes(1);
    });
  });

  describe('the databases (Codex r2 on #458, F2)', () => {
    it('closes the databases last: once the relay, the purge, every worker and the publishers returned, by the same deadline', async () => {
      const calls: { name: string; deadlineAt?: number }[] = [];
      const gates = new Map<string, () => void>();
      const part = (name: string): OutboxStoppable => ({
        stop: (options) => {
          calls.push({ name, deadlineAt: options?.deadlineAt });
          return new Promise<void>((resolve) => gates.set(name, resolve));
        },
      });
      const open = async (name: string): Promise<void> => {
        gates.get(name)!();
        await new Promise((resolve) => setImmediate(resolve));
      };
      const shutdown = new OutboxShutdown({
        relay: part('relay'),
        purge: part('purge'),
        workers: [part('sweep')],
        publishers: [part('publisher')],
        databases: [part('pool'), part('fence pool')],
        budgetMs: 23_000,
        now: () => 1_000_000,
      });

      const stopping = shutdown.stop();
      const names = () => calls.map((call) => call.name);
      await open('relay');
      await open('purge');
      // A worker still runs: no pool is closed under it.
      expect(names()).toEqual(['relay', 'purge', 'sweep']);
      await open('sweep');
      expect(names()).toEqual(['relay', 'purge', 'sweep', 'publisher']);
      await open('publisher');
      expect(names()).toEqual(['relay', 'purge', 'sweep', 'publisher', 'pool', 'fence pool']);
      expect(calls.every((call) => call.deadlineAt === 1_023_000)).toBe(true);
      await open('pool');
      await open('fence pool');
      await stopping;
    });

    it('closes the databases even when a drain or a publisher fails, and still reports the failure', async () => {
      const closed: string[] = [];
      const shutdown = new OutboxShutdown({
        relay: { stop: async () => Promise.reject(new Error('relay stop failed')) },
        publishers: [{ stop: async () => Promise.reject(new Error('close failed')) }],
        databases: [{ stop: async () => void closed.push('pool') }],
        budgetMs: 1000,
      });
      await expect(shutdown.stop()).rejects.toThrow();
      expect(closed).toEqual(['pool']);
    });
  });

  describe('a failure never ends a phase early (Codex r3 on #458, F7)', () => {
    it('a worker that fails while its sibling still drains: the publishers and the databases begin only after the sibling returned, then the failure is rethrown', async () => {
      const log: string[] = [];
      let finish!: () => void;
      const errors: string[] = [];
      const shutdown = new OutboxShutdown({
        relay: { stop: async () => undefined },
        workers: [
          { stop: async () => Promise.reject(new Error('Kafka disconnect failed')) },
          {
            stop: () =>
              new Promise<void>((resolve) => {
                finish = () => {
                  log.push('WORKER FINISHED');
                  resolve();
                };
              }),
          },
        ],
        publishers: [{ stop: async () => void log.push('PUBLISHER CLOSED') }],
        databases: [{ stop: async () => void log.push('DISCONNECT') }],
        budgetMs: 5_000,
        logger: { error: (message: unknown) => void errors.push(String(message)) },
      });

      const stopping = shutdown.stop();
      const outcome = stopping.then(
        () => 'resolved',
        (error: unknown) => (error as Error).message,
      );
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
      // The rejected sibling ended nothing: the drain still waits.
      expect(log).toEqual([]);
      finish();
      expect(await outcome).toBe('Kafka disconnect failed');
      expect(log).toEqual(['WORKER FINISHED', 'PUBLISHER CLOSED', 'DISCONNECT']);
      expect(errors).toEqual([expect.stringMatching(/phase drain.*Kafka disconnect failed/)]);
    });

    it('a failure in every phase: each phase still ran to the end, every cause is logged and all are rethrown together', async () => {
      const closed: string[] = [];
      const errors: string[] = [];
      const shutdown = new OutboxShutdown({
        relay: { stop: async () => Promise.reject(new Error('relay stop failed')) },
        workers: [{ stop: async () => void closed.push('worker') }],
        publishers: [
          { stop: async () => Promise.reject(new Error('producer close failed')) },
          { stop: async () => void closed.push('publisher') },
        ],
        databases: [
          {
            stop: () => {
              throw new Error('pool close threw');
            },
          },
          { stop: async () => void closed.push('pool') },
        ],
        budgetMs: 1000,
        logger: { error: (message: unknown) => void errors.push(String(message)) },
      });

      const failure = await shutdown.stop().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual([
        'relay stop failed',
        'producer close failed',
        'pool close threw',
      ]);
      expect(closed).toEqual(['worker', 'publisher', 'pool']);
      expect(errors).toEqual([
        expect.stringMatching(/phase drain.*relay stop failed/),
        expect.stringMatching(/phase publishers.*producer close failed/),
        expect.stringMatching(/phase databases.*pool close threw/),
      ]);
    });
  });

  it('refuses a budget that is not a positive integer', () => {
    const relay = { stop: async () => undefined };
    for (const budgetMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => new OutboxShutdown({ relay, budgetMs })).toThrow(/budgetMs/);
    }
  });
});

describe('OutboxRelay.stop with a shared deadline', () => {
  it('ends its grace at the deadline when the deadline comes first', async () => {
    const relay = await relayStuckInPublish(20);
    const ms = await elapsed(() => relay.stop({ deadlineAt: Date.now() + 500 }));
    expect(ms).toBeGreaterThanOrEqual(450);
    expect(ms).toBeLessThan(1500);
  });

  it('does not wait past the deadline for a release that hangs; the rows lapse with their lease', async () => {
    // The batch publish fails, the per-row fallback hangs on the first row:
    // R1 is in flight, R2 and R3 were never sent and are released on stop.
    const { store } = claimingStore(['R1', 'R2', 'R3'], { releaseHangs: true });
    const warnings: string[] = [];
    let first = true;
    const relay = new OutboxRelay({
      store,
      publisher: {
        publish: (rows) => {
          if (rows.length > 1) return Promise.reject(new Error('batch refused'));
          if (first) {
            first = false;
            return never<void>();
          }
          return Promise.resolve();
        },
      },
      shutdownGraceSeconds: 20,
      leaseSeconds: 60,
      logger: {
        debug: () => undefined,
        warn: (_obj, msg) => warnings.push(msg ?? ''),
        error: () => undefined,
      },
    });
    void relay.tick();
    await new Promise((resolve) => setImmediate(resolve));

    const ms = await elapsed(() => relay.stop({ deadlineAt: Date.now() + 300 }));
    expect(ms).toBeLessThan(1000);
    expect(
      warnings.some((msg) => /release did not finish by the shutdown deadline/.test(msg)),
    ).toBe(true);
  });

  it('without a deadline keeps its own grace as before', async () => {
    const relay = await relayStuckInPublish(1);
    const ms = await elapsed(() => relay.stop());
    expect(ms).toBeGreaterThanOrEqual(950);
    expect(ms).toBeLessThan(2000);
  });

  it('start() after a stop arms a new stop', async () => {
    const { store, released } = claimingStore([]);
    const relay = new OutboxRelay({ store, publisher: { publish: async () => undefined } });
    relay.start();
    const first = relay.stop();
    expect(relay.stop()).toBe(first);
    await first;
    relay.start();
    const second = relay.stop();
    expect(second).not.toBe(first);
    await second;
    expect(released).toEqual([]);
  });
});
