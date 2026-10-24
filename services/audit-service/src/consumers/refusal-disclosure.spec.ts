import {
  AUDIT_EVENT_RECORDED,
  AUDIT_EVENT_RECORDED_VERSION,
  AUDIT_TRAIL_TOPIC,
  DLQ_HEADERS,
  ERROR_CODES,
  type EventEnvelope,
} from '@rasta/contracts';
import { EventConsumer, type ConsumerLogger, type EventDelivery } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import type { AuditRepository, IngestOutcome } from '../audit/audit.repository';
import {
  ORGANIZATION_PROJECTION_EVENTS,
  ORGANIZATION_TOPIC,
} from '../audit/organization-projection';
import { AuditTrailConsumer } from './audit-trail.consumer';
import { DomainProjectorConsumer } from './domain-projector.consumer';

/**
 * PR #378 r1 F3: a property name is the producer's text, and a producer can put
 * an email address in one. The three refusal paths that used to describe a
 * payload by its key names — domain-projector mapping (formerly
 * `domain-projector.consumer.ts:132`), organization projection (`:156`) and
 * the audit trail (`audit-trail.consumer.ts:166`) — are each driven through the
 * real shared `EventConsumer`, with a fake dead-letter producer, until the
 * message is dead-lettered. The sentinel key must reach none of: the audit
 * log lines, the shared consumer's log lines, the error the handler threw, and
 * the dead letter's `x-dlq-error` header. Only the untouched body carries it.
 */

const SENTINEL_KEY = 'customer-SENTINEL@example.test';
const LEAKS = ['SENTINEL', 'example.test'];

interface DeadLetter {
  key?: Buffer | string | null;
  value: Buffer | null;
  headers: Record<string, unknown>;
}

interface PrivateHandle {
  dlqProducer?: { send(record: { messages: DeadLetter[] }): Promise<void> };
  handleMessage(
    topic: string,
    partition: number,
    value: Buffer | null,
    headers: undefined,
    offset?: string,
    key?: Buffer | null,
  ): Promise<void>;
}

type Handler = (envelope: EventEnvelope, delivery: EventDelivery) => Promise<void>;

interface Run {
  auditLog: string[];
  consumerLog: string[];
  thrown: unknown[];
  deadLetters: DeadLetter[];
  ingested: number;
}

function auditLogger(lines: string[]): Logger {
  const record = (level: string) => (message: unknown) => lines.push(`${level} ${String(message)}`);
  return {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    fatal: record('fatal'),
    trace: record('trace'),
  } as unknown as Logger;
}

const repository = (run: Run) =>
  ({
    ingest: async (): Promise<IngestOutcome> => {
      run.ingested += 1;
      return 'WRITTEN';
    },
  }) as unknown as AuditRepository;

/** Delivers one message through a real `EventConsumer` until it is dead-lettered. */
async function deliver(
  topic: string,
  source: EventEnvelope,
  handlerFor: (run: Run) => Handler,
): Promise<Run> {
  const run: Run = { auditLog: [], consumerLog: [], thrown: [], deadLetters: [], ingested: 0 };
  const handler = handlerFor(run);
  const consumerLogger: ConsumerLogger = {
    log: (message) => run.consumerLog.push(`log ${message}`),
    warn: (message) => run.consumerLog.push(`warn ${message}`),
    error: (message) => run.consumerLog.push(`error ${message}`),
  };
  const consumer = new EventConsumer(
    {
      brokers: ['localhost:9092'],
      clientId: 'audit-refusal-disclosure-spec',
      groupId: 'audit-service.refusal-disclosure-spec',
      topics: [topic],
      deadLetterTopic: 'rasta.audit.v1.dlq',
      maxRetries: 2,
      retryBackoffMs: 0,
    },
    async (envelope, delivery) => {
      try {
        await handler(envelope, delivery);
      } catch (error) {
        run.thrown.push(error);
        throw error;
      }
    },
    consumerLogger,
  );
  const handle = consumer as unknown as PrivateHandle;
  handle.dlqProducer = {
    send: async (record) => {
      run.deadLetters.push(...record.messages);
    },
  };

  await handle.handleMessage(
    topic,
    0,
    Buffer.from(JSON.stringify(source), 'utf8'),
    undefined,
    '7',
    Buffer.from('PARTITION-KEY'),
  );
  return run;
}

function expectNoLeak(run: Run): string {
  expect(run.ingested).toBe(0);
  expect(run.thrown.length).toBeGreaterThan(0);
  expect(run.deadLetters).toHaveLength(1);
  const dlqError = String(run.deadLetters[0]?.headers[DLQ_HEADERS.error]);
  const everything = [
    ...run.auditLog,
    ...run.consumerLog,
    ...run.thrown.map((error) => `${(error as Error).name}: ${(error as Error).message}`),
    dlqError,
  ].join('\n');
  for (const leak of LEAKS) expect(everything).not.toContain(leak);
  expect(everything).not.toContain('payload keys');
  // The body is the original, byte for byte: that is what a replay needs.
  expect(run.deadLetters[0]?.value?.toString('utf8')).toContain(SENTINEL_KEY);
  // The audit handler logged its refusal (once per attempt).
  expect(run.auditLog.length).toBeGreaterThan(0);
  return dlqError;
}

