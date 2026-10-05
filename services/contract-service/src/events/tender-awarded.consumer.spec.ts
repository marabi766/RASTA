import { EventConsumer } from '@rasta/nest-common';
import {
  TENDER_AWARDED_CONSUMER,
  TENDER_AWARDED_FIELDS,
  TENDER_AWARDED_TOPICS,
  TenderAwardedConsumer,
  tenderAwardedConsumerFactory,
} from './tender-awarded.consumer';
import type { PrismaService } from '../prisma/prisma.service';
import type { ContractRepository } from '../contract/contract.repository';
import type { EventPublisher } from './publisher';
import type { AwardSource } from '../award/award-source.client';

const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };

function consumerWith(factory: ConstructorParameters<typeof TenderAwardedConsumer>[0]) {
  return new TenderAwardedConsumer(
    factory,
    {} as PrismaService,
    {} as ContractRepository,
    {} as EventPublisher,
    {} as AwardSource,
    silent,
  );
}

describe('TenderAwardedConsumer lifecycle', () => {
  it('builds its EventConsumer with its own handler on start, and stops it on stop', async () => {
    const start = jest.fn(async () => undefined);
    const stop = jest.fn(async () => undefined);
    const factory = jest.fn(() => ({ start, stop }) as unknown as EventConsumer);
    const consumer = consumerWith(factory);

    await consumer.start();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);

    await consumer.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('is safe to stop before it was started', async () => {
    await expect(consumerWith(jest.fn()).stop()).resolves.toBeUndefined();
  });

  it('hands the shared consumer an event handler that skips what is not its event', async () => {
    let handler: ((envelope: never) => Promise<unknown>) | undefined;
    const factory = jest.fn((h: never) => {
      handler = h;
      return {
        start: async () => undefined,
        stop: async () => undefined,
      } as unknown as EventConsumer;
    });
    await consumerWith(factory as never).start();

    expect(await handler?.({ eventName: 'SOMETHING_ELSE' } as never)).toBe('SKIPPED');
  });
});

describe('tenderAwardedConsumerFactory', () => {
  it('reads the construction topic under its own group, and dead-letters to its own topic', () => {
    expect(TENDER_AWARDED_CONSUMER).toBe('contract-service.tender-awarded');
    expect(TENDER_AWARDED_TOPICS).toEqual(['rasta.construction.v1']);

    const factory = tenderAwardedConsumerFactory(
      { brokers: ['localhost:19092'], clientId: 'test' },
      { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      { maxRetries: 3, retryBackoffMs: 50 },
    );
    expect(factory(async () => undefined)).toBeInstanceOf(EventConsumer);
  });

  it('names exactly the fields the payload schema declares, for a dead-letter message', () => {
    expect([...TENDER_AWARDED_FIELDS].sort()).toEqual(
      [
        'awardedAt',
        'awardedBy',
        'matrixDigest',
        'organizationId',
        'projectId',
        'tenderId',
        'winnerOrganizationId',
        'winningBidId',
      ].sort(),
    );
  });
});
