import {
  RevocationFeed,
  type RevocationLogMessage,
  type RevocationLogSource,
} from './revocation-feed';
import { RevocationGate } from './revocation-gate';
import { RevocationList, revocationTiming } from './revocation-list';

/**
 * Start, restart and currency of one replica's list (ADR-060, gateway revocation list addendum
 * § 4 and § 5), against an in-memory identity topic whose delivery the test drives.
 */

const T0 = Date.parse('2026-10-24T10:00:00.000Z');
const timing = revocationTiming(900, 5, 10);

let nextSeq = 0;

function event(eventName: string, userId: string, organizationId: string, occurredAtMs: number) {
  return JSON.stringify({
    eventId: `E-${userId}-${occurredAtMs}`,
    eventName,
    eventVersion: 1,
    occurredAt: new Date(occurredAtMs).toISOString(),
    producer: 'identity-service',
    aggregateType: 'Membership',
    aggregateId: 'M1',
    tenantId: organizationId,
    correlationId: 'COR-1',
    streamSeq: (nextSeq += 1),
    streamKey: 'M1',
    payload: { membershipId: 'M1', userId, organizationId, reason: 'kept out of every log' },
  });
}

/**
 * One event of membership `membershipId` of U1 in ORG_A, as identity-service writes it: on the
 * membership's own stream (partition key = aggregate id = membership id), at position `seq`,
 * stamped `atMs` by whichever replica's clock committed it.
 */
