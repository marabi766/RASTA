import {
  RevocationFeed,
  type RevocationLogMessage,
  type RevocationLogSource,
} from './revocation-feed';
import { RevocationList, revocationTiming } from './revocation-list';

/**
 * Start, restart and currency of one replica's list (ADR-060, gateway revocation list addendum
 * § 4 and § 5), against an in-memory identity topic whose delivery the test drives.
 */

const T0 = Date.parse('2026-10-24T10:00:00.000Z');
const timing = revocationTiming(900, 5);

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
    payload: { membershipId: 'M1', userId, organizationId, reason: 'kept out of every log' },
  });
}
const revoked = (userId: string, organizationId: string, atMs: number) =>
  event('MEMBERSHIP_REVOKED', userId, organizationId, atMs);

/** A topic of N partitions; records carry a broker timestamp. */
class FakeTopic implements RevocationLogSource {
  readonly partitions: { timestampMs: number; value: string | null }[][];
  failHighWatermarks = false;
  startedFrom: Map<number, number> | undefined;
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
    if (this.failHighWatermarks) throw new Error('broker unreachable');
    return new Map(this.partitions.map((records, partition) => [partition, records.length]));
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
    this.startedFrom = new Map(from);
    this.delivered = new Map(from);
    this.onMessage = onMessage;
    this.onFailure = onFailure;
  }

  async stop() {
    this.onMessage = undefined;
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
  return { list, feed, logger };
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