const base = {
  eventVersion: 1,
  occurredAt: '2026-10-24T09:00:00.000Z',
  producerVersion: '1.0.0',
  correlationId: 'corr-refusal-disclosure',
};

describe('no payload key name escapes a refusal (PR #378 r1 F3)', () => {
  it('domain projector, mapping: event type and error class only', async () => {
    const source = {
      ...base,
      eventId: '01JREFUSALDISCLOSURE00001',
      eventName: 'SUPPLIER_PROBE',
      producer: 'supplier-service',
      aggregateType: 'Supplier',
      aggregateId: 'SUP-1',
      payload: { [SENTINEL_KEY]: 'x' },
    } as EventEnvelope;

    const run = await deliver('rasta.supplier.v1', source, (state) => {
      const projector = new DomainProjectorConsumer(
        () => ({}) as EventConsumer,
        repository(state),
        auditLogger(state.auditLog),
      );
      // A mapping failure whose own message quotes the producer's text:
      // `BigInt()` repeats the string it could not convert.
      return (envelope, delivery) =>
        projector.handle({ ...envelope, streamSeq: SENTINEL_KEY } as never, delivery);
    });

    const dlqError = expectNoLeak(run);
    expect(dlqError).toContain('audit record mapping failed for SUPPLIER_PROBE v1 (SyntaxError)');
    expect(run.auditLog.join('\n')).toContain(
      'Cannot map SUPPLIER_PROBE v1 from rasta.supplier.v1',
    );
  });

  it('domain projector, organization projection: issue codes on declared fields only', async () => {
    const source = {
      ...base,
      eventId: '01JREFUSALDISCLOSURE00002',
      eventName: ORGANIZATION_PROJECTION_EVENTS.STATUS_CHANGED,
      producer: 'organization-service',
      aggregateType: 'Organization',
      aggregateId: 'ORG-1',
      tenantId: 'ORG-1',
      payload: {
        organizationId: 'ORG-1',
        newStatus: 42,
        affectedIds: ['ORG-1'],
        [SENTINEL_KEY]: 'x',
      },
    } as EventEnvelope;

    const run = await deliver(ORGANIZATION_TOPIC, source, (state) => {
      const projector = new DomainProjectorConsumer(
        () => ({}) as EventConsumer,
        repository(state),
        auditLogger(state.auditLog),
      );
      return (envelope, delivery) => projector.handle(envelope, delivery);
    });

    const dlqError = expectNoLeak(run);
    expect(dlqError).toContain(
      'organization projection refused ORGANIZATION_STATUS_CHANGED v1: newStatus invalid_type',
    );
    // Retried, then dead-lettered, as a malformed hierarchy event always was.
    expect(run.deadLetters[0]?.headers[DLQ_HEADERS.reason]).toBe('MAX_RETRIES_EXCEEDED');
    expect(run.thrown).toHaveLength(2);
  });

  it('audit trail: the rejection names the event type, codes and declared paths only', async () => {
    const source = {
      ...base,
      eventId: '01JREFUSALDISCLOSURE00003',
      eventName: AUDIT_EVENT_RECORDED,
      eventVersion: AUDIT_EVENT_RECORDED_VERSION,
      producer: 'identity-service',
      aggregateType: 'AuditEvent',
      aggregateId: 'AUD-1',
      tenantId: 'ORG-1',
      payload: {
        actor: { type: 'USER', id: 'USR-1', roles: [] },
        organizationId: 'ORG-1',
        action: 'audit.access.refuse',
        resourceType: 'Probe',
        resourceId: 'PRB-1',
        outcome: 'REFUSED',
        errorCode: ERROR_CODES.TENANT_MISMATCH,
        occurrenceCount: 1,
        [SENTINEL_KEY]: 'x',
      },
    } as EventEnvelope;

    const run = await deliver(AUDIT_TRAIL_TOPIC, source, (state) => {
      const trail = new AuditTrailConsumer(
        () => ({}) as EventConsumer,
        repository(state),
        auditLogger(state.auditLog),
      );
      return (envelope, delivery) => trail.handle(envelope, delivery);
    });

    const dlqError = expectNoLeak(run);
    expect(dlqError).toContain('trail_invalid_payload ((root) unrecognized_keys)');
    expect(run.auditLog.join('\n')).toContain(
      `Rejected AUDIT_EVENT_RECORDED v${AUDIT_EVENT_RECORDED_VERSION} from ${AUDIT_TRAIL_TOPIC}[0]`,
    );
  });
});
