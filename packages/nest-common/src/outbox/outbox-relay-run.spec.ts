import { OutboxRelay, type OutboxClaim, type OutboxRow, type OutboxStore } from './outbox';

/**
 * Codex r1 on #280, finding 2: a claim still pending when `stop()` returned
 * resolved afterwards, and the tick installed its ownership, started the
 * heartbeat, published and acknowledged — new work after the stop had returned.
 * Every continuation of a tick or a renewal now checks the run it began in.
 * Codex r1 on #291: stops never overlap (finding 1), and every wait of a stop,
 * the release's included, ends by its bound (finding 2).
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
  const releaseGates: Barrier<void>[] = [];
  let renewGate: Barrier<string[]> | undefined;
  const store = {
    claimPending: jest.fn(
      (): Promise<OutboxClaim> =>
        claims.shift()?.promise ?? Promise.resolve({ token: null, rows: [], reclaimed: 0 }),
    ),
    markPublished: jest.fn(async (ids: readonly string[]) => ids.length),
    markFailed: jest.fn(async () => 1),
    release: jest.fn(async (ids: readonly string[], _token: string, _deadlineMs: number) => {
      await releaseGates.shift()?.promise;
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
    /** Gates the next release not yet gated, in call order. */
    gateRelease(): Barrier<void> {
      const gate = barrier<void>();
      releaseGates.push(gate);
      return gate;
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
    expect(store.release).toHaveBeenCalledWith(['R1', 'R2'], 'tok-1', 20_000);
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
    expect(store.release).toHaveBeenCalledWith(['R1', 'R2', 'R3'], 'tok-1', 20_000);
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
    expect(store.release).toHaveBeenCalledWith(['R2', 'R3'], 'tok-1', 20_000);
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

  it('a stop() during a stop joins it and cancels a start() made in between: one drain, and no run opens until both have returned', async () => {
    // Codex r1 on #291, finding 1. Before: the start() cleared the stop in
    // progress, the second stop() drained the same run again, the first one's
    // return opened a run a forced tick claimed in, and the second one's
    // return ended the old run — so that claim published after it.
    const { store, claim, gateRelease } = gatedStore();
    const { publish, calls } = gatedPublisher();
    const { relay } = relayWith(store, publish, 20);
    const pending = claim();
    const firstRelease = gateRelease();
    const secondRelease = gateRelease();

    const tick = relay.tick();
    const first = relay.stop();
    pending.resolve(claimOf('tok-1', 'R1'));
    expect(await tick).toBe(0);
    await flush();
    await flush();
    expect(store.release).toHaveBeenCalledTimes(1);

    relay.start();
    let secondReturned = false;
    const second = relay.stop().then(() => {
      secondReturned = true;
    });
    await flush();
    // A forced tick while the stop is in progress claims nothing.
    claim(claimOf('tok-2', 'R2'));
    expect(await relay.tick()).toBe(0);
    expect(store.claimPending).toHaveBeenCalledTimes(1);

    firstRelease.resolve();
    await first;
    await flush();
    expect(secondReturned).toBe(true);
    expect(store.release).toHaveBeenCalledTimes(1);

    // The start() was cancelled by the second stop(): nothing polls.
    jest.advanceTimersByTime(2_000);
    await flush();
    expect(store.claimPending).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();

    // Once both have returned the relay is stopped: a forced tick claims
    // nothing until the next start(), which opens a new run that publishes.
    expect(await relay.tick()).toBe(0);
    expect(store.claimPending).toHaveBeenCalledTimes(1);
    relay.start();
    const next = relay.tick();
    await flush();
    calls[0]!.resolve();
    expect(await next).toBe(1);
    expect(store.markPublished).toHaveBeenCalledWith(['R2'], 'tok-2');
    secondRelease.resolve();
    await second;
    await relay.stop();
  });

  it('a stop() after a forced tick that followed a completed stop fences it: the tick claims nothing', async () => {
    // Codex r2 on #291, its sequence exactly. Before: the first stop's return
    // opened a fresh run, the forced tick claimed in it, and the second stop()
    // returned the first one's settled promise without stopping that run — the
    // late claim then published and acknowledged after the second stop returned.
    const { store, claim } = gatedStore();
    const publish = jest.fn(async () => undefined);
    const { relay } = relayWith(store, publish, 20);

    relay.start();
    await relay.stop();
    const pending = claim();
    const forced = relay.tick();
    await relay.stop();

    pending.resolve(claimOf('tok-1', 'R1'));
    expect(await forced).toBe(0);
    jest.advanceTimersByTime(TWO_LEASES_MS);
    await flush();

    expect(store.claimPending).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(store.markPublished).not.toHaveBeenCalled();
    expect(store.renew).not.toHaveBeenCalled();
  });

  it('a forced tick before the first start() is fenced by the stop after that start()', async () => {
    const { store, claim } = gatedStore();
    const publish = jest.fn(async () => undefined);
    const { relay } = relayWith(store, publish, 0);
    const pending = claim();

    const forced = relay.tick();
    relay.start();
    await relay.stop();
    pending.resolve(claimOf('tok-1', 'R1'));
    expect(await forced).toBe(0);
    await flush();

    expect(store.claimPending).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    expect(store.markPublished).not.toHaveBeenCalled();
  });
});

