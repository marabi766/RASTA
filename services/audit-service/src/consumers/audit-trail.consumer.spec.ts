import {
  AUDIT_EVENT_RECORDED,
  AUDIT_EVENT_RECORDED_VERSION,
  AUDIT_TRAIL_TOPIC,
  ERROR_CODES,
  type EventEnvelope,
} from '@rasta/contracts';
import type { EventConsumer, EventDelivery } from '@rasta/nest-common';
import { REDACTED, type Logger } from '@rasta/logging';
import { AuditTrailConsumer, AuditTrailPersistenceError } from './audit-trail.consumer';
import { AUDIT_TRAIL_CONSUMER, AuditTrailRejectedError } from '../audit/audit-trail.mapper';
import type { AuditRepository, IngestOutcome } from '../audit/audit.repository';
import type { AuditEventRecord } from '../audit/audit.mapper';
import {
  auditIngestionFailuresTotal,
  auditIngestionLagSeconds,
  auditRecordsIngestedTotal,
} from '../observability/metrics';

/**
 * The audit-trail consumer's lifecycle, readiness, metrics and — above all —
 * what it lets out of the process when something is wrong.
 *
 * The consumer is a stand-in rather than a real `EventConsumer` because a real
 * one connects to a broker; it mirrors that class's running flag exactly, as
 * the projector's spec does. Everything that crosses a broker is proved in
 * `test/kafka-projector.int-spec.ts`, and everything that crosses PostgreSQL in
 * `test/trail-ingestion.int-spec.ts`.
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

type Handler = (envelope: EventEnvelope, delivery: EventDelivery) => Promise<void>;
type IngestCall = [AuditEventRecord, ...unknown[]];

/** Every argument of every log call, level first. */
function capture(calls: unknown[][], withDebug = true): Logger {
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      calls.push([level, ...args]);
    };
  return {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    ...(withDebug ? { debug: record('debug') } : {}),
    fatal: record('fatal'),
    trace: record('trace'),
  } as unknown as Logger;
}

const loggedText = (calls: readonly unknown[][]): string =>
  calls
    .flat()
    .map((argument) => (typeof argument === 'string' ? argument : JSON.stringify(argument)))
    .join('\n');

interface MetricSnapshot {
  values: { value: number; labels: Record<string, string | number | undefined> }[];
}

/** The summed value of every series matching `labels`. */
async function valueOf(
  metric: { get(): Promise<MetricSnapshot> },
  labels: Record<string, string>,
): Promise<number> {
  const { values } = await metric.get();
  return values
    .filter((entry) => Object.entries(labels).every(([key, value]) => entry.labels[key] === value))
    .reduce((sum, entry) => sum + entry.value, 0);
}

const counter = (metric: unknown) => metric as { get(): Promise<MetricSnapshot> };

interface LagSnapshot {
  count: number;
  sum: number;
  bucket: (le: number | '+Inf') => number;
}

/** One topic's ingestion lag histogram: `_count`, `_sum` and each `_bucket`. */
async function lagOf(topic: string): Promise<LagSnapshot> {
  const { values } = await (
    auditIngestionLagSeconds as unknown as {
      get(): Promise<{
        values: {
          metricName?: string;
          value: number;
          labels: MetricSnapshot['values'][number]['labels'];
        }[];
      }>;
    }
  ).get();
  const own = values.filter((entry) => entry.labels.source_topic === topic);
  const single = (suffix: string): number =>
    own.find((entry) => entry.metricName === `rasta_audit_ingestion_lag_seconds_${suffix}`)
      ?.value ?? 0;
  return {
    count: single('count'),
    sum: single('sum'),
    bucket: (le) =>
      own.find(
        (entry) =>
          entry.metricName === 'rasta_audit_ingestion_lag_seconds_bucket' && entry.labels.le === le,
      )?.value ?? 0,
  };
}

/** Observations across every topic: a refused message has no topic of its own to count under. */
async function totalLagCount(): Promise<number> {
  const { values } = await (
    auditIngestionLagSeconds as unknown as {
      get(): Promise<{ values: { metricName?: string; value: number }[] }>;
    }
  ).get();
  return values
    .filter((entry) => entry.metricName === 'rasta_audit_ingestion_lag_seconds_count')
    .reduce((sum, entry) => sum + entry.value, 0);
}

/** Pins `Date.now()` so an observed lag is exact rather than wall-clock dependent. */
function nowAt(iso: string): void {
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(iso));
}

afterEach(() => {
  jest.restoreAllMocks();
});

