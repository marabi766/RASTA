import {
  auditChangesSchema,
  OPS_REPLAY_TOPIC,
  REPLAY_EXECUTED,
  type EventEnvelope,
} from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import { INGESTION_FAILURE_REASONS } from '../observability/metrics';
import {
  OPS_REPLAY_CONSUMER,
  OpsReplayRejectedError,
  REPLAYED_RESOURCE_TYPE,
  toReplayExecutedRecord,
} from './ops-replay.mapper';

const REPORT = 'rpl-0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const DELIVERY: EventDelivery = Object.freeze({ topic: OPS_REPLAY_TOPIC, partition: 2 });

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reportId: REPORT,
    operator: 'ops.alice',
    replayedEvent: { eventId: 'EVT_1', eventName: 'USAGE_RECORDED', tenantId: 'ORG_1' },
    dlq: { topic: 'rasta.maintenance.v1.dlq', partition: 0, offset: '12' },
    target: { topic: 'rasta.fleet.v1.retry', partition: 1, offset: '40' },
    stale: false,
    ...overrides,
  };
}

function record(overrides: Partial<EventEnvelope> = {}, body = payload()): EventEnvelope {
  return {
    eventId: 'EVT_REPLAY_1',
    eventName: REPLAY_EXECUTED,
    eventVersion: 1,
    occurredAt: '2026-09-30T08:00:00.000Z',
    producer: 'ops-replay',
    producerVersion: '1.0.0',
    aggregateType: 'ReplayRun',
    aggregateId: REPORT,
    tenantId: 'ORG_1',
    correlationId: REPORT,
    causationId: 'EVT_1',
    actor: { type: 'USER', id: 'ops.alice' },
    payload: body,
    ...overrides,
  } as EventEnvelope;
}

