import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError, getContext, type EventConsumer } from '@rasta/nest-common';
import { registry } from '@rasta/observability';
import {
  MaintenanceFactsConsumer,
  maintenanceFactsConsumerFactory,
} from './maintenance-facts.consumer';
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

  const quietLog = { info: () => undefined, warn: () => undefined, debug: () => undefined };

  it('starts the consumer its factory builds and stops the same one, by the deadline it is given', async () => {
    const calls: string[] = [];
    const fake = {
      start: async () => void calls.push('start'),
      stop: async (options?: { deadlineAt?: number }) =>
        void calls.push(`stop by ${options?.deadlineAt}`),
      isRunning: () => true,
    };
    const facts = {
      recordCoverageStart: async (name: string) => void calls.push(`coverage ${name}`),
    };
    const consumer = new MaintenanceFactsConsumer(
      () => fake as never,
      {} as PrismaService,
      facts as unknown as MaintenanceFactRepository,
      quietLog,
    );
    await consumer.start();
    expect(consumer.isRunning()).toBe(true);
    await consumer.stop({ deadlineAt: 1234 });
    expect(calls).toEqual(['start', `coverage ${MAINTENANCE_FACTS_CONSUMER}`, 'stop by 1234']);
  });

  it('records coverage only AFTER the consumer is running: a failed start claims nothing (Q-154)', async () => {
    const recorded = jest.fn();
    const fake = {
      start: async () => {
        throw new Error('broker unreachable');
      },
      stop: async () => undefined,
      isRunning: () => false,
    };
    const consumer = new MaintenanceFactsConsumer(
      () => fake as never,
      {} as PrismaService,
      { recordCoverageStart: recorded } as unknown as MaintenanceFactRepository,
      quietLog,
    );
    await expect(consumer.start()).rejects.toThrow('broker unreachable');
    expect(recorded).not.toHaveBeenCalled();
  });

  it('stops the consumer again when the coverage start cannot be recorded, and refuses to start', async () => {
    const stopAfterFailedStart = jest.fn(async () => undefined);
    const fake = { start: async () => undefined, stopAfterFailedStart, isRunning: () => true };
    const consumer = new MaintenanceFactsConsumer(
      () => fake as never,
      {} as PrismaService,
      {
        recordCoverageStart: async () => {
          throw new Error('database unavailable');
        },
      } as unknown as MaintenanceFactRepository,
      quietLog,
    );
    await expect(consumer.start()).rejects.toThrow('database unavailable');
    expect(stopAfterFailedStart).toHaveBeenCalledTimes(1);
    expect(stopAfterFailedStart).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'database unavailable' }),
    );
  });

  describe('startup-failure cleanup is bounded (PR #493 r1, F1)', () => {
    const BUDGET_MS = 200;
    const connection = {
      brokers: ['localhost:9092'],
      clientId: 'analytics-service',
      shutdownBudgetMs: BUDGET_MS,
    };

    /** The REAL EventConsumer from the real factory; only the kafkajs client is a fake. */
    function realConsumer(disconnect: 'stalls' | 'fails', lines: string[]) {
      const kafka = {
        disconnects: 0,
        connect: async () => undefined,
        subscribe: async () => undefined,
        run: async () => undefined,
        disconnect: async (): Promise<void> => {
          kafka.disconnects += 1;
          if (disconnect === 'stalls') return new Promise<void>(() => undefined);
          throw new Error('Connection already closed');
        },
      };
      const factory = maintenanceFactsConsumerFactory(
        connection as never,
        {
          info: () => undefined,
          warn: (m: string) => void lines.push(`warn: ${m}`),
          error: (_: unknown, m?: string) => void lines.push(`error: ${m}`),
        } as never,
      );
      const consumer = new MaintenanceFactsConsumer(
        (handler) => {
          const real: EventConsumer = factory(handler);
          (real as unknown as { kafka: unknown }).kafka = { consumer: () => kafka };
          return real;
        },
        {} as PrismaService,
        {
          recordCoverageStart: async () => {
            throw new Error('database unavailable');
          },
        } as unknown as MaintenanceFactRepository,
        quietLog,
      );
      return { consumer, kafka };
    }

    it('rejects with the coverage error within the budget when the Kafka disconnect stalls', async () => {
      const lines: string[] = [];
      const { consumer, kafka } = realConsumer('stalls', lines);

      const startedAt = Date.now();
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        consumer.start().then(
          () => 'started',
          (error: Error) => `rejected: ${error.message}`,
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('STALLED'), 2000);
        }),
      ]);
      clearTimeout(timer);

      expect(outcome).toBe('rejected: database unavailable');
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(BUDGET_MS - 20);
      expect(Date.now() - startedAt).toBeLessThan(1500);
      expect(kafka.disconnects).toBe(1);
      expect(consumer.isRunning()).toBe(false);
      expect(
        lines.some((line) => line.includes('cleanup after a failed start did not finish')),
      ).toBe(true);
    });

    it('rejects with the coverage error, not the disconnect error, when the cleanup fails', async () => {
      const lines: string[] = [];
      const { consumer } = realConsumer('fails', lines);

      await expect(consumer.start()).rejects.toThrow('database unavailable');

      expect(lines.some((line) => line.includes('Connection already closed'))).toBe(true);
    });
  });

  it('handling a delivery never touches coverage: replay, duplicate and rollback cannot advance it', async () => {
    const recordCoverageStart = jest.fn();
    const facts = {
      recordCoverageStart,
      record: async () => ({ kind: 'ALREADY_PROCESSED' }),
    };
    const prisma = { transaction: async (fn: (tx: unknown) => unknown) => fn({}) };
    const consumer = new MaintenanceFactsConsumer(
      () => {
        throw new Error('not started in this suite');
      },
      prisma as unknown as PrismaService,
      facts as unknown as MaintenanceFactRepository,
      quietLog,
    );
    await consumer.handle(envelope());
    await consumer.handle(envelope());
    expect(recordCoverageStart).not.toHaveBeenCalled();
  });
});