const TENANT = 'ORG_01JTRAILCONSUMER00000001';
const delivery = (topic: string = AUDIT_TRAIL_TOPIC): EventDelivery =>
  Object.freeze({ topic, partition: 1 });

/**
 * A valid refusal whose every free-text field carries a sentinel.
 *
 * Valid on purpose: the success and duplicate paths must be shown to log no
 * value either, and a sentinel only proves something where it could have
 * leaked.
 */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor: { type: 'USER', id: 'USR_SENTINEL_ACTOR', roles: ['SENTINEL_ROLE'] },
    organizationId: TENANT,
    action: 'audit.access.refuse',
    resourceType: 'SentinelResourceType',
    resourceId: 'SENTINEL-resource-id',
    outcome: 'REFUSED',
    errorCode: ERROR_CODES.TENANT_MISMATCH,
    reason: 'SENTINEL-reason',
    occurrenceCount: 2,
    source: { ip: '203.0.113.9', userAgent: 'SENTINEL-user-agent' },
    changes: [{ field: 'status', from: 'SENTINEL-from', to: 'SENTINEL-to' }],
    ...overrides,
  };
}

function envelope(
  body: unknown = payload(),
  overrides: Record<string, unknown> = {},
): EventEnvelope {
  return {
    eventId: '01JTRAILCONSUMERSPEC000001',
    eventName: AUDIT_EVENT_RECORDED,
    eventVersion: AUDIT_EVENT_RECORDED_VERSION,
    occurredAt: '2026-09-15T10:30:00.000Z',
    producer: 'identity-service',
    producerVersion: '1.2.0',
    aggregateType: 'AuditEvent',
    aggregateId: 'SENTINEL-aggregate',
    tenantId: TENANT,
    correlationId: 'SENTINEL-correlation',
    payload: body,
    ...overrides,
  } as EventEnvelope;
}

function trailWith(
  calls: unknown[][],
  ingest: (...args: IngestCall) => Promise<IngestOutcome>,
  logger: Logger = capture(calls),
): AuditTrailConsumer {
  return new AuditTrailConsumer(
    () => ({}) as EventConsumer,
    { ingest } as unknown as AuditRepository,
    logger,
  );
}

function build(consumer: StubConsumer): AuditTrailConsumer {
  return new AuditTrailConsumer(
    () => consumer as unknown as EventConsumer,
    { ingest: async (): Promise<IngestOutcome> => 'WRITTEN' } as unknown as AuditRepository,
    capture([]),
  );
}

describe('audit-trail consumer lifecycle and readiness', () => {
  it('is not running before start', () => {
    expect(build(new StubConsumer()).isRunning()).toBe(false);
  });

  it('is running once the consumer has actually started', async () => {
    const consumer = new StubConsumer();
    const trail = build(consumer);

    await trail.start();

    expect(consumer.starts).toBe(1);
    expect(trail.isRunning()).toBe(true);
  });

  it('does not report running after a failed start', async () => {
    // A trail topic the broker refuses leaves an object behind that never ran.
    const trail = build(new StubConsumer(true));

    await expect(trail.start()).rejects.toThrow(/does not host this topic-partition/);

    expect(trail.isRunning()).toBe(false);
  });

  it('stops on shutdown and does not report running afterwards', async () => {
    const consumer = new StubConsumer();
    const trail = build(consumer);

    await trail.start();
    await trail.onModuleDestroy();

    expect(consumer.stops).toBe(1);
    expect(trail.isRunning()).toBe(false);
  });

  it('survives a repeated shutdown, and a shutdown with no start', async () => {
    const consumer = new StubConsumer();
    const trail = build(consumer);

    await trail.start();
    await trail.onModuleDestroy();
    await expect(trail.onModuleDestroy()).resolves.toBeUndefined();
    expect(consumer.stops).toBe(2);

    await expect(build(new StubConsumer()).onModuleDestroy()).resolves.toBeUndefined();
  });

  it('registers its own handler, which writes under the trail consumer name', async () => {
    let registered: Handler | undefined;
    const ingested: IngestCall[] = [];
    const trail = new AuditTrailConsumer(
      (handler) => {
        registered = handler as Handler;
        return new StubConsumer() as unknown as EventConsumer;
      },
      {
        ingest: async (...args: IngestCall): Promise<IngestOutcome> => {
          ingested.push(args);
          return 'WRITTEN';
        },
      } as unknown as AuditRepository,
      capture([]),
    );

    await trail.start();
    if (!registered) throw new Error('start() registered no handler');
    await registered(envelope(), delivery());

    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.[1]).toBe(AUDIT_TRAIL_CONSUMER);
  });
});

