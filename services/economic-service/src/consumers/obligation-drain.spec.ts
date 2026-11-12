import { Logger } from '@nestjs/common';
import type { EventEnvelope } from '@rasta/contracts';
import {
  OutboxShutdown,
  WorkerAbandonedError,
  type EventConsumer,
  type OutboxStopOptions,
} from '@rasta/nest-common';
import { RewardTriggerConsumer } from './reward-trigger.consumer';
import { StatementSettlementConsumer } from './statement-settlement.consumer';
import { SettlementAuthorityConsumer } from './settlement-authority.consumer';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

describe.each([StatementSettlementConsumer, SettlementAuthorityConsumer, RewardTriggerConsumer])(
  '%s combined drain',
  (Consumer) => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    });
    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    function setup(stop: (options?: OutboxStopOptions) => Promise<void>) {
      const entered = deferred();
      const held = deferred();
      const findUnique = jest.fn(async () => {
        entered.resolve();
        await held.promise;
        return {};
      });
      const consumer = new Consumer(
        () => ({ stop }) as unknown as EventConsumer,
        { client: { processedEvent: { findUnique } } } as never,
        {} as never,
        {} as never,
        null as never,
      );
      const statement = Consumer === StatementSettlementConsumer;
      const reward = Consumer === RewardTriggerConsumer;
      const event = {
        eventId: 'EVT-DRAIN',
        tenantId: 'ORG-A',
        correlationId: 'COR-DRAIN',
        eventName: statement
          ? 'STATEMENT_APPROVED'
          : reward
            ? 'USAGE_RECORDED'
            : 'MAINTENANCE_APPROVED',
        payload: {
          organizationId: 'ORG-A',
          approvedAt: '2026-11-10T00:00:00.000Z',
          ...(statement
            ? {
                statementId: 'STM-A',
                contractId: 'CTR-A',
                statementNumber: 1,
                contractorOrganizationId: 'ORG-B',
              }
            : {
                requestId: 'MNT-A',
                assetId: 'AST-A',
                workshopOrganizationId: 'ORG-B',
                approvedBy: 'USR-A',
                totalCostMinor: '450000',
                currency: 'IRR',
              }),
          ...(reward ? { usageRecordId: 'USG-A', assetId: 'AST-A', hours: '8' } : {}),
        },
      } as EventEnvelope;
      return { consumer, event, entered, held, findUnique };
    }

    it.each(['lone rejection', 'sibling success', 'sibling abandonment'] as const)(
      'retains direct failure through %s before database close',
      async (mode) => {
        const { consumer, event, held, findUnique: read } = setup(async () => undefined);
        const sibling = deferred();
        read.mockImplementationOnce(async () => {
          await held.promise;
          return {};
        });
        read.mockImplementationOnce(async () => {
          await sibling.promise;
          return {};
        });
        const failure = new Error('direct work failed');
        const work = consumer.handle(event).catch((error: unknown) => error);
        // The first read is entered synchronously, before stop snapshots pending work.
        const other =
          mode === 'lone rejection'
            ? undefined
            : consumer.handle(event).catch((error: unknown) => error);
        const first = consumer.stop({ deadlineAt: Date.now() + 100 });
        const outcome = first.catch((error: unknown) => error);
        const database = jest.fn(async () => undefined);
        const shutdown = new OutboxShutdown({
          relay: { stop: async () => undefined },
          workers: [consumer],
          databases: [{ stop: database }],
          budgetMs: 100,
          logger: { error: jest.fn() },
        });
        const closed = shutdown.stop().catch((error: unknown) => error);
        held.reject(failure);
        expect(await work).toBe(failure);
        if (other) {
          await flush();
          expect(database).not.toHaveBeenCalled();
          if (mode === 'sibling success') sibling.resolve();
          else await jest.advanceTimersByTimeAsync(100);
        }
        expect(await outcome).toBe(failure);
        expect(await closed).toBe(failure);
        expect(database).toHaveBeenCalledTimes(1);
        if (other) {
          sibling.resolve();
          if (mode === 'sibling success') expect(await other).toBe('SKIPPED');
          else expect(await other).toBeInstanceOf(WorkerAbandonedError);
        }
      },
    );

    it.each(['complete', 'abandon', 'sync throw'] as const)(
      'broker failure waits for direct work to %s before database close',
      async (mode) => {
        const failure = new Error('broker disconnect failed');
        const stop = jest.fn(() => {
          if (mode === 'sync throw') throw failure;
          return Promise.reject(failure);
        });
        const { consumer, event, entered, held } = setup(stop);
        const handler = consumer.handle(event);
        const late = handler.catch((error: unknown) => error);
        await entered.promise;
        const database = jest.fn(async () => undefined);
        const shutdown = new OutboxShutdown({
          relay: { stop: async () => undefined },
          workers: [consumer],
          databases: [{ stop: database }],
          budgetMs: 100,
          logger: { error: jest.fn() },
        });
        const stopped = expect(shutdown.stop()).rejects.toBe(failure);
        await flush();
        expect(database).not.toHaveBeenCalled();
        if (mode === 'abandon') await jest.advanceTimersByTimeAsync(100);
        else held.resolve();
        await stopped;
        expect(database).toHaveBeenCalledTimes(1);
        if (mode === 'abandon') {
          held.resolve();
          expect(await late).toBeInstanceOf(WorkerAbandonedError);
        } else expect(await late).toBe('SKIPPED');
      },
    );

    it.each([
      [undefined, 10],
      [1000, 10],
      [undefined, -1],
    ] as const)(
      'tightens initial deadline %s by %s ms, sharing one promise without extension',
      async (initial, delay) => {
        const broker = deferred();
        const stop = jest.fn(() => broker.promise);
        const { consumer, event, entered, held } = setup(stop);
        const handler = consumer.handle(event).catch((error: unknown) => error);
        await entered.promise;
        const first = consumer.stop(
          initial === undefined ? {} : { deadlineAt: Date.now() + initial },
        );
        const shorter = Date.now() + delay;
        expect(consumer.stop({ deadlineAt: shorter })).toBe(first);
        expect(consumer.stop({ deadlineAt: Date.now() + 5000 })).toBe(first);
        expect(consumer.onApplicationShutdown()).toBe(first);
        expect(stop.mock.calls).toHaveLength(2);
        expect(stop.mock.calls[1]).toEqual([{ deadlineAt: shorter }]);
        await jest.advanceTimersByTimeAsync(Math.max(0, delay));
        await first;
        held.resolve();
        broker.resolve();
        expect(await handler).toBeInstanceOf(WorkerAbandonedError);
      },
    );
  },
);
