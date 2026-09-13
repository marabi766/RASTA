import type { EventEnvelope } from '@rasta/contracts';
import type { EventConsumer, EventDelivery } from '@rasta/nest-common';
import { REDACTED, SENSITIVE_KEYS, type Logger } from '@rasta/logging';
import { DomainProjectorConsumer } from './domain-projector.consumer';
import type { AuditRepository, IngestOutcome } from '../audit/audit.repository';
import type { AuditEventRecord } from '../audit/audit.mapper';
import {
  auditIngestionFailuresTotal,
  auditIngestionLagSeconds,
  auditRecordsIngestedTotal,
} from '../observability/metrics';

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

/**
 * `rasta_audit_ingestion_lag_seconds` on path A: one observation per row
 * actually written, under the topic it came from, and nothing for a replay or
 * a failure. `Date.now()` is pinned so each observed lag is exact.
 */
describe('ingestion lag histogram on path A', () => {
  const TOPIC = 'rasta.asset.v1';
  const OCCURRED_AT = '2026-09-15T10:30:00.000Z';
  const delivery: EventDelivery = Object.freeze({ topic: TOPIC, partition: 2 });

  const envelope = {
    eventId: '01JPROJECTORLAGSPEC000001',
    eventName: 'ASSET_REGISTERED',
    eventVersion: 1,
    occurredAt: OCCURRED_AT,
    producer: 'asset-service',
    producerVersion: '1.0.0',
    aggregateType: 'Asset',
    aggregateId: 'AST_0001',
    tenantId: 'ORG-1',
    correlationId: 'corr-lag-1',
    payload: { assetId: 'AST_0001' },
  } as EventEnvelope;

  interface Sample {
    metricName?: string;
    value: number;
    labels: Record<string, string | number | undefined>;
  }

  async function samples(): Promise<Sample[]> {
    const { values } = await (
      auditIngestionLagSeconds as unknown as { get(): Promise<{ values: Sample[] }> }
    ).get();
    return values;
  }

  async function lagOf(topic: string) {
    const own = (await samples()).filter((entry) => entry.labels.source_topic === topic);
    const single = (suffix: string): number =>
      own.find((entry) => entry.metricName === `rasta_audit_ingestion_lag_seconds_${suffix}`)
        ?.value ?? 0;
    return {
      count: single('count'),
      sum: single('sum'),
      bucket: (le: number | '+Inf'): number =>
        own.find(
          (entry) =>
            entry.metricName === 'rasta_audit_ingestion_lag_seconds_bucket' &&
            entry.labels.le === le,
        )?.value ?? 0,
    };
  }

  async function totalCount(): Promise<number> {
    return (await samples())
      .filter((entry) => entry.metricName === 'rasta_audit_ingestion_lag_seconds_count')
      .reduce((sum, entry) => sum + entry.value, 0);
  }

  async function counterTotal(metric: unknown): Promise<number> {
    const { values } = await (metric as { get(): Promise<{ values: Sample[] }> }).get();
    return values.reduce((sum, entry) => sum + entry.value, 0);
  }

  const nowAt = (iso: string): void => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(iso));
  };

  const projector = (ingest: () => Promise<IngestOutcome>): DomainProjectorConsumer =>
    new DomainProjectorConsumer(
      () => ({}) as EventConsumer,
      { ingest } as unknown as AuditRepository,
      silentLogger,
    );

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('observes a written record once, under its own topic, with its exact lag', async () => {
    const before = await lagOf(TOPIC);
    const otherBefore = await lagOf('rasta.supplier.v1');

    // Written 125 seconds after it occurred: above 120, inside le="300".
    nowAt('2026-09-15T10:32:05.000Z');
    await projector(async () => 'WRITTEN').handle(envelope, delivery);

    const after = await lagOf(TOPIC);
    expect(after.count).toBe(before.count + 1);
    expect(after.sum).toBe(before.sum + 125);
    expect(after.bucket(120)).toBe(before.bucket(120));
    expect(after.bucket(300)).toBe(before.bucket(300) + 1);
    expect(after.bucket('+Inf')).toBe(before.bucket('+Inf') + 1);
    const other = await lagOf('rasta.supplier.v1');
    expect([other.count, other.sum]).toEqual([otherBefore.count, otherBefore.sum]);
  });

  it('clamps a producer clock that is ahead of this one into the zero bucket', async () => {
    const before = await lagOf(TOPIC);

    nowAt('2026-09-15T10:29:30.000Z');
    await projector(async () => 'WRITTEN').handle(envelope, delivery);

    const after = await lagOf(TOPIC);
    expect(after.count).toBe(before.count + 1);
    expect(after.sum).toBe(before.sum);
    expect(after.bucket(1)).toBe(before.bucket(1) + 1);
  });

  it('observes nothing for a duplicate delivery', async () => {
    const before = await totalCount();
    const sumBefore = (await lagOf(TOPIC)).sum;

    nowAt('2026-09-15T11:30:00.000Z');
    await projector(async () => 'DUPLICATE').handle(envelope, delivery);

    expect(await totalCount()).toBe(before);
    expect((await lagOf(TOPIC)).sum).toBe(sumBefore);
  });

  it('observes nothing when the write fails, and still counts the failure', async () => {
    const before = await totalCount();
    const writtenBefore = await counterTotal(auditRecordsIngestedTotal);
    const failuresBefore = await counterTotal(auditIngestionFailuresTotal);

    await expect(
      projector(async () => {
        throw new Error('connection refused');
      }).handle(envelope, delivery),
    ).rejects.toThrow('connection refused');

    expect(await totalCount()).toBe(before);
    expect(await counterTotal(auditRecordsIngestedTotal)).toBe(writtenBefore);
    expect(await counterTotal(auditIngestionFailuresTotal)).toBe(failuresBefore + 1);
  });

  it('observes nothing for an envelope it cannot map', async () => {
    const before = await totalCount();
    let ingested = 0;

    await expect(
      projector(async () => {
        ingested += 1;
        return 'WRITTEN';
      }).handle({ ...envelope, streamSeq: 'not-a-sequence' } as unknown as EventEnvelope, delivery),
    ).rejects.toThrow();

    expect(ingested).toBe(0);
    expect(await totalCount()).toBe(before);
  });
});

