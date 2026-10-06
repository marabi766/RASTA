import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import { EventConsumer, UnprocessableEventError } from '@rasta/nest-common';
import type { PolicySuspensionService } from '../policy/policy-suspension.service';
import {
  ORGANIZATION_MOVES_CONSUMER,
  ORGANIZATION_MOVES_TOPICS,
  OrganizationMovedConsumer,
  organizationMovesConsumerFactory,
} from './organization-moved.consumer';

const envelope = (overrides: Partial<EventEnvelope> = {}): EventEnvelope =>
  ({
    eventId: 'EVT_1',
    eventName: 'ORGANIZATION_MOVED',
    eventVersion: 1,
    occurredAt: '2026-10-06T10:00:00.000Z',
    producer: 'organization-service',
    aggregateType: 'Organization',
    aggregateId: 'ORG_MOVED',
    correlationId: 'COR_1',
    payload: { organizationId: 'ORG_MOVED', fromParentId: 'A', toParentId: 'B' },
    ...overrides,
  }) as EventEnvelope;

function build() {
  const enqueueMove = jest.fn(async () => ({ candidates: 3, queued: 2 }));
  const info = jest.fn();
  const consumer = new OrganizationMovedConsumer(
    () => {
      throw new Error('handle() is driven directly');
    },
    { enqueueMove } as unknown as PolicySuspensionService,
    { info, warn: jest.fn(), debug: jest.fn() },
  );
  return { consumer, enqueueMove, info };
}

describe('OrganizationMovedConsumer (Q-83)', () => {
  it('reads one topic under its own group, `<service>.<purpose>`, and dead-letters to its own topic', () => {
    expect(ORGANIZATION_MOVES_CONSUMER).toBe('contract-service.organization-moves');
    expect(ORGANIZATION_MOVES_TOPICS).toEqual(['rasta.organization.v1']);

    const factory = organizationMovesConsumerFactory(
      { brokers: ['localhost:19092'], clientId: 'test' },
      { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    );
    expect(factory(async () => undefined)).toBeInstanceOf(EventConsumer);
  });

  it('builds its EventConsumer with its own handler on start, and stops it on stop; stopping first is safe', async () => {
    const start = jest.fn(async () => undefined);
    const stop = jest.fn(async () => undefined);
    const factory = jest.fn(() => ({ start, stop }) as unknown as EventConsumer);
    const consumer = new OrganizationMovedConsumer(factory, {} as PolicySuspensionService, {
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    });
    await expect(consumer.stop()).resolves.toBeUndefined();

    await consumer.start();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    await consumer.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('hands the shared consumer a handler that is this consumer’s own', async () => {
    const enqueueMove = jest.fn(async () => ({ candidates: 0, queued: 0 }));
    let handler: ((envelope: EventEnvelope) => Promise<unknown>) | undefined;
    const factory = jest.fn((h: (envelope: EventEnvelope) => Promise<unknown>) => {
      handler = h;
      return {
        start: async () => undefined,
        stop: async () => undefined,
      } as unknown as EventConsumer;
    });
    const consumer = new OrganizationMovedConsumer(
      factory as never,
      { enqueueMove } as unknown as PolicySuspensionService,
      { info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    );
    await consumer.start();
    await handler?.(envelope());
    expect(enqueueMove).toHaveBeenCalledTimes(1);
  });

  it('queues a re-check naming the event and the organization that moved — a trigger, not the answer', async () => {
    const { consumer, enqueueMove, info } = build();
    await consumer.handle(
      envelope({
        payload: {
          organizationId: 'ORG_MOVED',
          fromParentId: 'A',
          toParentId: 'B',
          hierarchyVersion: 9,
        },
      }),
    );
    expect(enqueueMove).toHaveBeenCalledWith({
      eventId: 'EVT_1',
      movedOrganizationId: 'ORG_MOVED',
      // The move's own instant, from the envelope: it bounds the signing window, nothing more.
      movedAt: new Date('2026-10-06T10:00:00.000Z'),
      // What orders a signature against the move (D-050): organization-service's version.
      movedVersion: 9,
      correlationId: 'COR_1',
    });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('2 of 3 union-written policies'));
  });

  it('an event from before versions queues the check with no version: the window alone bounds it', async () => {
    const { consumer, enqueueMove } = build();
    await consumer.handle(envelope());
    expect(enqueueMove).toHaveBeenCalledWith(expect.objectContaining({ movedVersion: null }));
  });

  it.each([0, -1, 1.5, '3', null])(
    'refuses an event whose hierarchyVersion is %p: it can never parse',
    async (hierarchyVersion) => {
      const { consumer, enqueueMove } = build();
      await expect(
        consumer.handle(envelope({ payload: { organizationId: 'ORG_MOVED', hierarchyVersion } })),
      ).rejects.toBeInstanceOf(UnprocessableEventError);
      expect(enqueueMove).not.toHaveBeenCalled();
    },
  );

  it.each(['ORGANIZATION_CREATED', 'ORGANIZATION_UPDATED'])(
    'skips %s: it is none of its business',
    async (eventName) => {
      const { consumer, enqueueMove } = build();
      await expect(consumer.handle(envelope({ eventName }))).resolves.toBe('SKIPPED');
      expect(enqueueMove).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { organizationId: '' }, { organizationId: 7 }])(
    'dead-letters a move that names no organization (%j) as VALIDATION_FAILED, never retried',
    async (payload) => {
      const { consumer, enqueueMove } = build();
      const error = await consumer.handle(envelope({ payload })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableEventError);
      expect((error as UnprocessableEventError).reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
      expect(enqueueMove).not.toHaveBeenCalled();
    },
  );

  it('lets a failed queueing fail the delivery, so it is retried and then dead-lettered', async () => {
    const { consumer, enqueueMove } = build();
    enqueueMove.mockRejectedValueOnce(new Error('database down'));
    await expect(consumer.handle(envelope())).rejects.toThrow('database down');
  });
});
