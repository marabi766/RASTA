import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError } from '@rasta/nest-common';
import type { PolicySuspensionService } from '../policy/policy-suspension.service';
import {
  ORGANIZATION_MOVES_CONSUMER,
  ORGANIZATION_MOVES_TOPICS,
  OrganizationMovedConsumer,
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
  it('reads one topic under its own group, `<service>.<purpose>`', () => {
    expect(ORGANIZATION_MOVES_CONSUMER).toBe('contract-service.organization-moves');
    expect(ORGANIZATION_MOVES_TOPICS).toEqual(['rasta.organization.v1']);
  });

  it('queues a re-check naming the event and the organization that moved — a trigger, not the answer', async () => {
    const { consumer, enqueueMove, info } = build();
    await consumer.handle(envelope());
    expect(enqueueMove).toHaveBeenCalledWith({
      eventId: 'EVT_1',
      movedOrganizationId: 'ORG_MOVED',
      correlationId: 'COR_1',
    });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('2 of 3 union-written policies'));
  });

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