/**
 * `source_service` on path A is derived from the closed producer topology,
 * never copied from `envelope.producer`, which any publisher on a subscribed
 * topic authors. The stored row keeps the producer's (length-bounded) claim.
 */
describe('source_service label on path A', () => {
  interface Series {
    value: number;
    labels: Record<string, string | number | undefined>;
  }

  const base = {
    eventId: '01JPROJECTORLABELSPEC0001',
    eventName: 'ASSET_REGISTERED',
    eventVersion: 1,
    occurredAt: '2026-09-15T10:30:00.000Z',
    producerVersion: '1.0.0',
    aggregateType: 'Asset',
    aggregateId: 'AST_0001',
    tenantId: 'ORG-1',
    correlationId: 'corr-label-1',
    payload: { assetId: 'AST_0001' },
  };

  async function series(): Promise<Series[]> {
    const { values } = await (
      auditRecordsIngestedTotal as unknown as { get(): Promise<{ values: Series[] }> }
    ).get();
    return values;
  }

  const labelValues = async (): Promise<unknown[]> => [
    ...new Set((await series()).map((entry) => entry.labels.source_service)),
  ];

  const countOf = async (labels: Record<string, string>): Promise<number> =>
    (await series())
      .filter((entry) =>
        Object.entries(labels).every(([key, value]) => entry.labels[key] === value),
      )
      .reduce((sum, entry) => sum + entry.value, 0);

  /** Handles one envelope as written, and returns the record handed to the store. */
  async function write(producer: string, topic: string): Promise<AuditEventRecord> {
    const stored: AuditEventRecord[] = [];
    const projector = new DomainProjectorConsumer(
      () => ({}) as EventConsumer,
      {
        ingest: async (record: AuditEventRecord): Promise<IngestOutcome> => {
          stored.push(record);
          return 'WRITTEN';
        },
      } as unknown as AuditRepository,
      silentLogger,
    );
    await projector.handle({ ...base, producer } as EventEnvelope, { topic, partition: 0 });
    expect(stored).toHaveLength(1);
    return stored[0] as AuditEventRecord;
  }

  beforeEach(() => {
    auditRecordsIngestedTotal.reset();
  });

  afterAll(() => {
    auditRecordsIngestedTotal.reset();
  });

  it.each([
    ['rasta.asset.v1', 'asset-service'],
    ['rasta.insurance.v1', 'asset-service'],
    ['rasta.supplier.v1', 'supplier-service'],
  ])('keeps the owner name when %s is produced by %s', async (topic, producer) => {
    const record = await write(producer, topic);

    expect(record.sourceService).toBe(producer);
    expect(
      await countOf({ source_service: producer, source_topic: topic, outcome: 'SUCCESS' }),
    ).toBe(1);
    expect(await labelValues()).toEqual([producer]);
  });

  it.each([
    ['an arbitrary producer', 'rasta.asset.v1', 'SENTINEL-invented-service'],
    ['a tenant-looking producer', 'rasta.asset.v1', 'ORG_01JSENTINELTENANT0001'],
    ['a known service on a topic it does not own', 'rasta.asset.v1', 'identity-service'],
    ['the trail producer on a domain topic', 'rasta.supplier.v1', 'identity-service'],
    ['a near-miss casing', 'rasta.asset.v1', 'Asset-Service'],
  ])(
    'counts %s under the fallback and stores the claim unchanged',
    async (_case, topic, producer) => {
      const record = await write(producer, topic);

      expect(record.sourceService).toBe(producer);
      expect(record.sourceTopic).toBe(topic);
      expect(
        await countOf({ source_service: 'unknown', source_topic: topic, outcome: 'SUCCESS' }),
      ).toBe(1);
      expect(await labelValues()).toEqual(['unknown']);
    },
  );

  it('never turns an overlong producer into a label, and stores it bounded as before', async () => {
    const producer = `asset-service${'SENTINEL'.repeat(600)}`;

    const record = await write(producer, 'rasta.asset.v1');

    expect(record.sourceService).toBe(producer.slice(0, 128));
    expect(await labelValues()).toEqual(['unknown']);
    expect(JSON.stringify(await series())).not.toContain('SENTINEL');
  });

  it('takes a bounded set of label values however many distinct producers publish', async () => {
    for (let index = 0; index < 50; index += 1) {
      await write(`producer-${index}`, 'rasta.asset.v1');
      await write(`producer-${index}`, 'rasta.fleet.v1');
    }
    await write('asset-service', 'rasta.asset.v1');
    await write('fleet-service', 'rasta.fleet.v1');

    expect((await labelValues()).sort()).toEqual(['asset-service', 'fleet-service', 'unknown']);
    expect(await series()).toHaveLength(4);
    expect(await countOf({ source_service: 'unknown' })).toBe(100);
  });
});