function membershipEvent(
  eventName:
    | 'MEMBERSHIP_CREATED'
    | 'ROLE_ASSIGNED'
    | 'ROLE_REVOKED'
    | 'MEMBERSHIP_REVOKED'
    | 'MEMBERSHIP_EXPIRED',
  options: { membershipId?: string; seq: number; atMs: number; roles?: string[] },
  overrides: Record<string, unknown> = {},
) {
  const membershipId = options.membershipId ?? 'M1';
  const pair = { membershipId, userId: 'U1', organizationId: 'ORG_A' };
  const roles = options.roles ?? [];
  const payload =
    eventName === 'MEMBERSHIP_CREATED'
      ? { ...pair, roles }
      : eventName === 'ROLE_ASSIGNED' || eventName === 'ROLE_REVOKED'
        ? { ...pair, previousRoles: [], newRoles: roles, reason: 'x' }
        : eventName === 'MEMBERSHIP_REVOKED'
          ? { ...pair, reason: 'x' }
          : { ...pair, validUntil: new Date(options.atMs).toISOString() };
  return JSON.stringify({
    eventId: `E-${membershipId}-${options.seq}`,
    eventName,
    eventVersion: 1,
    occurredAt: new Date(options.atMs).toISOString(),
    producer: 'identity-service',
    aggregateType: 'Membership',
    aggregateId: membershipId,
    tenantId: 'ORG_A',
    correlationId: 'COR-1',
    streamSeq: options.seq,
    streamKey: membershipId,
    payload,
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const revoked = (userId: string, organizationId: string, atMs: number) =>
  event('MEMBERSHIP_REVOKED', userId, organizationId, atMs);

/** A topic of N partitions; records carry a broker timestamp. */
class FakeTopic implements RevocationLogSource {
  readonly partitions: { timestampMs: number; value: string | null }[][];
  failHighWatermarks = false;
  /** When set, the next `highWatermarks` waits for it. */
  nextHighWatermarks: Promise<void> | undefined;
  /** When set, the next `start` waits for it. */
  nextStart: Promise<void> | undefined;
  /** When set, `stop` waits for it. */
  nextStop: Promise<void> | undefined;
  startedFrom: Map<number, number> | undefined;
  startCalls = 0;
  stopCalls = 0;
  /** Every pair of callbacks `start` was given, oldest first: a reader may still call them late. */
  readonly callbacks: {
    onMessage: (message: RevocationLogMessage) => void;
    onFailure: (error: unknown) => void;
  }[] = [];
  private delivered = new Map<number, number>();
  private onMessage: ((message: RevocationLogMessage) => void) | undefined;
  onFailure: ((error: unknown) => void) | undefined;

  constructor(count: number) {
    this.partitions = Array.from({ length: count }, () => []);
  }

  publish(partition: number, timestampMs: number, value: string | null): void {
    this.partitions[partition]!.push({ timestampMs, value });
  }

  async highWatermarks() {
    const wait = this.nextHighWatermarks;
    this.nextHighWatermarks = undefined;
    // Read before waiting: the reading is of the moment the probe was made.
    const high = new Map(this.partitions.map((records, partition) => [partition, records.length]));
    if (wait) await wait;
    if (this.failHighWatermarks) throw new Error('broker unreachable');
    return high;
  }

  async offsetsAt(timestampMs: number) {
    return new Map(
      this.partitions.map((records, partition) => {
        const index = records.findIndex((record) => record.timestampMs >= timestampMs);
        return [partition, index === -1 ? records.length : index];
      }),
    );
  }

  async start(
    from: Map<number, number>,
    onMessage: (message: RevocationLogMessage) => void,
    onFailure: (error: unknown) => void,
  ) {
    this.startCalls += 1;
    this.startedFrom = new Map(from);
    this.delivered = new Map(from);
    this.onMessage = onMessage;
    this.onFailure = onFailure;
    this.callbacks.push({ onMessage, onFailure });
    const wait = this.nextStart;
    this.nextStart = undefined;
    if (wait) await wait;
  }

  async stop() {
    this.stopCalls += 1;
    this.onMessage = undefined;
    if (this.nextStop) await this.nextStop;
  }

  /** Delivers every record not yet delivered, partition by partition. */
  pump(): void {
    for (const [partition, records] of this.partitions.entries()) {
      for (let offset = this.delivered.get(partition) ?? 0; offset < records.length; offset += 1) {
        this.onMessage?.({ partition, offset, ...records[offset]! });
        this.delivered.set(partition, offset + 1);
      }
    }
  }
}

function replica(topic: FakeTopic, clock: { now: number }, maxEntries = 1_000) {
  const list = new RevocationList(timing, maxEntries);
  const logger = { warn: jest.fn(), error: jest.fn() };
  const feed = new RevocationFeed(topic, list, {
    maxStalenessMs: 30_000,
    probeIntervalMs: 5_000,
    now: () => clock.now,
    logger,
  });
  const gate = RevocationGate.enforce(list, feed, { retryAfterSeconds: 1, now: () => clock.now });
  return { list, feed, logger, gate };
}

const tokenOf = (userId: string, organizationId: string, issuedAtMs: number) => ({
  userId,
  organizationId,
  issuedAtMs,
  tenantRoles: ['DRIVER'],
});

describe('start: a bounded replay of every partition', () => {
  it('reads every partition from the start of the window, and nothing older', async () => {
    const clock = { now: T0 };
    const topic = new FakeTopic(3);
    topic.publish(
      0,
      T0 - timing.retentionMs - 1,
      revoked('OLD', 'ORG_A', T0 - timing.retentionMs - 1),
    );
    topic.publish(0, T0 - 600_000, revoked('U1', 'ORG_A', T0 - 600_000));
    topic.publish(2, T0 - 10_000, revoked('U2', 'ORG_B', T0 - 10_000));

    const { list, feed } = replica(topic, clock);
    await feed.start();

    expect(topic.startedFrom).toEqual(
      new Map([
        [0, 1],
        [1, 0],
        [2, 0],
      ]),
    );
    topic.pump();
    expect(list.evaluate(tokenOf('U1', 'ORG_A', T0 - 700_000), T0)).toBe('revoked');
    expect(list.evaluate(tokenOf('U2', 'ORG_B', T0 - 20_000), T0)).toBe('revoked');
    expect(list.size).toBe(2);
    await feed.stop();
  });

  it('is not current — and so not ready — until every partition reaches the watermark read at start', async () => {
    const clock = { now: T0 };
    const topic = new FakeTopic(2);
    topic.publish(1, T0 - 1_000, revoked('U1', 'ORG_A', T0 - 1_000));
    const { feed } = replica(topic, clock);
    await feed.start();

    expect(feed.hasCaughtUp()).toBe(false);
    expect(feed.isCurrent()).toBe(false);
    expect(feed.lag()).toBe(1);
    topic.pump();
    expect(feed.hasCaughtUp()).toBe(true);
    expect(feed.isCurrent()).toBe(true);
    expect(feed.lag()).toBe(0);
    await feed.stop();
  });

  it('a lost replica rebuilds the same list on restart: nothing is kept but the topic', async () => {
    const clock = { now: T0 };
    const topic = new FakeTopic(2);
    topic.publish(0, T0 - 100_000, revoked('U1', 'ORG_A', T0 - 100_000));
    topic.publish(1, T0 - 50_000, revoked('U2', 'ORG_A', T0 - 50_000));
    const first = replica(topic, clock);
    await first.feed.start();
    topic.pump();
    await first.feed.stop();

    clock.now = T0 + 60_000;
    const second = replica(topic, clock);
    await second.feed.start();
    topic.pump();
    for (const user of ['U1', 'U2']) {
      expect(second.list.evaluate(tokenOf(user, 'ORG_A', T0 - 200_000), clock.now)).toBe(
        first.list.evaluate(tokenOf(user, 'ORG_A', T0 - 200_000), clock.now),
      );
    }
    expect(second.feed.isCurrent()).toBe(true);
    await second.feed.stop();
  });

  it('a partition the reader was not given never lets the feed become current', async () => {
    const clock = { now: T0 };
    const topic = new FakeTopic(2);
    topic.offsetsAt = async () => new Map([[0, 0]]);
    const { feed } = replica(topic, clock);
    await feed.start();
    topic.pump();
    expect(feed.isCurrent()).toBe(false);
    expect(feed.lag()).toBe(Number.POSITIVE_INFINITY);
    await feed.stop();
  });
});

describe('current: zero lag has to be shown, not assumed', () => {
  it('goes stale when the watermarks cannot be read, even with nothing left to read', async () => {
    const clock = { now: T0 };
    const topic = new FakeTopic(1);
    const { feed, logger } = replica(topic, clock);
    await feed.start();
    expect(feed.isCurrent()).toBe(true);

    topic.failHighWatermarks = true;
    clock.now = T0 + 30_000;
    await feed.probe();
    expect(feed.isCurrent()).toBe(true);
    clock.now = T0 + 30_001;
    await feed.probe();
    expect(feed.isCurrent()).toBe(false);
    expect(feed.hasCaughtUp()).toBe(true);
    expect(logger.warn).toHaveBeenCalled();

    topic.failHighWatermarks = false;
    await feed.probe();
    expect(feed.isCurrent()).toBe(true);
    await feed.stop();
  });

  it('a probe made while a revocation was unread resolves only once it is read', async () => {
    const clock = { now: T0 };
    const topic = new FakeTopic(1);
    const { feed, list } = replica(topic, clock);
    await feed.start();

    topic.publish(0, T0 + 1_000, revoked('U1', 'ORG_A', T0 + 1_000));
    clock.now = T0 + 40_000;
    await feed.probe();
    expect(feed.isCurrent()).toBe(false);
    expect(feed.lag()).toBe(1);

    topic.pump();
    expect(feed.isCurrent()).toBe(true);
    expect(list.evaluate(tokenOf('U1', 'ORG_A', T0), clock.now)).toBe('revoked');
    await feed.stop();
  });

  it('a reader that stops for good is never current again', async () => {
    const clock = { now: T0 };
    const topic = new FakeTopic(1);
    const { feed } = replica(topic, clock);
    await feed.start();
    topic.onFailure?.(new Error('consumer crashed'));
    expect(feed.hasFailed()).toBe(true);
    expect(feed.isCurrent()).toBe(false);
    await feed.stop();
  });
});

describe('what cannot be applied holds every pair — and nothing of it reaches a log', () => {
  it('a malformed revocation holds every pair for its window; the log names where, never what', async () => {
    const clock = { now: T0 };
    const topic = new FakeTopic(1);
    const poisoned = event('ROLE_REVOKED', 'U1', 'ORG_A', T0).replace(
      '"tenantId":"ORG_A"',
      '"tenantId":"ORG_B"',
    );
    topic.publish(0, T0, poisoned);
    const { feed, list, logger } = replica(topic, clock);
    await feed.start();
    topic.pump();

    // Caught up, and still every pair is held: zero lag is not proof of a complete list.
    expect(feed.isCurrent()).toBe(true);
    expect(list.evaluate(tokenOf('ANYONE', 'ANY_ORG', T0 + 60_000), T0 + 60_000)).toBe('held');
    expect(list.isHeld(T0 + timing.retentionMs + 1)).toBe(false);

    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).toContain('"offset":0');
    expect(logged).toContain('ROLE_REVOKED');
    for (const secret of ['U1', 'ORG_A', 'ORG_B', 'kept out of every log']) {
      expect(logged).not.toContain(secret);
    }
    await feed.stop();
  });

  it('a revocation the full list cannot store holds every pair', async () => {
    const clock = { now: T0 };
    const topic = new FakeTopic(1);
    topic.publish(0, T0, revoked('U1', 'ORG_A', T0));
    topic.publish(0, T0, revoked('U2', 'ORG_A', T0));
    const { feed, list, logger } = replica(topic, clock, 1);
    await feed.start();
    topic.pump();
    expect(list.isHeld(T0 + 1)).toBe(true);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('U2');
    await feed.stop();
  });

  it('an event it does not read moves the position and holds nothing', async () => {
    const clock = { now: T0 };
    const topic = new FakeTopic(1);
    topic.publish(0, T0, event('USER_UPDATED', 'U1', 'ORG_A', T0));
    const { feed, list } = replica(topic, clock);
    await feed.start();
    topic.pump();
    expect(feed.isCurrent()).toBe(true);
    expect(list.isHeld(T0)).toBe(false);
    await feed.stop();
  });
});

describe('order: the membership stream sequence, never the producer clock (PR #381 r1 F2)', () => {
  const ADMIN = ['DRIVER', 'ORGANIZATION_ADMIN'];
  const tokenWith = (issuedAtMs: number, tenantRoles: string[]) => ({
    userId: 'U1',
    organizationId: 'ORG_A',
    issuedAtMs,
    tenantRoles,
  });

  async function replayed(records: string[][], clock = { now: T0 + 30_000 }) {
    const topic = new FakeTopic(records.length);
    for (const [partition, values] of records.entries()) {
      for (const value of values) topic.publish(partition, T0, value);
    }
    const r = replica(topic, clock);
    await r.feed.start();
    topic.pump();
    return { ...r, topic, clock };
  }

  // A grant commits at real time T on a replica whose clock runs 4 s ahead; the demotion
  // commits at T+1 s on an accurate one. Both clocks are within the 5 s tolerance.
  const grant = membershipEvent('ROLE_ASSIGNED', { seq: 2, atMs: T0 + 4_000, roles: ADMIN });
  const demotion = membershipEvent('ROLE_REVOKED', { seq: 3, atMs: T0 + 1_000, roles: ['DRIVER'] });

  it.each([
    ['delivered in stream order', [grant, demotion]],
    ['delivered demotion first', [demotion, grant]],
  ])(
    'a demotion stamped earlier than the grant it follows leaves the narrower roles (%s)',
    async (_label, values) => {
      const { list, clock } = await replayed([values]);
      expect(list.evaluate(tokenWith(T0 + 20_000, ADMIN), clock.now)).toBe('stale_roles');
      expect(list.evaluate(tokenWith(T0 + 20_000, ['DRIVER']), clock.now)).toBe('allow');
      // The cutoff is still the demotion's own clock reading: iat is compared with wall time.
      expect(list.evaluate(tokenWith(T0 + 1_000 + timing.graceMs, ['DRIVER']), clock.now)).toBe(
        'revoked',
      );
    },
  );

  describe('revoke, recreate, then a delayed event of the old membership', () => {
    // M1 (an administrator) is revoked; M2 is then created for the same pair with a new id,
    // so its own stream from 1, on another partition. M1's last role change was stamped by a
    // fast replica and its partition lags. Identity allows M2 only once M1 is deleted
    // (ux_membership_live_user_org), so every M1 event is causally before every M2 event.
    const m1Grant = membershipEvent('ROLE_ASSIGNED', { seq: 2, atMs: T0 + 23_000, roles: ADMIN });
    const m1Revoked = membershipEvent('MEMBERSHIP_REVOKED', { seq: 3, atMs: T0 + 19_000 });
    const m2Created = membershipEvent('MEMBERSHIP_CREATED', {
      membershipId: 'M2',
      seq: 1,
      atMs: T0 + 20_000,
      roles: ['DRIVER'],
    });
    // Issued past M1's end and its grace: only the roles carry the decision.
    const afterRevokedCutoff = T0 + 19_000 + timing.graceMs + 1_000;
    const now = { now: T0 + 40_000 };

    it("the old membership's grant, its revocation not yet read: the narrower of the two stands", async () => {
      const { list } = await replayed([[m2Created], [m1Grant]], now);
      expect(list.evaluate(tokenWith(afterRevokedCutoff, ADMIN), now.now)).toBe('stale_roles');
      expect(list.evaluate(tokenWith(afterRevokedCutoff, ['DRIVER']), now.now)).toBe('allow');
    });

    it("once the old membership's revocation is read, the new membership's roles alone stand", async () => {
      const { list } = await replayed([[m2Created], [m1Grant, m1Revoked]], now);
      expect(list.evaluate(tokenWith(afterRevokedCutoff, ADMIN), now.now)).toBe('stale_roles');
      expect(list.evaluate(tokenWith(afterRevokedCutoff, ['DRIVER']), now.now)).toBe('allow');
    });

    it('an event of a membership already seen ended, delivered late, changes no roles', async () => {
      const { list } = await replayed([[m1Revoked, m1Grant]], now);
      expect(list.evaluate(tokenWith(afterRevokedCutoff, ['DRIVER']), now.now)).toBe('stale_roles');
    });
  });

  it('a membership seen expired never grants again, whatever later role event it carries', async () => {
    const { list, clock } = await replayed([
      [
        membershipEvent('MEMBERSHIP_EXPIRED', { seq: 2, atMs: T0 }),
        membershipEvent('ROLE_ASSIGNED', { seq: 3, atMs: T0 + 1_000, roles: ['DRIVER'] }),
      ],
    ]);
    expect(list.evaluate(tokenWith(T0 + 20_000, ['DRIVER']), clock.now)).toBe('stale_roles');
  });

  it.each([
    ['no sequence (a legacy producer)', { streamSeq: undefined, streamKey: undefined }],
    ['a sequence without its stream', { streamKey: undefined }],
    ['a stream without its sequence', { streamSeq: undefined }],
    ['a stream other than the membership', { streamKey: 'M9' }],
    ['an aggregate other than the payload membership', { aggregateId: 'M9', streamKey: 'M9' }],
    ['an aggregate that is not a membership', { aggregateType: 'User' }],
  ])('%s: held, never ordered by its timestamp', async (_label, overrides) => {
    const { list, clock } = await replayed([
      [membershipEvent('ROLE_REVOKED', { seq: 2, atMs: T0, roles: ['DRIVER'] }, overrides)],
    ]);
    expect(list.isHeld(clock.now)).toBe(true);
  });
});

describe('stop: the feed stops vouching at once, and nothing late brings it back (PR #381 r1 F3)', () => {
  async function caughtUp() {
    const clock = { now: T0 };
    const topic = new FakeTopic(1);
    const r = replica(topic, clock);
    await r.feed.start();
    expect(r.feed.isCurrent()).toBe(true);
    expect(r.gate.isReady()).toBe(true);
    return { ...r, topic, clock };
  }

  function expectStopped(r: { feed: RevocationFeed; gate: RevocationGate; list: RevocationList }) {
    expect(r.feed.isCurrent()).toBe(false);
    expect(r.feed.hasCaughtUp()).toBe(false);
    expect(r.gate.isReady()).toBe(false);
    expect(r.gate.isRefusingEveryPair()).toBe(true);
  }

  it('is not current and not ready as soon as stop() is called, before the source has stopped', async () => {
    const r = await caughtUp();
    const shutdown = deferred<void>();
    r.topic.nextStop = shutdown.promise;
    const stopping = r.feed.stop();
    expectStopped(r);
    shutdown.resolve();
    await stopping;
    expectStopped(r);
  });

  it('a probe that resolves after stop() changes nothing', async () => {
    const r = await caughtUp();
    const reading = deferred<void>();
    r.topic.nextHighWatermarks = reading.promise;
    r.clock.now = T0 + 5_000;
    const probing = r.feed.probe();
    await r.feed.stop();
    reading.resolve();
    await probing;
    expectStopped(r);
    expect(r.feed.lag()).toBeUndefined();
  });

  it('stop() during startup: the source never starts and nothing becomes current', async () => {
    const clock = { now: T0 };
    const topic = new FakeTopic(1);
    const r = replica(topic, clock);
    const reading = deferred<void>();
    topic.nextHighWatermarks = reading.promise;
    const starting = r.feed.start();
    await r.feed.stop();
    reading.resolve();
    await starting;
    expect(topic.startCalls).toBe(0);
    expectStopped(r);
  });

  it('stop() while the source is starting: the source is stopped again once it has started', async () => {
    const clock = { now: T0 };
    const topic = new FakeTopic(1);
    const r = replica(topic, clock);
    const started = deferred<void>();
    topic.nextStart = started.promise;
    const starting = r.feed.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(topic.startCalls).toBe(1);
    await r.feed.stop();
    started.resolve();
    await starting;
    expect(topic.stopCalls).toBe(2);
    expectStopped(r);
  });

  it('a message or a failure delivered after stop() changes nothing', async () => {
    const r = await caughtUp();
    const { onMessage, onFailure } = r.topic.callbacks.at(-1)!;
    await r.feed.stop();
    onMessage({ partition: 0, offset: 0, timestampMs: T0, value: revoked('U1', 'ORG_A', T0) });
    onMessage({ partition: 0, offset: 1, timestampMs: T0, value: '{' });
    onFailure(new Error('late'));
    expect(r.list.size).toBe(0);
    expect(r.list.isHeld(T0)).toBe(false);
    expect(r.feed.hasFailed()).toBe(false);
    expect(r.logger.error).not.toHaveBeenCalled();
    expectStopped(r);
  });

  it('a source whose shutdown rejects: stop() rejects, and the feed was already not current nor ready', async () => {
    const r = await caughtUp();
    const { onMessage } = r.topic.callbacks.at(-1)!;
    r.topic.nextStop = Promise.reject(new Error('consumer would not leave'));
    await expect(r.feed.stop()).rejects.toThrow('consumer would not leave');
    expectStopped(r);
    onMessage({ partition: 0, offset: 0, timestampMs: T0, value: revoked('U1', 'ORG_A', T0) });
    expect(r.list.size).toBe(0);
    expectStopped(r);
  });

  it('the callbacks of a previous start change nothing in the next one', async () => {
    const r = await caughtUp();
    const previous = r.topic.callbacks.at(-1)!;
    await r.feed.stop();
    await r.feed.start();
    expect(r.feed.isCurrent()).toBe(true);
    previous.onMessage({
      partition: 0,
      offset: 5,
      timestampMs: T0,
      value: revoked('U9', 'ORG_Z', T0),
    });
    previous.onFailure(new Error('the old reader crashed'));
    expect(r.list.evaluate(tokenOf('U9', 'ORG_Z', T0 - 1_000), T0)).toBe('allow');
    expect(r.feed.hasFailed()).toBe(false);
    expect(r.feed.isCurrent()).toBe(true);
    expect(r.gate.isReady()).toBe(true);
    await r.feed.stop();
  });
});

describe('PR #381 r1 F1 — closed by the cutoff, with identity writing Keycloak first (D-064)', () => {
  // Holds only with the identity change of D-064 merged (PR A): a demotion is written to
  // Keycloak before its event is enqueued, so its `occurredAt` — the cutoff — is later than the
  // write. Every token Keycloak mints with the removed role is then issued no later than the
  // cutoff plus the clock skew plus the propagation allowance, which is the grace. The r1 case —
  // an administrator token at T+50 s — can no longer be minted; the latest one possible is at
  // T + tolerance + propagation, and the cutoff refuses it for its whole life.
  const ADMIN = ['DRIVER', 'ORGANIZATION_ADMIN'];
  const demoted = () => membershipEvent('ROLE_REVOKED', { seq: 2, atMs: T0, roles: ['DRIVER'] });
  const token = (issuedAtMs: number, tenantRoles: string[]) => ({
    userId: 'U1',
    organizationId: 'ORG_A',
    issuedAtMs,
    tenantRoles,
  });
  /** The last whole second Keycloak may mint the old role in: skew plus propagation. */
  const latestStale = T0 + timing.clockToleranceMs + timing.propagationMs;
  /** When the verifier stops accepting a token issued at `issuedAtMs` on its own `exp`. */
  const ownExpiry = (issuedAtMs: number) =>
    issuedAtMs + timing.maxTokenLifetimeMs + timing.clockToleranceMs;

  async function running(clock: { now: number }) {
    const topic = new FakeTopic(1);
    topic.publish(0, T0, demoted());
    const r = replica(topic, clock);
    await r.feed.start();
    topic.pump();
    return { topic, ...r };
  }

  it('the latest token Keycloak may mint with the old role is refused by the cutoff, until its own exp', async () => {
    const clock = { now: T0 + 60_000 };
    const { list, feed } = await running(clock);
    const lagToken = token(latestStale, ADMIN);
    expect(list.evaluate(lagToken, clock.now)).toBe('revoked');
    // Its last accepted instant: `exp` plus the verifier's tolerance — still refused.
    expect(list.evaluate(lagToken, ownExpiry(latestStale))).toBe('revoked');
    // The pair is forgotten only once that token has expired on its own: the verifier now
    // refuses it whatever the list says.
    const forgotten = T0 + timing.retentionMs + 1;
    expect(list.evaluate(lagToken, forgotten)).toBe('allow');
    expect(ownExpiry(latestStale)).toBeLessThan(forgotten);
    await feed.stop();
  });

  it('at the skew + propagation boundary: up to the grace refused, past it admitted only without the removed role', async () => {
    const clock = { now: T0 + 60_000 };
    const { list, feed } = await running(clock);
    // Just inside: equality refuses, whatever the token carries.
    expect(list.evaluate(token(T0 + timing.graceMs, ['DRIVER']), clock.now)).toBe('revoked');
    expect(list.evaluate(token(T0 + timing.graceMs, ADMIN), clock.now)).toBe('revoked');
    // Just outside: a legitimately new token carries the demoted roles only.
    expect(list.evaluate(token(T0 + timing.graceMs + 1_000, ['DRIVER']), clock.now)).toBe('allow');
    // The role restriction stays as defence in depth beyond the stated bounds.
    expect(list.evaluate(token(T0 + timing.graceMs + 1_000, ADMIN), clock.now)).toBe('stale_roles');
    await feed.stop();
  });

  it('a replica started after the change, late in the window, rebuilds the same refusal', async () => {
    const lagToken = token(latestStale, ADMIN);
    // Restarted one millisecond before the window closes: the replay from now − retention
    // still reaches the demotion.
    const clock = { now: T0 + timing.retentionMs - 1 };
    const { list, feed, topic } = await running(clock);
    expect(topic.startedFrom?.get(0)).toBe(0);
    expect(feed.isCurrent()).toBe(true);
    expect(list.evaluate(lagToken, clock.now)).toBe('revoked');
    await feed.stop();

    // Restarted after it: nothing is replayed, and the token has expired on its own by then.
    const later = { now: T0 + timing.retentionMs + 1 };
    const after = await running(later);
    expect(after.topic.startedFrom?.get(0)).toBe(1);
    expect(after.list.evaluate(lagToken, later.now)).toBe('allow');
    expect(ownExpiry(latestStale)).toBeLessThan(later.now);
    await after.feed.stop();
  });
});
