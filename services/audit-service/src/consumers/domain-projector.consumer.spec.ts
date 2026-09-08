import type { EventEnvelope } from '@rasta/contracts';
import type { EventConsumer, EventDelivery } from '@rasta/nest-common';
import { REDACTED, SENSITIVE_KEYS, type Logger } from '@rasta/logging';
import { DomainProjectorConsumer } from './domain-projector.consumer';
import type { AuditRepository, IngestOutcome } from '../audit/audit.repository';
import type { AuditEventRecord } from '../audit/audit.mapper';

/**
 * The projector's lifecycle and its readiness answer.
 *
 * Readiness is the only thing outside this process that can tell whether the
 * evidence is still accumulating, so "is the projector running" has to be a
 * fact about the consumer rather than about this object's own bookkeeping.
 * Every test below is a negative control for a way that answer can be wrong.
 *
 * The consumer is a stand-in rather than a real `EventConsumer` because a real
 * one connects to a broker, but it mirrors that class's flag exactly:
 * `EventConsumer.start()` raises `running` only after `consumer.run()` has
 * resolved, and `stop()` lowers it. What is under test here is not that flag —
 * it is that the projector *reports* it rather than substituting the weaker
 * "a consumer object was assigned".
 */
class StubConsumer {
  running = false;
  starts = 0;
  stops = 0;

  constructor(private readonly failStart = false) {}