describe('recording a valid message', () => {
  it('writes through the repository as the trail consumer, with no hierarchy projection', async () => {
    const ingested: IngestCall[] = [];
    const trail = trailWith([], async (...args) => {
      ingested.push(args);
      return 'WRITTEN';
    });

    await trail.handle(envelope(), delivery());

    expect(ingested).toHaveLength(1);
    const [record, consumerName, ...rest] = ingested[0] as IngestCall;
    expect(consumerName).toBe('audit-service.trail');
    // Path B never carries organization structure, so nothing is projected.
    expect(rest).toEqual([]);

    expect(record.outcome).toBe('REFUSED');
    expect(record.organizationId).toBe(TENANT);
    expect(record.sourceTopic).toBe(AUDIT_TRAIL_TOPIC);
    expect(record.changes).toEqual([{ field: 'status', from: 'SENTINEL-from', to: 'SENTINEL-to' }]);
  });

  it('counts one written record by bounded labels and observes its lag once', async () => {
    const labels = {
      source_service: 'identity-service',
      source_topic: AUDIT_TRAIL_TOPIC,
      outcome: 'REFUSED',
    };
    const before = await valueOf(counter(auditRecordsIngestedTotal), labels);
    const lagBefore = await lagOf(AUDIT_TRAIL_TOPIC);
    const otherBefore = await lagOf('rasta.identity.v1');

    // Written 45 seconds after it occurred.
    nowAt('2026-09-15T10:30:45.000Z');
    await trailWith([], async () => 'WRITTEN').handle(
      envelope(payload(), { occurredAt: '2026-09-15T10:30:00.000Z' }),
      delivery(),
    );

    expect(await valueOf(counter(auditRecordsIngestedTotal), labels)).toBe(before + 1);
    const lag = await lagOf(AUDIT_TRAIL_TOPIC);
    expect(lag.count).toBe(lagBefore.count + 1);
    expect(lag.sum).toBe(lagBefore.sum + 45);
    expect(lag.bucket(30)).toBe(lagBefore.bucket(30));
    expect(lag.bucket(60)).toBe(lagBefore.bucket(60) + 1);
    expect(lag.bucket('+Inf')).toBe(lagBefore.bucket('+Inf') + 1);
    // Observed under the record's own topic and nowhere else.
    expect(await lagOf('rasta.identity.v1')).toEqual(
      expect.objectContaining({ count: otherBefore.count, sum: otherBefore.sum }),
    );
  });

  it('clamps a producer clock that is ahead of this one into the zero bucket', async () => {
    const lagBefore = await lagOf(AUDIT_TRAIL_TOPIC);

    // "Written" ten seconds before it occurred.
    nowAt('2026-09-15T10:29:50.000Z');
    await trailWith([], async () => 'WRITTEN').handle(
      envelope(payload(), { occurredAt: '2026-09-15T10:30:00.000Z' }),
      delivery(),
    );

    const lag = await lagOf(AUDIT_TRAIL_TOPIC);
    expect(lag.count).toBe(lagBefore.count + 1);
    expect(lag.sum).toBe(lagBefore.sum);
    expect(lag.bucket(1)).toBe(lagBefore.bucket(1) + 1);
  });

  it('logs nothing at all on the success path', async () => {
    const calls: unknown[][] = [];

    await trailWith(calls, async () => 'WRITTEN').handle(envelope(), delivery());

    expect(calls).toEqual([]);
  });
});

