import { OPS_REPLAY_TOPIC, REPLAY_EXECUTED, type EventEnvelope } from '@rasta/contracts';
import type { EventConsumer } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import type { AuditRepository } from '../audit/audit.repository';
import { OPS_REPLAY_CONSUMER, OpsReplayRejectedError } from '../audit/ops-replay.mapper';
import { auditIngestionFailuresTotal, INGESTION_FAILURE_REASONS } from '../observability/metrics';
import { OpsReplayConsumer, OpsReplayPersistenceError } from './ops-replay.consumer';

const REPORT = 'rpl-0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const DELIVERY = Object.freeze({ topic: OPS_REPLAY_TOPIC, partition: 0 });

function record(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
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
    actor: { type: 'USER', id: 'ops.alice' },
    payload: {
      reportId: REPORT,
      operator: 'ops.alice',
      replayedEvent: { eventId: 'EVT_1', eventName: 'USAGE_RECORDED', tenantId: 'ORG_1' },
      dlq: { topic: 'rasta.maintenance.v1.dlq', partition: 0, offset: '12' },
      target: { topic: 'rasta.fleet.v1.retry', partition: 1, offset: '40' },
      stale: false,
    },
    ...overrides,
  } as EventEnvelope;
}

function consumerWith(ingest: AuditRepository['ingest']) {
  const errors: string[] = [];
  const logger = {
    error: (line: string) => errors.push(line),
    debug: () => undefined,
  } as unknown as Logger;
  const consumer = new OpsReplayConsumer(
    () => ({}) as EventConsumer,
    { ingest } as unknown as AuditRepository,
    logger,
  );
  return { consumer, errors };
}

async function failures(reason: string): Promise<number> {
  const metric = await auditIngestionFailuresTotal.get();
  return metric.values.find((v) => v.labels.reason === reason)?.value ?? 0;
}

describe('OpsReplayConsumer', () => {
  it('writes one row under its own processed_event key', async () => {
    const ingest = jest.fn(async () => 'WRITTEN' as const);
    const { consumer } = consumerWith(ingest as unknown as AuditRepository['ingest']);

    await consumer.handle(record(), DELIVERY);

    expect(ingest).toHaveBeenCalledTimes(1);
    const [row, name] = ingest.mock.calls[0] as unknown as [{ resourceId: string }, string];
    expect(name).toBe(OPS_REPLAY_CONSUMER);
    expect(row.resourceId).toBe('EVT_1');
  });

  it('refuses loudly — counted, logged by id, thrown — and writes nothing', async () => {
    const ingest = jest.fn();
    const { consumer, errors } = consumerWith(ingest as unknown as AuditRepository['ingest']);
    const before = await failures(INGESTION_FAILURE_REASONS.REPLAY_TENANT_MISMATCH);

    await expect(consumer.handle(record({ tenantId: 'ORG_OTHER' }), DELIVERY)).rejects.toThrow(
      OpsReplayRejectedError,
    );

    expect(ingest).not.toHaveBeenCalled();
    expect(await failures(INGESTION_FAILURE_REASONS.REPLAY_TENANT_MISMATCH)).toBe(before + 1);
    expect(errors.join('\n')).toMatch(/EVT_REPLAY_1/);
    expect(errors.join('\n')).not.toMatch(/ORG_OTHER|ORG_1/);
  });

  it('turns a database failure into an error that quotes no value', async () => {
    const { consumer } = consumerWith(async () => {
      throw Object.assign(new Error('insert failed: values (ORG_1, ops.alice)'), { code: 'P2002' });
    });

    const thrown = await consumer.handle(record(), DELIVERY).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(OpsReplayPersistenceError);
    expect((thrown as Error).message).toBe(
      'replay record EVT_REPLAY_1 was not persisted (Error P2002)',
    );
  });

  it('treats a second delivery as the duplicate it is', async () => {
    const { consumer } = consumerWith(async () => 'DUPLICATE');
    await expect(consumer.handle(record(), DELIVERY)).resolves.toBeUndefined();
  });
});