function refusal(envelope: EventEnvelope, delivery = DELIVERY): OpsReplayRejectedError {
  try {
    toReplayExecutedRecord(envelope, delivery);
  } catch (error) {
    if (error instanceof OpsReplayRejectedError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('REPLAY_EXECUTED → audit row', () => {
  it('names its own group, which is its processed_event key', () => {
    expect(OPS_REPLAY_CONSUMER).toBe('audit-service.ops-replay');
  });

  it('records a tenant replay: the operator, the tenant, the event, the run, and where it moved', () => {
    const row = toReplayExecutedRecord(record(), DELIVERY);

    expect(row).toMatchObject({
      actorType: 'USER',
      actorId: 'ops.alice',
      actorRoles: [],
      organizationId: 'ORG_1',
      action: REPLAY_EXECUTED,
      resourceType: REPLAYED_RESOURCE_TYPE,
      resourceId: 'EVT_1',
      outcome: 'SUCCESS',
      occurrenceCount: 1,
      sourceService: 'ops-replay',
      sourceEventId: 'EVT_REPLAY_1',
      sourceEventName: REPLAY_EXECUTED,
      sourceTopic: OPS_REPLAY_TOPIC,
      correlationId: REPORT,
      causationId: 'EVT_1',
      reason: null,
      errorCode: null,
      correctionOf: null,
    });
    expect(row.changes).toEqual([
      { field: 'topic', from: 'rasta.maintenance.v1.dlq', to: 'rasta.fleet.v1.retry' },
      { field: 'partition', from: 0, to: 1 },
      { field: 'offset', from: '12', to: '40' },
      { field: 'eventName', from: null, to: 'USAGE_RECORDED' },
      { field: 'stale', from: null, to: false },
    ]);
    // What the store's own contract for `changes` accepts.
    expect(auditChangesSchema.safeParse(row.changes).success).toBe(true);
  });

  it('keeps an allowed stale verdict as it was', () => {
    for (const stale of [true, 'UNKNOWN'] as const) {
      const row = toReplayExecutedRecord(record({}, payload({ stale })), DELIVERY);
      expect(row.changes?.at(-1)).toEqual({ field: 'stale', from: null, to: stale });
    }
  });

  it('records a replay of an event with no tenant as a platform record', () => {
    const body = payload({ replayedEvent: { eventId: 'EVT_2', eventName: 'SOMETHING_GLOBAL' } });
    const envelope = record({}, body);
    delete (envelope as { tenantId?: string }).tenantId;

    expect(toReplayExecutedRecord(envelope, DELIVERY).organizationId).toBeNull();
  });

  it.each([
    ['the envelope names another tenant', record({ tenantId: 'ORG_OTHER' })],
    [
      'the envelope names a tenant the replayed event did not have',
      record({}, payload({ replayedEvent: { eventId: 'EVT_1', eventName: 'USAGE_RECORDED' } })),
    ],
  ])('refuses a tenant disagreement: %s', (_what, envelope) => {
    expect(refusal(envelope).reason).toBe(INGESTION_FAILURE_REASONS.REPLAY_TENANT_MISMATCH);
  });

  it('refuses a replayed event with a tenant the envelope does not state', () => {
    const envelope = record();
    delete (envelope as { tenantId?: string }).tenantId;
    expect(refusal(envelope).reason).toBe(INGESTION_FAILURE_REASONS.REPLAY_TENANT_MISMATCH);
  });

  it.each([
    ['another event name', record({ eventName: 'AUDIT_EVENT_RECORDED' })],
    ['another version', record({ eventVersion: 2 })],
    ['another producer', record({ producer: 'audit-service' })],
  ])('refuses %s', (_what, envelope) => {
    expect(refusal(envelope).reason).toBe(INGESTION_FAILURE_REASONS.REPLAY_UNSUPPORTED_EVENT);
  });

  it('refuses a record delivered anywhere but its topic', () => {
    expect(refusal(record(), { topic: 'rasta.audit.trail.v1', partition: 0 }).reason).toBe(
      INGESTION_FAILURE_REASONS.REPLAY_UNSUPPORTED_EVENT,
    );
  });

  it.each([
    ['an undeclared key', payload({ payload: { amount: '100' } })],
    ['a report id that is not one', payload({ reportId: 'rpl-nope' })],
    ['an operator with a space', payload({ operator: 'alice smith' })],
    [
      'a source that is not a dead letter',
      payload({ dlq: { topic: 'rasta.fleet.v1', partition: 0, offset: '1' } }),
    ],
    [
      'a target that is not a .retry',
      payload({ target: { topic: 'rasta.fleet.v1', partition: 0, offset: '1' } }),
    ],
    [
      'an offset that is not a decimal string',
      payload({ target: { topic: 'rasta.fleet.v1.retry', partition: 0, offset: 40 } }),
    ],
    ['a verdict outside the three', payload({ stale: 'MAYBE' })],
  ])('refuses a payload with %s, naming no value', (_what, body) => {
    const error = refusal(record({}, body));
    expect(error.reason).toBe(INGESTION_FAILURE_REASONS.REPLAY_INVALID_PAYLOAD);
    expect(error.message).not.toMatch(/alice smith|100|MAYBE|rpl-nope/);
  });

  it('refuses a record that disagrees with itself about its run or its operator', () => {
    expect(refusal(record({ correlationId: 'COR_OTHER' })).reason).toBe(
      INGESTION_FAILURE_REASONS.REPLAY_INVALID_PAYLOAD,
    );
    expect(refusal(record({ actor: { type: 'USER', id: 'ops.bob' } })).reason).toBe(
      INGESTION_FAILURE_REASONS.REPLAY_INVALID_PAYLOAD,
    );
    expect(refusal(record({ actor: { type: 'SERVICE', id: 'ops.alice' } })).reason).toBe(
      INGESTION_FAILURE_REASONS.REPLAY_INVALID_PAYLOAD,
    );
    const anonymous = record();
    delete (anonymous as { actor?: unknown }).actor;
    expect(refusal(anonymous).reason).toBe(INGESTION_FAILURE_REASONS.REPLAY_INVALID_PAYLOAD);
  });
});