describe('duplicate delivery', () => {
  it('counts nothing and says only identifiers', async () => {
    const calls: unknown[][] = [];
    const written = { source_topic: AUDIT_TRAIL_TOPIC };
    const writtenBefore = await valueOf(counter(auditRecordsIngestedTotal), written);
    const failedBefore = await valueOf(counter(auditIngestionFailuresTotal), {});
    const lagBefore = await lagOf(AUDIT_TRAIL_TOPIC);

    await trailWith(calls, async () => 'DUPLICATE').handle(envelope(), delivery());

    // No success metric: a replay is not a new piece of evidence, and its lag
    // is the lag of a record written long ago.
    expect(await valueOf(counter(auditRecordsIngestedTotal), written)).toBe(writtenBefore);
    expect(await valueOf(counter(auditIngestionFailuresTotal), {})).toBe(failedBefore);
    expect((await lagOf(AUDIT_TRAIL_TOPIC)).count).toBe(lagBefore.count);
    expect((await lagOf(AUDIT_TRAIL_TOPIC)).sum).toBe(lagBefore.sum);

    expect(calls).toHaveLength(1);
    const text = loggedText(calls);
    expect(text).toContain('debug');
    expect(text).toContain('01JTRAILCONSUMERSPEC000001');
    expect(text).not.toContain('SENTINEL');
  });

  it('tolerates a logger with no debug level', async () => {
    const calls: unknown[][] = [];
    const trail = trailWith(calls, async () => 'DUPLICATE', capture(calls, false));

    await expect(trail.handle(envelope(), delivery())).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('refusing a message', () => {
  const CASES: [string, EventEnvelope, EventDelivery, string][] = [
    [
      'an envelope that does not parse',
      envelope(payload(), { correlationId: undefined }),
      delivery(),
      'trail_invalid_envelope',
    ],
    [
      'another event name',
      envelope(payload(), { eventName: 'ASSET_DECOMMISSIONED' }),
      delivery(),
      'trail_unsupported_event',
    ],
    [
      'another payload version',
      envelope(payload(), { eventVersion: 2 }),
      delivery(),
      'trail_unsupported_event',
    ],
    ['another topic', envelope(), delivery('rasta.asset.v1'), 'trail_unsupported_event'],
    [
      'a malformed payload with a sensitive undeclared key',
      envelope(payload({ password: 'SENTINEL-password' })),
      delivery(),
      'trail_invalid_payload',
    ],
    [
      'a tenant payload on an envelope with no tenant',
      envelope(payload(), { tenantId: undefined }),
      delivery(),
      'trail_tenant_mismatch',
    ],
    [
      'a payload naming another tenant',
      envelope(payload({ organizationId: 'ORG_SENTINEL_OTHER' })),
      delivery(),
      'trail_tenant_mismatch',
    ],
    [
      'a raw value for a sensitive field',
      envelope(payload({ changes: [{ field: 'nationalId', from: null, to: 'SENTINEL-id' }] })),
      delivery(),
      'trail_unredacted_sensitive_change',
    ],
  ];

  it.each(CASES)(
    'refuses %s: throws, writes nothing, counts it, logs no value',
    async (_case, source, via, reason) => {
      const calls: unknown[][] = [];
      let ingested = 0;
      const before = await valueOf(counter(auditIngestionFailuresTotal), { reason });
      const writtenBefore = await valueOf(counter(auditRecordsIngestedTotal), {});
      const lagCountBefore = await totalLagCount();

      const trail = trailWith(calls, async () => {
        ingested += 1;
        return 'WRITTEN';
      });

      const failure = await trail.handle(source, via).then(
        () => undefined,
        (error: unknown) => error,
      );

      // Thrown, so the shared consumer retries and dead-letters.
      expect(failure).toBeInstanceOf(AuditTrailRejectedError);
      expect((failure as AuditTrailRejectedError).reason).toBe(reason);
      expect((failure as Error).message).not.toContain('SENTINEL');

      // Nothing reached the store, so nothing can be marked processed.
      expect(ingested).toBe(0);
      expect(await valueOf(counter(auditIngestionFailuresTotal), { reason })).toBe(before + 1);
      expect(await valueOf(counter(auditRecordsIngestedTotal), {})).toBe(writtenBefore);
      expect(await totalLagCount()).toBe(lagCountBefore);

      expect(calls).toHaveLength(1);
      const text = loggedText(calls);
      expect(text).toContain('error');
      expect(text).toContain(reason);
      expect(text).toContain('payload keys:');
      expect(text).not.toContain('SENTINEL');
    },
  );

  it('masks a sensitive payload key name in the diagnostic', async () => {
    const calls: unknown[][] = [];

    await expect(
      trailWith(calls, async () => 'WRITTEN').handle(
        envelope(payload({ password: 'SENTINEL-password' })),
        delivery(),
      ),
    ).rejects.toThrow(AuditTrailRejectedError);

    const text = loggedText(calls);
    expect(text).toContain(REDACTED);
    expect(text).not.toContain('password');
  });

  it('names a message whose identifiers are not identifier-shaped by placeholder', async () => {
    const calls: unknown[][] = [];

    await expect(
      trailWith(calls, async () => 'WRITTEN').handle(
        envelope('SENTINEL-body', { eventName: 'SENTINEL lower case', eventId: 'SENTINEL secret' }),
        delivery(),
      ),
    ).rejects.toThrow(AuditTrailRejectedError);

    const text = loggedText(calls);
    expect(text).toContain('(unnamed event) (unidentified)');
    expect(text).toContain('payload keys: (string)');
    expect(text).not.toContain('SENTINEL');
  });

  it('counts and sanitises a throw that is not a rejection', async () => {
    // The mapper refuses everything it can recognise with a typed rejection;
    // this is the path for anything else. Forced with an envelope whose
    // `occurredAt` getter throws while the schema reads it.
    const calls: unknown[][] = [];
    let ingested = 0;
    const source = envelope();
    Object.defineProperty(source, 'occurredAt', {
      enumerable: true,
      get() {
        throw new TypeError('SENTINEL-getter');
      },
    });
    const before = await valueOf(counter(auditIngestionFailuresTotal), {
      reason: 'unmappable_envelope',
    });

    const failure = await trailWith(calls, async () => {
      ingested += 1;
      return 'WRITTEN';
    })
      .handle(source, delivery())
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AuditTrailRejectedError);
    expect((failure as Error).message).toBe('audit trail message could not be mapped (TypeError)');
    expect(ingested).toBe(0);
    expect(
      await valueOf(counter(auditIngestionFailuresTotal), { reason: 'unmappable_envelope' }),
    ).toBe(before + 1);
    expect(loggedText(calls)).not.toContain('SENTINEL');
  });
});

describe('a database failure', () => {
  /** What a Prisma error can look like: its message quotes the statement's arguments. */
  function quotingError(code?: unknown): Error {
    const error = new Error(
      'Invalid `prisma.auditEvent.create()` invocation: { reason: "SENTINEL-reason", ' +
        'sourceUserAgent: "SENTINEL-user-agent" }',
    );
    error.name = 'PrismaClientKnownRequestError';
    if (code !== undefined) Object.assign(error, { code });
    return error;
  }

  it('propagates, sanitised, with the original kept as its cause', async () => {
    const calls: unknown[][] = [];
    const original = quotingError('P2000');
    const failedBefore = await valueOf(counter(auditIngestionFailuresTotal), {
      reason: 'database_error',
    });
    const writtenBefore = await valueOf(counter(auditRecordsIngestedTotal), {});
    const lagBefore = await lagOf(AUDIT_TRAIL_TOPIC);

    const failure = await trailWith(calls, async () => {
      throw original;
    })
      .handle(envelope(), delivery())
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(AuditTrailPersistenceError);
    expect((failure as Error).name).toBe('AuditTrailPersistenceError');
    expect((failure as Error).message).toBe(
      'audit trail record 01JTRAILCONSUMERSPEC000001 was not persisted ' +
        '(PrismaClientKnownRequestError P2000)',
    );
    expect((failure as Error).message).not.toContain('SENTINEL');
    expect((failure as Error).cause).toBe(original);

    expect(await valueOf(counter(auditIngestionFailuresTotal), { reason: 'database_error' })).toBe(
      failedBefore + 1,
    );
    expect(await valueOf(counter(auditRecordsIngestedTotal), {})).toBe(writtenBefore);
    expect((await lagOf(AUDIT_TRAIL_TOPIC)).count).toBe(lagBefore.count);
    expect((await lagOf(AUDIT_TRAIL_TOPIC)).sum).toBe(lagBefore.sum);

    // The shared consumer logs the (sanitised) error on every attempt; this
    // handler adds nothing that could carry more.
    expect(calls).toEqual([]);
  });

  it('names a Prisma code only when it is shaped like one', async () => {
    const outcomes: string[] = [];
    for (const thrown of [quotingError('SENTINEL-code'), quotingError(), 'SENTINEL-string']) {
      const failure = await trailWith([], async () => {
        throw thrown;
      })
        .handle(envelope(), delivery())
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      outcomes.push((failure as Error).message);
    }

    expect(outcomes).toEqual([
      'audit trail record 01JTRAILCONSUMERSPEC000001 was not persisted (PrismaClientKnownRequestError)',
      'audit trail record 01JTRAILCONSUMERSPEC000001 was not persisted (PrismaClientKnownRequestError)',
      'audit trail record 01JTRAILCONSUMERSPEC000001 was not persisted (Error)',
    ]);
  });

  it('does not repeat an event id that is not identifier-shaped', async () => {
    const failure = await trailWith([], async () => {
      throw quotingError('P1001');
    })
      .handle(envelope(payload(), { eventId: 'SENTINEL secret id' }), delivery())
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect((failure as Error).message).toBe(
      'audit trail record (unidentified) was not persisted (PrismaClientKnownRequestError P1001)',
    );
  });
});
