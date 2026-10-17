import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError, getContext } from '@rasta/nest-common';
import { registry } from '@rasta/observability';
import { MaintenanceFactsConsumer } from './maintenance-facts.consumer';
import type { MaintenanceFactRepository, RecordResult } from './maintenance-fact.repository';
import {
  MAINTENANCE_FACTS_CONSUMER,
  toMaintenanceFact,
  type MaintenanceFact,
} from './maintenance-fact';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The handler's decisions, with the database replaced: what each repository answer becomes,
 * which tenant the writes run under, and what is counted. That the database really gives
 * those answers — the keys, the race, the rollback — is `test/maintenance-facts.int-spec.ts`.
 */

const ORG = 'ORG_A';

function envelope(overrides: Partial<EventEnvelope> = {}, payload: object = {}): EventEnvelope {
  return {
    eventId: 'EVT_1',
    eventName: 'MAINTENANCE_COMPLETED',
    eventVersion: 1,
    occurredAt: '2026-10-10T08:00:00.000Z',
    producer: 'maintenance-service',
    aggregateType: 'MaintenanceRequest',
    aggregateId: 'MRQ_1',
    tenantId: ORG,
    correlationId: 'COR_1',
    payload: {
      requestId: 'MRQ_1',
      assetId: 'AST_1',
      organizationId: ORG,
      type: 'CORRECTIVE',
      scheduleId: null,
      completedAt: '2026-10-10T07:59:00.000Z',
      downtimeMinutes: null,
      totalCostMinor: '500',
      currency: 'IRR',
      ...payload,
    },
    ...overrides,
  } as EventEnvelope;
}

function harness(answer: (fact: MaintenanceFact) => RecordResult) {
  const seen: { tenant?: string; consumer?: string; correlation?: string } = {};
  let committed = false;
  const prisma = {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const result = await fn({});
      committed = true;
      return result;
    },
  } as unknown as PrismaService;
  const facts = {
    record: async (_tx: unknown, consumer: string, fact: MaintenanceFact) => {
      seen.tenant = getContext().organizationId;
      seen.correlation = getContext().correlationId;
      seen.consumer = consumer;
      return answer(fact);
    },
  } as unknown as MaintenanceFactRepository;
  const quiet = { info: () => undefined, warn: () => undefined, debug: () => undefined };
  const consumer = new MaintenanceFactsConsumer(
    () => {
      throw new Error('not started in this suite');
    },
    prisma,
    facts,
    quiet,
  );
  return { consumer, seen, committed: () => committed };
}

async function counted(outcome: string, event = 'MAINTENANCE_COMPLETED'): Promise<number> {
  const metric = await registry.getSingleMetric('rasta_analytics_facts_projected_total')?.get();
  return (
    metric?.values.find(
      (v) =>
        v.labels.consumer === MAINTENANCE_FACTS_CONSUMER &&
        v.labels.event === event &&
        v.labels.outcome === outcome,
    )?.value ?? 0
  );
}

describe('MaintenanceFactsConsumer.handle', () => {
  it('applies a new fact under the envelope’s tenant and correlation id, with its own marker key', async () => {
    const before = await counted('applied');
    const { consumer, seen, committed } = harness(() => ({ kind: 'APPLIED' }));

    await expect(consumer.handle(envelope())).resolves.toBeUndefined();
    expect(seen).toEqual({
      tenant: ORG,
      consumer: MAINTENANCE_FACTS_CONSUMER,
      correlation: 'COR_1',
    });
    expect(committed()).toBe(true);
    expect(await counted('applied')).toBe(before + 1);
  });

  it('skips an event already applied, with no second effect', async () => {
    const before = await counted('duplicate');
    const { consumer } = harness(() => ({ kind: 'ALREADY_PROCESSED' }));

    await expect(consumer.handle(envelope())).resolves.toBe('SKIPPED');
    expect(await counted('duplicate')).toBe(before + 1);
  });

  it('skips another statement of the same fact, and commits its marker', async () => {
    const { consumer, committed } = harness((fact) => ({
      kind: 'FACT_HELD',
      held: { ...fact, sourceEventId: 'EVT_0' },
    }));

    await expect(consumer.handle(envelope({ eventId: 'EVT_2' }))).resolves.toBe('SKIPPED');
    expect(committed()).toBe(true);
  });

  it('dead-letters a contradiction inside the transaction, so nothing commits', async () => {
    const before = await counted('conflict');
    const held = toMaintenanceFact(envelope({ eventId: 'EVT_0' })) as MaintenanceFact;
    const { consumer, committed } = harness(() => ({ kind: 'FACT_HELD', held }));

    const handled = consumer.handle(envelope({ eventId: 'EVT_2' }, { totalCostMinor: '501' }));
    await expect(handled).rejects.toBeInstanceOf(UnprocessableEventError);
    await expect(handled).rejects.toMatchObject({ reason: DLQ_REASONS.BUSINESS_RULE_VIOLATION });
    expect(committed()).toBe(false);
    expect(await counted('conflict')).toBe(before + 1);
  });

  it('skips an event it does not read, under one fixed label whatever the name', async () => {
    const before = await counted('skipped', 'OTHER');
    const { consumer, seen } = harness(() => {
      throw new Error('never asked');
    });

    await expect(consumer.handle(envelope({ eventName: 'SOMETHING_NEW' }))).resolves.toBe(
      'SKIPPED',
    );
    expect(seen.tenant).toBeUndefined();
    expect(await counted('skipped', 'OTHER')).toBe(before + 1);
    expect(await counted('skipped', 'SOMETHING_NEW')).toBe(0);
  });

  it('lets a database failure escape to be retried, counted as nothing', async () => {
    const before = await counted('conflict');
    const { consumer } = harness(() => {
      throw new Error('connection reset');
    });

    await expect(consumer.handle(envelope())).rejects.toThrow('connection reset');
    expect(await counted('conflict')).toBe(before);
  });
});

describe('MaintenanceFactsConsumer lifecycle', () => {
  it('is not running before start, and stopping it unstarted is harmless', async () => {
    const { consumer } = harness(() => ({ kind: 'APPLIED' }));
    expect(consumer.isRunning()).toBe(false);
    await expect(consumer.stop()).resolves.toBeUndefined();
  });

  it('starts the consumer its factory builds and stops the same one', async () => {
    const calls: string[] = [];
    const fake = {
      start: async () => void calls.push('start'),
      stop: async () => void calls.push('stop'),
      isRunning: () => true,
    };
    const consumer = new MaintenanceFactsConsumer(
      () => fake as never,
      {} as PrismaService,
      {} as MaintenanceFactRepository,
      { info: () => undefined, warn: () => undefined, debug: () => undefined },
    );
    await consumer.start();
    expect(consumer.isRunning()).toBe(true);
    await consumer.stop();
    expect(calls).toEqual(['start', 'stop']);
  });
});