describe('OutboxRelay: every sequence of start, stop, tick and claim (Codex r2 on #291)', () => {
  type Op = 'start' | 'stop' | 'tick' | 'resolve';
  const OPS: readonly Op[] = ['start', 'stop', 'tick', 'resolve'];
  const MAX_LENGTH = 5;

  function* sequences(length: number): Generator<Op[]> {
    if (length === 0) {
      yield [];
      return;
    }
    for (const head of sequences(length - 1)) for (const op of OPS) yield [...head, op];
  }

  /**
   * Model: a tick claims iff none is running and no stop has returned since
   * the last start() (or since construction); a claim publishes and is
   * acknowledged iff no stop returned between its tick and its return.
   */
  async function check(ops: readonly Op[]): Promise<void> {
    const claims: Barrier<OutboxClaim>[] = [];
    const published: string[] = [];
    const store = {
      claimPending: jest.fn((): Promise<OutboxClaim> => {
        const next = barrier<OutboxClaim>();
        claims.push(next);
        return next.promise;
      }),
      markPublished: jest.fn(async (ids: readonly string[]) => {
        published.push(...ids);
        return ids.length;
      }),
      markFailed: jest.fn(async () => 1),
      release: jest.fn(async (ids: readonly string[]) => ids.length),
      renew: jest.fn(async (ids: readonly string[]) => [...ids]),
      oldestPendingAgeSeconds: async () => 0,
    } satisfies OutboxStore;
    const { relay } = relayWith(store, async () => undefined, 0);

    let stopped = false;
    let pending: { tick: Promise<number>; fenced: boolean } | undefined;
    for (const [at, op] of ops.entries()) {
      if (op === 'start') {
        relay.start();
        stopped = false;
      } else if (op === 'stop') {
        await relay.stop();
        stopped = true;
        if (pending) pending.fenced = true;
      } else if (op === 'tick') {
        const before = claims.length;
        const tick = relay.tick();
        const claimsNow = !pending && !stopped;
        expect(claims.length - before).toBe(claimsNow ? 1 : 0);
        if (claimsNow) pending = { tick, fenced: false };
        else expect(await tick).toBe(0);
      } else if (pending) {
        const id = `R${at}`;
        claims.at(-1)!.resolve(claimOf(`tok-${at}`, id));
        expect(await pending.tick).toBe(pending.fenced ? 0 : 1);
        expect(published.includes(id)).toBe(!pending.fenced);
        pending = undefined;
      }
      await flush();
    }
    expect(store.release).not.toHaveBeenCalled();
    expect(store.markFailed).not.toHaveBeenCalled();
    if (pending) claims.at(-1)!.resolve(claimOf('tok-end', 'R-end'));
    await relay.stop();
    await pending?.tick;
  }

  it(`holds for all ${(4 ** (MAX_LENGTH + 1) - 1) / 3} sequences of up to ${MAX_LENGTH} steps`, async () => {
    for (let length = 0; length <= MAX_LENGTH; length += 1) {
      for (const ops of sequences(length)) {
        try {
          await check(ops);
        } catch (error) {
          throw new Error(`sequence [${ops.join(', ')}]: ${String(error)}`);
        }
      }
    }
  });
});

describe('OutboxRelay: a release that does not finish (Codex r1 on #291, finding 2)', () => {
  it.each<[string, () => number | undefined, number]>([
    ['with no deadlineAt, by its grace (20 s)', () => undefined, 20_000],
    ['with deadlineAt 5 s away, by it', () => Date.now() + 5_000, 5_000],
  ])(
    'the stop returns %s, abandoning the release to the lease',
    async (_how, deadlineAt, boundMs) => {
      const { store, claim, gateRelease } = gatedStore();
      const { publish } = gatedPublisher();
      const { relay, warnings } = relayWith(store, publish, 20);
      const pending = claim();
      gateRelease(); // blocked, as on a row lock, and never let go

      const tick = relay.tick();
      const at = deadlineAt();
      let returned = false;
      const stopping = relay.stop(at === undefined ? {} : { deadlineAt: at }).then(() => {
        returned = true;
      });
      pending.resolve(claimOf('tok-1', 'R1', 'R2'));
      expect(await tick).toBe(0);
      await flush();
      await flush();
      // The store's own statement timeout is what is left of the bound.
      expect(store.release).toHaveBeenCalledWith(['R1', 'R2'], 'tok-1', boundMs);

      jest.advanceTimersByTime(boundMs - 1);
      await flush();
      expect(returned).toBe(false);
      jest.advanceTimersByTime(1);
      await stopping;

      expect(warnings).toContainEqual(
        expect.stringMatching(/release did not finish by the shutdown deadline.*lease expires/),
      );
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it('with nothing left of its bound, the stop does not begin the release', async () => {
    const { store, claim } = gatedStore();
    const { publish, calls } = gatedPublisher();
    const { relay, warnings } = relayWith(store, publish, 0);
    claim(claimOf('tok-1', 'R1', 'R2', 'R3'));

    const tick = relay.tick();
    await flush();
    calls[0]!.reject(new Error('batch refused'));
    await flush();
    // R1 alone is in flight; R2 and R3 were never sent.
    expect(publish).toHaveBeenCalledTimes(2);

    await relay.stop();
    expect(store.release).not.toHaveBeenCalled();
    expect(warnings).toContainEqual(
      expect.stringMatching(/release did not finish by the shutdown deadline/),
    );

    calls[1]!.resolve();
    expect(await tick).toBe(0);
    expect(store.release).not.toHaveBeenCalled();
    expect(store.markPublished).not.toHaveBeenCalled();
  });
});
