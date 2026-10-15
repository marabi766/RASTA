import { OutboxRelay, type OutboxClaim, type OutboxRow, type OutboxStore } from './outbox';

/**
 * Codex r1 on #280, finding 2: a claim still pending when `stop()` returned
 * resolved afterwards, and the tick installed its ownership, started the
 * heartbeat, published and acknowledged — new work after the stop had returned.
 * Every continuation of a tick or a renewal now checks the run it began in.
 *
 * Deterministic: each store call and each publish is a barrier the test opens,
 * and the heartbeat runs on fake timers. Real `setImmediate`, which the stop's
 * wait loop and `flush()` use.
 */

const row = (id: string): OutboxRow => ({
  id,
  aggregateType: 'Probe',
  aggregateId: id,
  eventName: 'PROBE',
  eventVersion: 1,
  topic: 'rasta.relay-run-spec.v1',
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

interface Barrier<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function barrier<T>(): Barrier<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const claimOf = (token: string, ...ids: string[]): OutboxClaim => ({
  token,
  rows: ids.map(row),
  reclaimed: 0,
});

/**
 * A store whose claims are barriers: `claimPending` hands out the next one in
 * `claims` (an empty claim once they run out). Every mutation is recorded.
 */
function gatedStore() {
  const claims: Barrier<OutboxClaim>[] = [];
  let releaseGate: Barrier<void> | undefined;
  let renewGate: Barrier<string[]> | undefined;
  const store = {
    claimPending: jest.fn(
      (): Promise<OutboxClaim> =>
        claims.shift()?.promise ?? Promise.resolve({ token: null, rows: [], reclaimed: 0 }),
    ),
    markPublished: jest.fn(async (ids: readonly string[]) => ids.length),
    markFailed: jest.fn(async () => 1),
    release: jest.fn(async (ids: readonly string[]) => {
      await releaseGate?.promise;
      return ids.length;
    }),
    renew: jest.fn((ids: readonly string[]) => renewGate?.promise ?? Promise.resolve([...ids])),
    oldestPendingAgeSeconds: async () => 0,
  } satisfies OutboxStore;
  return {
    store,
    /** Queues a claim the test resolves; `resolveNow` hands it out already resolved. */
    claim(resolveNow?: OutboxClaim): Barrier<OutboxClaim> {
      const next = barrier<OutboxClaim>();
      if (resolveNow) next.resolve(resolveNow);
      claims.push(next);
      return next;
    },
    gateRelease(): Barrier<void> {
      releaseGate = barrier<void>();
      return releaseGate;
    },
    gateRenew(): Barrier<string[]> {
      renewGate = barrier<string[]>();
      return renewGate;
    },
  };
}

/** A publisher whose calls are barriers, opened in call order. */
function gatedPublisher() {
  const calls: Barrier<void>[] = [];
  const publish = jest.fn((_rows: readonly OutboxRow[]): Promise<void> => {
    const call = barrier<void>();
    calls.push(call);
    return call.promise;
  });
  return { publish, calls };
}

const LEASE_SECONDS = 4;
/** Two whole leases: a heartbeat (every lease / 4) would renew several times. */
const TWO_LEASES_MS = 2 * LEASE_SECONDS * 1000;

function relayWith(
  store: OutboxStore,
  publish: (rows: readonly OutboxRow[]) => Promise<void>,
  graceSeconds: number,
) {
  const warnings: string[] = [];
  const onFenced = jest.fn();
  const relay = new OutboxRelay({
    store,
    publisher: { publish },
    leaseSeconds: LEASE_SECONDS,
    shutdownGraceSeconds: graceSeconds,
    onFenced,
    logger: {
      debug: () => undefined,
      warn: (_obj, msg) => warnings.push(msg ?? ''),
      error: () => undefined,
    },
  });
  return { relay, warnings, onFenced };
}

/** Stops the two ways a stop returns while a tick is still running. */
const STOPS_PAST_THEIR_DEADLINE: [string, number, (relay: OutboxRelay) => Promise<void>][] = [
  ['its own grace (0 s) is spent', 0, (relay) => relay.stop()],
  ['the shared deadline has passed', 20, (relay) => relay.stop({ deadlineAt: Date.now() })],
];

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('OutboxRelay: a claim that returns after its stop', () => {
  it.each(STOPS_PAST_THEIR_DEADLINE)(
    'once stop() has returned (%s) publishes, acknowledges, renews and releases nothing',
    async (_how, graceSeconds, stop) => {
      const { store, claim } = gatedStore();
      const { publish } = gatedPublisher();
      const { relay, warnings } = relayWith(store, publish, graceSeconds);
      const pending = claim();

      const tick = relay.tick();
      expect(store.claimPending).toHaveBeenCalledTimes(1);
      await stop(relay);

      pending.resolve(claimOf('tok-1', 'R1', 'R2'));
      expect(await tick).toBe(0);
      jest.advanceTimersByTime(TWO_LEASES_MS);
      await flush();

      expect(publish).not.toHaveBeenCalled();
      expect(store.markPublished).not.toHaveBeenCalled();
      expect(store.markFailed).not.toHaveBeenCalled();
      expect(store.renew).not.toHaveBeenCalled();
      // Left to their lease: the stop's deadline is already behind it.
      expect(store.release).not.toHaveBeenCalled();
      expect(warnings).toContainEqual(
        expect.stringMatching(/claim returned after the relay had stopped.*lease expires/),
      );
    },
  );

  it('while the stop still waits is released by it, unsent, and never renewed', async () => {
    const { store, claim } = gatedStore();
    const { publish } = gatedPublisher();
    const { relay } = relayWith(store, publish, 20);
    const pending = claim();

    const tick = relay.tick();
    let stopped = false;
    const stopping = relay.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);

    pending.resolve(claimOf('tok-1', 'R1', 'R2'));
    expect(await tick).toBe(0);
    await stopping;
    jest.advanceTimersByTime(TWO_LEASES_MS);
    await flush();

    expect(store.release).toHaveBeenCalledTimes(1);
    expect(store.release).toHaveBeenCalledWith(['R1', 'R2'], 'tok-1');
    expect(publish).not.toHaveBeenCalled();
    expect(store.markPublished).not.toHaveBeenCalled();
    expect(store.renew).not.toHaveBeenCalled();
  });

  it('no claim starts while a stop is in progress', async () => {
    const { store, claim, gateRelease } = gatedStore();
    const { publish } = gatedPublisher();
    const { relay } = relayWith(store, publish, 20);
    const pending = claim();
    const release = gateRelease();

    const tick = relay.tick();
    const stopping = relay.stop();
    pending.resolve(claimOf('tok-1', 'R1'));
    expect(await tick).toBe(0);
    await flush();
    await flush();
    // The stop is releasing R1; no tick is running, and none may claim.
    expect(store.release).toHaveBeenCalledTimes(1);
    claim(claimOf('tok-2', 'R2'));
    expect(await relay.tick()).toBe(0);
    expect(store.claimPending).toHaveBeenCalledTimes(1);

    release.resolve();
    await stopping;
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('OutboxRelay: a publish in flight at the stop', () => {
  it('that returns while the stop waits is acknowledged, and renewed until then', async () => {
    const { store, claim } = gatedStore();
    const { publish, calls } = gatedPublisher();
    const { relay } = relayWith(store, publish, 20);
    claim(claimOf('tok-1', 'R1'));

    const tick = relay.tick();
    await flush();
    expect(publish).toHaveBeenCalledTimes(1);
    const stopping = relay.stop();

    // The heartbeat keeps the lease while the stop waits: what the fake timers
    // show here is what the late-claim tests above show did not happen.
    jest.advanceTimersByTime(LEASE_SECONDS * 1000);
    expect(store.renew).toHaveBeenCalled();

    calls[0]!.resolve();
    expect(await tick).toBe(1);
    await stopping;
    expect(store.markPublished).toHaveBeenCalledWith(['R1'], 'tok-1');
    expect(store.release).not.toHaveBeenCalled();
  });

  it.each([
    ['returns', (call: Barrier<void>) => call.resolve()],
    ['fails', (call: Barrier<void>) => call.reject(new Error('broker refused'))],
  ])(
    'that %s after stop() has returned is neither acknowledged nor failed, and is not retried',
    async (_how, settle) => {
      const { store, claim } = gatedStore();
      const { publish, calls } = gatedPublisher();
      const { relay, warnings, onFenced } = relayWith(store, publish, 0);
      claim(claimOf('tok-1', 'R1', 'R2'));

      const tick = relay.tick();
      await flush();
      await relay.stop();

      settle(calls[0]!);
      expect(await tick).toBe(0);
      await flush();

      // One batch, no per-row fallback; nothing written: the rows wait for
      // their lease, and a copy that reached the broker is delivered again.
      expect(publish).toHaveBeenCalledTimes(1);
      expect(store.markPublished).not.toHaveBeenCalled();
      expect(store.markFailed).not.toHaveBeenCalled();
      expect(store.release).not.toHaveBeenCalled();
      expect(onFenced).not.toHaveBeenCalled();
      expect(warnings).toContainEqual(
        expect.stringMatching(/publish returned after the relay had stopped.*not acknowledged/),
      );
      expect(warnings).not.toContainEqual(expect.stringMatching(/retrying rows individually/));
    },
  );

  it('a batch refused while the stop waits sends no row on its own; the stop releases them', async () => {
    const { store, claim } = gatedStore();
    const { publish, calls } = gatedPublisher();
    const { relay } = relayWith(store, publish, 20);
    claim(claimOf('tok-1', 'R1', 'R2', 'R3'));

    const tick = relay.tick();
    await flush();
    const stopping = relay.stop();
    calls[0]!.reject(new Error('batch refused'));
    expect(await tick).toBe(0);
    await stopping;

    expect(publish).toHaveBeenCalledTimes(1);
    expect(store.markFailed).not.toHaveBeenCalled();
    expect(store.release).toHaveBeenCalledWith(['R1', 'R2', 'R3'], 'tok-1');
  });

  it('in the per-row fallback, no further row is sent once the stop has begun', async () => {
    const { store, claim } = gatedStore();
    const { publish, calls } = gatedPublisher();
    const { relay } = relayWith(store, publish, 20);
    claim(claimOf('tok-1', 'R1', 'R2', 'R3'));

    const tick = relay.tick();
    await flush();
    calls[0]!.reject(new Error('batch refused'));
    await flush();
    // R1 alone is in flight.
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'R1' })]);

    const stopping = relay.stop();
    calls[1]!.resolve();
    expect(await tick).toBe(1);
    await stopping;

    expect(publish).toHaveBeenCalledTimes(2);
    expect(store.markPublished).toHaveBeenCalledWith(['R1'], 'tok-1');
    expect(store.release).toHaveBeenCalledWith(['R2', 'R3'], 'tok-1');
  });
});

describe('OutboxRelay: a renewal pending when stop() returns', () => {
  it.each([
    ['returns with every row lost', (gate: Barrier<string[]>) => gate.resolve([])],
    ['fails', (gate: Barrier<string[]>) => gate.reject(new Error('connection reset'))],
  ])('%s: changes nothing and is not retried', async (_how, settle) => {
    const { store, claim, gateRenew } = gatedStore();
    const { publish } = gatedPublisher();
    const { relay, warnings, onFenced } = relayWith(store, publish, 0);
    claim(claimOf('tok-1', 'R1', 'R2'));

    void relay.tick();
    await flush();
    const renewal = gateRenew();
    const renewing = relay.renewOnce();
    await relay.stop();

    settle(renewal);
    await renewing;

    expect(store.renew).toHaveBeenCalledTimes(1);
    expect(onFenced).not.toHaveBeenCalled();
    expect(warnings).not.toContainEqual(expect.stringMatching(/lease (partially lost|renewal)/));
  });
});

describe('OutboxRelay: the next run', () => {
  it('start() after a stop whose claim is still pending: the late claim touches nothing, the new run publishes', async () => {
    const { store, claim } = gatedStore();
    const { publish, calls } = gatedPublisher();
    const { relay } = relayWith(store, publish, 0);
    const late = claim();

    const oldTick = relay.tick();
    await relay.stop();
    relay.start();

    // The old tick still holds the relay's one tick slot.
    expect(await relay.tick()).toBe(0);
    expect(store.claimPending).toHaveBeenCalledTimes(1);

    late.resolve(claimOf('tok-1', 'R1'));
    expect(await oldTick).toBe(0);

    claim(claimOf('tok-2', 'R2'));
    const tick = relay.tick();
    await flush();
    calls[0]!.resolve();
    expect(await tick).toBe(1);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith([expect.objectContaining({ id: 'R2' })]);
    expect(store.markPublished).toHaveBeenCalledTimes(1);
    expect(store.markPublished).toHaveBeenCalledWith(['R2'], 'tok-2');
    expect(store.release).not.toHaveBeenCalled();
    await relay.stop();
  });

  it('start() while a stop is still settling claims nothing until that stop has returned', async () => {
    const { store, claim, gateRelease } = gatedStore();
    const { publish, calls } = gatedPublisher();
    const { relay } = relayWith(store, publish, 20);
    const pending = claim();
    const release = gateRelease();

    const tick = relay.tick();
    const stopping = relay.stop();
    pending.resolve(claimOf('tok-1', 'R1'));
    expect(await tick).toBe(0);
    await flush();
    await flush();
    expect(store.release).toHaveBeenCalledTimes(1);

    // Restarted while the stop is still releasing R1: the poll timer runs, but
    // claims nothing in the run that is stopping.
    relay.start();
    claim(claimOf('tok-2', 'R2'));
    jest.advanceTimersByTime(2_000);
    await flush();
    expect(store.claimPending).toHaveBeenCalledTimes(1);

    release.resolve();
    await stopping;
    jest.advanceTimersByTime(500);
    await flush();
    expect(store.claimPending).toHaveBeenCalledTimes(2);
    calls[0]!.resolve();
    await flush();
    expect(store.markPublished).toHaveBeenCalledWith(['R2'], 'tok-2');
    await relay.stop();
  });

  it('a tick after a stop — an operator forcing a drain — still publishes', async () => {
    const { store, claim } = gatedStore();
    const publish = jest.fn(async () => undefined);
    const { relay } = relayWith(store, publish, 0);

    relay.start();
    await relay.stop();
    claim(claimOf('tok-1', 'R1'));
    expect(await relay.tick()).toBe(1);
    expect(store.markPublished).toHaveBeenCalledWith(['R1'], 'tok-1');
  });
});