  async start(): Promise<void> {
    this.starts += 1;
    if (this.failStart) {
      // What a missing topic looks like under `allowAutoTopicCreation: false`.
      throw new Error('This server does not host this topic-partition');
    }
    this.running = true;
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

function build(consumer: StubConsumer) {
  return new DomainProjectorConsumer(
    () => consumer as unknown as EventConsumer,
    { ingest: async (): Promise<IngestOutcome> => 'WRITTEN' } as unknown as AuditRepository,
    silentLogger,
  );
}

describe('projector lifecycle and readiness', () => {
  it('is not running before start', () => {
    expect(build(new StubConsumer()).isRunning()).toBe(false);
  });

  it('is running once the consumer has actually started', async () => {
    const consumer = new StubConsumer();
    const projector = build(consumer);

    await projector.start();

    expect(consumer.starts).toBe(1);
    expect(projector.isRunning()).toBe(true);
  });

  it('does not report running after a failed start', async () => {
    // The negative control for the assignment order in `start()`: the consumer
    // is assigned before it is awaited, so a subscription the broker refuses
    // leaves an object behind that never ran. Answering readiness from "an
    // object exists" reports `projector: true` for a process that is ingesting
    // nothing — the one failure mode ADR-053 § 3 says is worse than an outage,
    // because nothing errors.
    const consumer = new StubConsumer(true);
    const projector = build(consumer);

    await expect(projector.start()).rejects.toThrow(/does not host this topic-partition/);

    expect(projector.isRunning()).toBe(false);
  });

  it('does not report running after shutdown has completed', async () => {
    // The second negative control: `onModuleDestroy()` stops the consumer but
    // keeps the reference, so an identity check on that reference stays true
    // for the rest of the process's life.
    const consumer = new StubConsumer();
    const projector = build(consumer);

    await projector.start();
    await projector.onModuleDestroy();

    expect(consumer.stops).toBe(1);
    expect(consumer.isRunning()).toBe(false);
    expect(projector.isRunning()).toBe(false);
  });

  it('stops the consumer once per shutdown and survives a repeated one', async () => {
    // Nest calls `onModuleDestroy` once per `app.close()`. A second call must
    // not be an error either — a test harness or a double close would
    // otherwise turn an orderly shutdown into a crash on the way out.
    const consumer = new StubConsumer();
    const projector = build(consumer);

    await projector.start();
    await projector.onModuleDestroy();
    await expect(projector.onModuleDestroy()).resolves.toBeUndefined();

    expect(consumer.stops).toBe(2);
    expect(projector.isRunning()).toBe(false);
  });

  it('is not running after a shutdown with no start', async () => {
    const projector = build(new StubConsumer());

    await expect(projector.onModuleDestroy()).resolves.toBeUndefined();

    expect(projector.isRunning()).toBe(false);
  });
});

describe('an unknown event carrying sensitive values', () => {
  const delivery: EventDelivery = Object.freeze({ topic: 'rasta.supplier.v1', partition: 0 });

  const SENTINEL_PREFIX = 'SENTINEL-';
  const sentinel = (key: string): string => `${SENTINEL_PREFIX}${key}-value`;

  /**
   * A payload built from **every** entry in the platform's `SENSITIVE_KEYS`,
   * each carrying its own distinct sentinel.
   *
   * Derived from the list rather than sampled from it, and that is the whole
   * point: a hand-picked handful proves only that those five values do not
   * leak, and a key added to `@rasta/logging` tomorrow would slip through
   * untested while the test still passed. Because the payload *is* the list,
   * a new key is exercised the moment it is declared.
   */
  const SENSITIVE_PAYLOAD: Readonly<Record<string, string>> = Object.freeze(
    Object.fromEntries(SENSITIVE_KEYS.map((key): [string, string] => [key, sentinel(key)])),
  );
  const SENTINELS = Object.values(SENSITIVE_PAYLOAD);

  /** The fields ADR-053 § 5 names by hand: bid data before a deadline passes. */
  const SEALED_BID_KEYS = ['bidAmount', 'bidContent', 'quotationAmount', 'sealedPayload'];

  const envelope = {
    eventId: '01JPROJECTORSPEC00000001',
    eventName: 'A_NAME_NO_SERVICE_HAS_DECLARED',
    eventVersion: 1,
    occurredAt: '2026-09-15T10:30:00.000Z',
    producer: 'supplier-service',
    producerVersion: '1.0.0',
    aggregateType: 'Quotation',
    aggregateId: 'QTN_0001',
    tenantId: 'ORG-1',
    correlationId: 'corr-1',
    payload: { ...SENSITIVE_PAYLOAD, note: 'ordinary' },
  } as EventEnvelope;

  /** Every argument of every log call, flattened for a substring search. */
  function loggedText(calls: readonly unknown[][]): string {
    return calls
      .flat()
      .map((argument) => (typeof argument === 'string' ? argument : JSON.stringify(argument)))
      .join('\n');
  }

  function capture(calls: unknown[][]): Logger {
    const record =
      (level: string) =>
      (...args: unknown[]): void => {
        calls.push([level, ...args]);
      };
    return {
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      debug: record('debug'),
      fatal: record('fatal'),
      trace: record('trace'),
    } as unknown as Logger;
  }

  function projectorWith(
    calls: unknown[][],
    ingest: (record: AuditEventRecord) => Promise<IngestOutcome>,
  ): DomainProjectorConsumer {
    return new DomainProjectorConsumer(
      () => ({}) as EventConsumer,
      { ingest } as unknown as AuditRepository,
      capture(calls),
    );
  }

  it('exercises every sensitive key the platform declares, with a distinct value each', () => {
    // The exhaustiveness assertion the tests below rest on. Exact and ordered:
    // a key added to `SENSITIVE_KEYS` changes this payload, and a key removed
    // does too, so neither can happen silently.
    expect(Object.keys(SENSITIVE_PAYLOAD)).toEqual([...SENSITIVE_KEYS]);
    expect(new Set(SENTINELS).size).toBe(SENSITIVE_KEYS.length);

    // ADR-053 § 5 names the sealed-bid fields specifically — bid content before
    // a deadline is the most sensitive data the platform holds — so their
    // presence is asserted by name rather than left to the derivation.
    for (const key of SEALED_BID_KEYS) {
      expect(SENSITIVE_KEYS as readonly string[]).toContain(key);
      expect(SENSITIVE_PAYLOAD[key]).toBe(sentinel(key));
    }
  });

  it('is recorded under its own name with no payload value anywhere in the record or the logs', async () => {
    // The acceptance sentence AUD-001 actually satisfies (ADR-053
    // implementation plan § 2.1): the unknown event is *retained* with
    // `action = eventName`, and no raw payload value is persisted — `changes`
    // stays null. ADR-053 § 5 permits only a bounded, redacted delta there and
    // path A cannot build one, so a raw blob would put sealed bid data into
    // the one table nobody is allowed to delete from (S-09, "no raw payload").
    // The bounded delta arrives with path B in AUD-004.
    let stored: AuditEventRecord | undefined;
    const calls: unknown[][] = [];

    const projector = projectorWith(calls, async (record) => {
      stored = record;
      return 'WRITTEN';
    });

    await projector.handle(envelope, delivery);

    expect(stored).toBeDefined();
    // Retained, not dropped: an audit store that skipped an unfamiliar name
    // would be least reliable on the day a new service ships.
    expect(stored?.action).toBe('A_NAME_NO_SERVICE_HAS_DECLARED');
    expect(stored?.sourceEventName).toBe('A_NAME_NO_SERVICE_HAS_DECLARED');
    expect(stored?.sourceTopic).toBe('rasta.supplier.v1');

    // `changes` is not even a field on the record path A builds, which is the
    // structural half of the claim: there is nowhere for a payload to go.
    expect(Object.keys(stored ?? {})).not.toContain('changes');

    const serialised = JSON.stringify(stored, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    for (const value of SENTINELS) {
      expect(serialised).not.toContain(value);
    }
    expect(serialised).not.toContain(SENTINEL_PREFIX);

    // The successful path logs nothing at all, and that is asserted as the
    // expected behaviour rather than left as an empty-haystack search: a
    // per-event log line on the hot path of a projector that consumes every
    // domain topic is both noise and a second place for payload data to end
    // up. The two tests below exercise the paths that *do* log.
    expect(calls).toEqual([]);
    expect(loggedText(calls)).not.toContain(SENTINEL_PREFIX);
  });

  it('says nothing about the payload on the duplicate path', async () => {
    // Replay is routine under `fromBeginning: true`, so this line is the one
    // that would repeat most often. It must name identifiers only.
    const calls: unknown[][] = [];
    const projector = projectorWith(calls, async () => 'DUPLICATE');

    await projector.handle(envelope, delivery);

    expect(calls).toHaveLength(1);
    const text = loggedText(calls);
    expect(text).toContain('debug');
    expect(text).toContain('A_NAME_NO_SERVICE_HAS_DECLARED');
    expect(text).toContain('01JPROJECTORSPEC00000001');
    for (const value of SENTINELS) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toContain(SENTINEL_PREFIX);
  });

  it('describes an unmappable envelope by masked key name, never by value', async () => {
    // The one diagnostic that is *about* the payload, and therefore the only
    // place a value could realistically escape. `describePayloadKeys` returns
    // names, and masks the sensitive ones even so — this asserts the mapping
    // failure still reaches the caller (retry and DLQ belong to the shared
    // consumer) while the log line stays free of every sentinel.
    const calls: unknown[][] = [];
    let ingested = 0;
    const projector = projectorWith(calls, async () => {
      ingested += 1;
      return 'WRITTEN';
    });

    // `streamSeq` is converted with `BigInt()`, which refuses a non-numeric
    // string — a mapping failure that needs no change to production code.
    const unmappable = {
      ...envelope,
      streamSeq: 'not-a-sequence',
    } as unknown as EventEnvelope;

    await expect(projector.handle(unmappable, delivery)).rejects.toThrow();

    expect(ingested).toBe(0);
    expect(calls).toHaveLength(1);
    const text = loggedText(calls);
    expect(text).toContain('error');
    expect(text).toContain(REDACTED);
    for (const value of SENTINELS) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toContain(SENTINEL_PREFIX);
  });
});
