import {
  TOPIC_CONSUMERS,
  consumerDeclarationProblem,
  eventEnvelopeSchema,
  type EventEnvelope,
} from '@rasta/contracts';
import type { EventConsumer, EventHandler } from '@rasta/nest-common';
import type { PolicySuspensionService } from '../approval/policy-suspension.service';
import {
  CONSTRUCTION_DEAD_LETTER_TOPIC,
  ORGANIZATION_MOVES_CONSUMER,
  ORGANIZATION_MOVES_TOPICS,
  OrganizationMovedConsumer,
} from './organization-moved.consumer';

const envelope = (eventName: string, payload: unknown): EventEnvelope =>
  eventEnvelopeSchema.parse({
    eventId: 'EVT_1',
    eventName,
    occurredAt: '2026-09-30T10:00:00.000Z',
    producer: 'organization-service',
    aggregateType: 'Organization',
    aggregateId: 'ORG_M',
    tenantId: 'ORG_M',
    correlationId: 'COR_1',
    payload,
  }) as EventEnvelope;

function build(
  reconfirmAll = jest.fn().mockResolvedValue({ checked: 2, deferred: 0, suspended: ['APL_1'] }),
) {
  const info = jest.fn();
  const started: { handler?: EventHandler } = {};
  const consumer = new OrganizationMovedConsumer(
    (handler) => {
      started.handler = handler;
      return { start: async () => undefined, stop: async () => undefined } as EventConsumer;
    },
    { reconfirmAll } as unknown as PolicySuspensionService,
    { info, warn: jest.fn(), debug: jest.fn() },
  );
  return { consumer, reconfirmAll, info, started };
}

describe('the ORGANIZATION_MOVED consumer', () => {
  it('uses the trigger only: the moved organization, the event and the correlation id', async () => {
    const { consumer, reconfirmAll } = build();
    await consumer.handle(
      envelope('ORGANIZATION_MOVED', {
        organizationId: 'ORG_M',
        previousParentId: 'ORG_U',
        newParentId: 'ORG_X',
        previousPath: 'a.b',
        newPath: 'x.b',
        affectedCount: 3,
        reason: 'reorganisation',
      }),
    );
    expect(reconfirmAll).toHaveBeenCalledTimes(1);
    expect(reconfirmAll).toHaveBeenCalledWith({
      eventId: 'EVT_1',
      movedOrganizationId: 'ORG_M',
      correlationId: 'COR_1',
      callerService: 'organization-service',
    });
  });

  it.each(['ORGANIZATION_CREATED', 'ORGANIZATION_UPDATED', 'ORGANIZATION_STATUS_CHANGED'])(
    'skips %s',
    async (name) => {
      const { consumer, reconfirmAll } = build();
      await expect(consumer.handle(envelope(name, { organizationId: 'ORG_M' }))).resolves.toBe(
        'SKIPPED',
      );
      expect(reconfirmAll).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { organizationId: '' }, { organizationId: 7 }, null])(
    'dead-letters a payload that names no organization (%j), without asking anyone',
    async (payload) => {
      const { consumer, reconfirmAll } = build();
      await expect(consumer.handle(envelope('ORGANIZATION_MOVED', payload))).rejects.toMatchObject({
        name: 'UnprocessableEventError',
        reason: 'VALIDATION_FAILED',
      });
      expect(reconfirmAll).not.toHaveBeenCalled();
    },
  );

  it('lets a failure to confirm escape, so the shared consumer retries and then dead-letters', async () => {
    const failure = new Error('organization-service unreachable');
    const { consumer } = build(jest.fn().mockRejectedValue(failure));
    await expect(
      consumer.handle(envelope('ORGANIZATION_MOVED', { organizationId: 'ORG_M' })),
    ).rejects.toBe(failure);
  });

  it('subscribes its handler through the shared EventConsumer', async () => {
    const { consumer, started } = build();
    await consumer.start();
    expect(started.handler).toBeInstanceOf(Function);
    await consumer.stop();
  });

  it('is declared in TOPIC_CONSUMERS exactly as the module builds it', () => {
    expect(
      consumerDeclarationProblem('construction-service', {
        groupId: ORGANIZATION_MOVES_CONSUMER,
        topics: [...ORGANIZATION_MOVES_TOPICS],
        deadLetterTopic: CONSTRUCTION_DEAD_LETTER_TOPIC,
      }),
    ).toBeUndefined();
    expect(TOPIC_CONSUMERS['construction-service'].deadLetterTopic).toBe(
      CONSTRUCTION_DEAD_LETTER_TOPIC,
    );
  });
});
