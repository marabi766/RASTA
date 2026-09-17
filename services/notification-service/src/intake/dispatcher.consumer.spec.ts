import { ulid } from 'ulid';
import type { EventEnvelope } from '@rasta/contracts';
import { registry } from '@rasta/observability';
import { DispatcherConsumer } from './dispatcher.consumer';
import { PoisonEventError } from './intake';
import type {
  IngestOutcome,
  NotificationRepository,
} from '../notification/notification.repository';
import type { ScrubbedLogger } from '../logging/scrub';

const delivery = Object.freeze({ topic: 'rasta.maintenance.v1', partition: 1 });

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: ulid(),
    eventName: 'MAINTENANCE_DUE',
    eventVersion: 1,
    occurredAt: '2026-09-17T06:00:00.000Z',
    producer: 'maintenance-service',
    producerVersion: '0.1.0',
    aggregateType: 'MaintenanceSchedule',
    aggregateId: 'SCH_1',
    tenantId: 'ORG_A',
    correlationId: 'COR_1',
    payload: {
      scheduleId: 'SCH_1',
      assetId: 'AST_1',
      organizationId: 'ORG_A',
      title: 'تعویض روغن',
      basis: 'HOURS',
      state: 'DUE_SOON',
      dueBy: null,
      dueAtMeter: '1200',
    },
    ...overrides,
  };
}

function silent(): ScrubbedLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (message: string) => void lines.push(message);
  return { lines, info: push, warn: push, error: push, debug: push };
}

function fakeRepository(outcome: IngestOutcome): {
  repository: NotificationRepository;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const repository = {
    ingest: jest.fn(async (intent: unknown, days: number) => {
      calls.push({ intent, days });
      return outcome;
    }),
  } as unknown as NotificationRepository;
  return { repository, calls };
}

async function counter(name: string, labels: Record<string, string>): Promise<number> {
  const metric = await registry.getSingleMetric(name)?.get();
  const sample = metric?.values.find((value) =>
    Object.entries(labels).every(([key, expected]) => value.labels[key] === expected),
  );
  return sample?.value ?? 0;
}

describe('DispatcherConsumer.handle', () => {
  const noConsumer = () => {
    throw new Error('the consumer factory is not exercised by these tests');
  };

  it('skips an event no rule claims without touching the repository', async () => {
    const { repository } = fakeRepository({ kind: 'CREATED' });
    const consumer = new DispatcherConsumer(noConsumer, repository, 45, silent());

    await expect(
      consumer.handle(envelope({ eventName: 'MAINTENANCE_CREATED' }), delivery),
    ).resolves.toBe('SKIPPED');
    expect(repository.ingest).not.toHaveBeenCalled();
  });

  it('writes an intent for a supported event and counts it', async () => {
    const { repository, calls } = fakeRepository({ kind: 'CREATED' });
    const logger = silent();
    const consumer = new DispatcherConsumer(noConsumer, repository, 45, logger);
    const before = await counter('rasta_notification_intents_total', {
      event_name: 'MAINTENANCE_DUE',
      rule_key: 'maintenance.due',
    });

    await expect(consumer.handle(envelope(), delivery)).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect((calls[0] as { days: number }).days).toBe(45);
    expect(
      await counter('rasta_notification_intents_total', {
        event_name: 'MAINTENANCE_DUE',
        rule_key: 'maintenance.due',
      }),
    ).toBe(before + 1);
    expect(logger.lines.some((line) => line.includes('pending resolution'))).toBe(true);
  });

  it('reports a semantic repeat as skipped and counts the dedupe', async () => {
    const { repository } = fakeRepository({ kind: 'DEDUPED', seenCount: 7 });
    const consumer = new DispatcherConsumer(noConsumer, repository, 45, silent());
    const before = await counter('rasta_notification_deduped_total', {
      rule_key: 'maintenance.due',
    });

    await expect(consumer.handle(envelope(), delivery)).resolves.toBe('SKIPPED');
    expect(await counter('rasta_notification_deduped_total', { rule_key: 'maintenance.due' })).toBe(
      before + 1,
    );
  });

  it('reports a stale event as skipped and counts the discard', async () => {
    const { repository } = fakeRepository({ kind: 'DISCARDED_STALE' });
    const consumer = new DispatcherConsumer(noConsumer, repository, 45, silent());
    const before = await counter('rasta_notification_intents_discarded_total', {
      reason: 'STALE_STREAM_SEQ',
    });

    await expect(consumer.handle(envelope(), delivery)).resolves.toBe('SKIPPED');
    expect(
      await counter('rasta_notification_intents_discarded_total', { reason: 'STALE_STREAM_SEQ' }),
    ).toBe(before + 1);
  });

  it('reports an already-processed event as skipped', async () => {
    const { repository } = fakeRepository({ kind: 'DUPLICATE_EVENT' });
    const consumer = new DispatcherConsumer(noConsumer, repository, 45, silent());
    await expect(consumer.handle(envelope(), delivery)).resolves.toBe('SKIPPED');
  });

  it('throws a poison event so the shared consumer dead-letters it, and counts it', async () => {
    const { repository } = fakeRepository({ kind: 'CREATED' });
    const logger = silent();
    const consumer = new DispatcherConsumer(noConsumer, repository, 45, logger);
    const before = await counter('rasta_notification_poison_events_total', {
      reason: 'PAYLOAD_INVALID',
    });

    await expect(
      consumer.handle(envelope({ payload: { scheduleId: 'SCH_1', state: 7 } }), delivery),
    ).rejects.toBeInstanceOf(PoisonEventError);

    expect(repository.ingest).not.toHaveBeenCalled();
    expect(
      await counter('rasta_notification_poison_events_total', { reason: 'PAYLOAD_INVALID' }),
    ).toBe(before + 1);
    expect(logger.lines.join('\n')).toContain('Refusing MAINTENANCE_DUE');
  });

  it('counts refused context keys without logging them', async () => {
    const { repository } = fakeRepository({ kind: 'CREATED' });
    const logger = silent();
    const consumer = new DispatcherConsumer(noConsumer, repository, 45, logger);
    const before = await counter('rasta_notification_context_keys_dropped_total', {
      rule_key: 'maintenance.due',
    });

    await consumer.handle(
      envelope({ payload: { ...(envelope().payload as object), bidAmount: '999', extra: 'x' } }),
      delivery,
    );

    // organizationId, bidAmount and extra are all refused: three keys.
    expect(
      await counter('rasta_notification_context_keys_dropped_total', {
        rule_key: 'maintenance.due',
      }),
    ).toBe(before + 3);
    expect(logger.lines.join('\n')).not.toContain('999');
    expect(logger.lines.join('\n')).not.toContain('bidAmount');
  });

  it('lets a database failure propagate so nothing is marked processed', async () => {
    const repository = {
      ingest: jest.fn(async () => {
        throw new Error('connection reset');
      }),
    } as unknown as NotificationRepository;
    const consumer = new DispatcherConsumer(noConsumer, repository, 45, silent());

    await expect(consumer.handle(envelope(), delivery)).rejects.toThrow('connection reset');
  });

  it('reports not running until a consumer has started', () => {
    const consumer = new DispatcherConsumer(
      noConsumer,
      fakeRepository({ kind: 'CREATED' }).repository,
      45,
      silent(),
    );
    expect(consumer.isRunning()).toBe(false);
  });
});
