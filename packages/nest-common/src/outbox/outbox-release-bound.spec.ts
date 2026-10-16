import {
  OutboxRelay,
  OutboxReleaseAbandoned,
  releaseWithin,
  type OutboxClaim,
  type OutboxReleaseBound,
  type OutboxRow,
  type OutboxStore,
} from './outbox';
import { releaseSql, type OutboxSqlClient, type OutboxTxRunner } from './outbox-sql';

/**
 * Codex r3 on #291: a release the stop had stopped waiting for still acquired
 * its connection afterwards and issued `SET LOCAL` and the UPDATE — with a
 * budget fixed before the wait, and with `maxWait` at that budget plus the
 * transaction margin. The release now reads the stop's bound after acquiring
 * its connection and before each statement, and writes nothing once it is
 * spent (`boundedReleaseSql`).
 *
 * The real relay and the real `releaseSql`; only the transaction runner is a
 * fake, and every step of it — the pool handing out the connection, each
 * statement's round trip — is a barrier the test opens. Fake timers and a fake
 * `Date`, so the clock moves only when the test moves it.
 */

const row = (id: string): OutboxRow => ({
  id,
  aggregateType: 'Probe',
  aggregateId: id,
  eventName: 'PROBE',
  eventVersion: 1,
  topic: 'rasta.release-bound-spec.v1',
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

function barrier<T = void>(): Barrier<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type Step = 'acquire' | 'set' | 'update' | 'commit';

/**
 * A database as the release sees it: a pool, one transaction, two statements
 * and the COMMIT. Each step in `gated` waits for the test to open it (or to
 * fail it); every statement issued, the timeout the runner was given and how
 * each transaction ended are recorded.
 */
function gatedDatabase(gated: readonly Step[]) {
  const gates = new Map<Step, Barrier<void>>(gated.map((step) => [step, barrier()]));
  const passed = (step: Step): Promise<void> => gates.get(step)?.promise ?? Promise.resolve();
  const statements: string[] = [];
  const runnerTimeoutsMs: number[] = [];
  const ended: ('COMMIT' | 'ROLLBACK')[] = [];

  const tx: OutboxSqlClient = {
    $queryRawUnsafe: async () => {
      throw new Error('release issues no query');
    },
    $executeRawUnsafe: async (query: string, ...values: unknown[]) => {
      statements.push(query.replace(/\s+/g, ' ').trim());
      if (query.startsWith('SET LOCAL')) {
        await passed('set');
        return 0;
      }
      await passed('update');
      return (values[0] as string[]).length;
    },
  };

  const runTransaction: OutboxTxRunner = async (fn, timeoutMs) => {
    runnerTimeoutsMs.push(timeoutMs);
    await passed('acquire');
    let result: Awaited<ReturnType<typeof fn>>;
    try {
      result = await fn(tx);
    } catch (error) {
      ended.push('ROLLBACK');
      throw error;
    }
    await passed('commit');
    ended.push('COMMIT');
    return result;
  };

  return {
    runTransaction,
    statements,
    runnerTimeoutsMs,
    ended,
    open(step: Step): void {
      gates.get(step)!.resolve();
    },
    fail(step: Step, error: Error): void {
      gates.get(step)!.reject(error);
    },
  };
}

/** A store whose one claim is `claim`, and whose release is the real `releaseSql`. */
function storeOver(db: ReturnType<typeof gatedDatabase>, claim: Barrier<OutboxClaim>) {
  let claimed = false;
  const store = {
    claimPending: jest.fn((): Promise<OutboxClaim> => {
      if (claimed) return Promise.resolve({ token: null, rows: [], reclaimed: 0 });
      claimed = true;
      return claim.promise;
    }),
    markPublished: jest.fn(async (ids: readonly string[]) => ids.length),
    markFailed: jest.fn(async () => 1),
    release: jest.fn((ids: readonly string[], token: string, bound: OutboxReleaseBound) =>
      releaseSql(db.runTransaction, ids, token, bound),
    ),
    renew: jest.fn(async (ids: readonly string[]) => [...ids]),
    oldestPendingAgeSeconds: async () => 0,
  } satisfies OutboxStore;
  return store;
}

function relayOver(store: OutboxStore, graceSeconds: number, now?: () => number) {
  const logged: string[] = [];
  const onFenced = jest.fn();
  const relay = new OutboxRelay({
    store,
    publisher: { publish: jest.fn(async () => undefined) },
    leaseSeconds: 4,
    shutdownGraceSeconds: graceSeconds,
    onFenced,
    now,
    logger: {
      debug: (_obj, msg) => logged.push(`debug ${msg ?? ''}`),
      warn: (_obj, msg) => logged.push(`warn ${msg ?? ''}`),
      error: (_obj, msg) => logged.push(`error ${msg ?? ''}`),
    },
  });
  return { relay, logged, onFenced };
}

const UPDATE = /^UPDATE outbox_message SET claim_token = NULL/;

/**
 * Codex's sequence: a forced tick waits for its claim; `stop()` begins with a
 * grace of `graceSeconds`; the claim returns at once, so its rows are the
 * stop's to release. Returns once the release has asked for its connection.
 */
async function stopReleasing(
  db: ReturnType<typeof gatedDatabase>,
  options: { graceSeconds: number; deadlineAt?: number; now?: () => number },
) {
  const claim = barrier<OutboxClaim>();
  const store = storeOver(db, claim);
  const harness = relayOver(store, options.graceSeconds, options.now);
  const tick = harness.relay.tick();
  let returned = false;
  const stopping = harness.relay
    .stop(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt })
    .then(() => {
      returned = true;
    });
  claim.resolve({ token: 'tok-1', rows: [row('R1'), row('R2')], reclaimed: 0 });
  expect(await tick).toBe(0);
  await flush();
  await flush();
  expect(store.release).toHaveBeenCalledTimes(1);
  return { ...harness, store, stopping, returned: () => returned };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('OutboxRelay: a release whose connection arrives after stop() has returned (Codex r3 on #291)', () => {
  it('issues no statement, and the transaction it was handed ends in a rollback of nothing', async () => {
    const db = gatedDatabase(['acquire']);
    const { stopping, returned, logged, onFenced } = await stopReleasing(db, { graceSeconds: 2 });

    // The pool's wait is what is left of the stop's bound, not that plus a margin.
    expect(db.runnerTimeoutsMs).toEqual([2_000]);

    jest.advanceTimersByTime(2_000);
    await stopping;
    expect(returned()).toBe(true);
    const loggedByStop = [...logged];

    // 3 s: the connection arrives, a second after the stop returned.
    jest.advanceTimersByTime(1_000);
    db.open('acquire');
    await flush();
    await flush();

    expect(db.statements).toEqual([]);
    expect(db.ended).toEqual(['ROLLBACK']);
    // Nor does its outcome reach the relay: no fencing counted, nothing logged.
    expect(onFenced).not.toHaveBeenCalled();
    expect(logged).toEqual(loggedByStop);
    expect(loggedByStop).toContainEqual(
      expect.stringMatching(/release did not finish by the shutdown deadline/),
    );
  });

  it('with the shared deadlineAt, by that deadline in the same way', async () => {
    const db = gatedDatabase(['acquire']);
    const { stopping } = await stopReleasing(db, {
      graceSeconds: 20,
      deadlineAt: Date.now() + 5_000,
    });
    expect(db.runnerTimeoutsMs).toEqual([5_000]);

    jest.advanceTimersByTime(5_000);
    await stopping;
    db.open('acquire');
    await flush();
    await flush();

    expect(db.statements).toEqual([]);
    expect(db.ended).toEqual(['ROLLBACK']);
  });

  it('is fenced by the stop having stopped waiting, not by the clock', async () => {
    // A clock that never moves: by it the bound would never be spent. The
    // stop's own wait still ends (on the timers), and that alone fences.
    const db = gatedDatabase(['acquire']);
    const { stopping, store } = await stopReleasing(db, { graceSeconds: 2, now: () => 0 });

    jest.advanceTimersByTime(2_000);
    await stopping;
    expect(store.release.mock.calls[0]![2].remainingMs()).toBe(0);
    db.open('acquire');
    await flush();
    await flush();

    expect(db.statements).toEqual([]);
    expect(db.ended).toEqual(['ROLLBACK']);
  });
});

describe('OutboxRelay: a release that begins before its bound and ends after it (Codex r3 on #291)', () => {
  it('a connection late within the bound gets what is left of it as its statement timeout', async () => {
    const db = gatedDatabase(['acquire']);
    const { stopping, returned, onFenced } = await stopReleasing(db, { graceSeconds: 2 });

    jest.advanceTimersByTime(1_500);
    db.open('acquire');
    await stopping;

    expect(returned()).toBe(true);
    expect(db.statements[0]).toBe('SET LOCAL statement_timeout = 500');
    expect(db.statements[1]).toMatch(UPDATE);
    expect(db.statements).toHaveLength(2);
    expect(db.ended).toEqual(['COMMIT']);
    expect(onFenced).not.toHaveBeenCalled();
  });

  it('a SET LOCAL still in its round trip when the stop returns is followed by no UPDATE', async () => {
    const db = gatedDatabase(['set']);
    const { stopping } = await stopReleasing(db, { graceSeconds: 2 });
    expect(db.statements).toEqual(['SET LOCAL statement_timeout = 2000']);

    jest.advanceTimersByTime(2_000);
    await stopping;
    db.open('set');
    await flush();
    await flush();

    expect(db.statements).toEqual(['SET LOCAL statement_timeout = 2000']);
    expect(db.ended).toEqual(['ROLLBACK']);
  });

  it('an UPDATE that returns after the stop has returned is rolled back, not committed', async () => {
    const db = gatedDatabase(['update']);
    const { stopping, logged, onFenced } = await stopReleasing(db, { graceSeconds: 2 });
    expect(db.statements[1]).toMatch(UPDATE);

    jest.advanceTimersByTime(2_000);
    await stopping;
    const loggedByStop = [...logged];
    db.open('update');
    await flush();
    await flush();

    expect(db.statements).toHaveLength(2);
    expect(db.ended).toEqual(['ROLLBACK']);
    expect(onFenced).not.toHaveBeenCalled();
    expect(logged).toEqual(loggedByStop);
  });

  it('an UPDATE that fails after the stop has returned is not reported by the stopped relay', async () => {
    const db = gatedDatabase(['update']);
    const { stopping, logged } = await stopReleasing(db, { graceSeconds: 2 });

    jest.advanceTimersByTime(2_000);
    await stopping;
    const loggedByStop = [...logged];
    db.fail('update', new Error('canceling statement due to statement timeout (57014)'));
    await flush();
    await flush();

    expect(db.ended).toEqual(['ROLLBACK']);
    expect(logged).toEqual(loggedByStop);
  });

  it('the residual: an UPDATE that returned in time but whose COMMIT lands after the stop returned commits, and the relay records nothing of it', async () => {
    // The one write after the stop (ADR-050 §Shutdown): issued and finished in
    // time, so the stop has nothing to fence — only the commit is late.
    const db = gatedDatabase(['commit']);
    const { stopping, logged, onFenced } = await stopReleasing(db, { graceSeconds: 2 });
    expect(db.statements).toHaveLength(2);

    jest.advanceTimersByTime(2_000);
    await stopping;
    const loggedByStop = [...logged];
    db.open('commit');
    await flush();
    await flush();

    expect(db.ended).toEqual(['COMMIT']);
    expect(onFenced).not.toHaveBeenCalled();
    expect(logged).toEqual(loggedByStop);
  });

  it('a bound found spent before the stop has stopped waiting is reported as unfinished, not as a failure', async () => {
    // The clock passes the deadline before the stop's own timer has fired:
    // the store refuses first, and the stop says what happened — the lease.
    const db = gatedDatabase(['acquire']);
    const { stopping, logged } = await stopReleasing(db, { graceSeconds: 2 });

    jest.setSystemTime(Date.now() + 2_000);
    db.open('acquire');
    await stopping;

    expect(db.statements).toEqual([]);
    expect(logged).toContainEqual(
      expect.stringMatching(/release did not finish by the shutdown deadline/),
    );
    expect(logged).not.toContainEqual(expect.stringMatching(/release failed/));
  });
});

describe('releaseSql: the bound', () => {
  it('already spent: no transaction is begun', async () => {
    const db = gatedDatabase([]);
    await expect(releaseSql(db.runTransaction, ['R1'], 'tok-1', releaseWithin(0))).rejects.toThrow(
      OutboxReleaseAbandoned,
    );
    expect(db.runnerTimeoutsMs).toEqual([]);
    expect(db.statements).toEqual([]);
  });

  it('spent while the pool made it wait: the transaction issues nothing', async () => {
    const db = gatedDatabase(['acquire']);
    const releasing = releaseSql(db.runTransaction, ['R1'], 'tok-1', releaseWithin(300));
    expect(db.runnerTimeoutsMs).toEqual([300]);

    jest.advanceTimersByTime(300);
    db.open('acquire');
    await expect(releasing).rejects.toThrow(OutboxReleaseAbandoned);
    expect(db.statements).toEqual([]);
    expect(db.ended).toEqual(['ROLLBACK']);
  });

  it('with time left at every step: SET LOCAL to what is left, the UPDATE, and a commit', async () => {
    const db = gatedDatabase(['acquire']);
    const releasing = releaseSql(db.runTransaction, ['R1', 'R2'], 'tok-1', releaseWithin(300));

    jest.advanceTimersByTime(120);
    db.open('acquire');
    expect(await releasing).toBe(2);
    expect(db.runnerTimeoutsMs).toEqual([300]);
    expect(db.statements[0]).toBe('SET LOCAL statement_timeout = 180');
    expect(db.statements[1]).toMatch(UPDATE);
    expect(db.ended).toEqual(['COMMIT']);
  });

  it('nothing to release: no transaction, whatever the bound', async () => {
    const db = gatedDatabase([]);
    expect(await releaseSql(db.runTransaction, [], 'tok-1', releaseWithin(0))).toBe(0);
    expect(db.runnerTimeoutsMs).toEqual([]);
  });
});
