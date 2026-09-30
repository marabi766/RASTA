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
  organizationMovesConsumerFactory,
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

function build(enqueueMove = jest.fn().mockResolvedValue({ candidates: 2, queued: 2 })) {
  const info = jest.fn();
  const started: { handler?: EventHandler } = {};
  const consumer = new OrganizationMovedConsumer(
    (handler) => {
      started.handler = handler;
      return { start: async () => undefined, stop: async () => undefined } as EventConsumer;
    },
    { enqueueMove } as unknown as PolicySuspensionService,
    { info, warn: jest.fn(), debug: jest.fn() },
  );
  return { consumer, enqueueMove, info, started };
}

describe('the ORGANIZATION_MOVED consumer', () => {
  it('uses the trigger only: the moved organization, the event and the correlation id', async () => {
    const { consumer, enqueueMove } = build();
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
    expect(enqueueMove).toHaveBeenCalledTimes(1);
    expect(enqueueMove).toHaveBeenCalledWith({
      eventId: 'EVT_1',
      movedOrganizationId: 'ORG_M',
      correlationId: 'COR_1',
    });
  });

  it.each(['ORGANIZATION_CREATED', 'ORGANIZATION_UPDATED', 'ORGANIZATION_STATUS_CHANGED'])(
    'skips %s',
    async (name) => {
      const { consumer, enqueueMove } = build();
      await expect(consumer.handle(envelope(name, { organizationId: 'ORG_M' }))).resolves.toBe(
        'SKIPPED',
      );
      expect(enqueueMove).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { organizationId: '' }, { organizationId: 7 }, null])(
    'dead-letters a payload that names no organization (%j), without asking anyone',
    async (payload) => {
      const { consumer, enqueueMove } = build();
      await expect(consumer.handle(envelope('ORGANIZATION_MOVED', payload))).rejects.toMatchObject({
        name: 'UnprocessableEventError',
        reason: 'VALIDATION_FAILED',
      });
      expect(enqueueMove).not.toHaveBeenCalled();
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

  // D-039: the shared EventConsumer subscribes each topic with its `.retry`
  // twin. Driven through the real one with a fake kafkajs consumer, so it is
  // what the module builds that is checked, not a copy of its options.
  it('subscribes rasta.organization.v1.retry, and handles a delivery from it', async () => {
    const subscribed: string[] = [];
    let eachMessage: ((message: unknown) => Promise<void>) | undefined;
    const fake = {
      connect: async () => undefined,
      disconnect: async () => undefined,
      subscribe: async ({ topic }: { topic: string }) => void subscribed.push(topic),
      run: async (config: { eachMessage: (message: unknown) => Promise<void> }) => {
        eachMessage = config.eachMessage;
      },
    };
    const { enqueueMove } = build();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const factory = organizationMovesConsumerFactory(
      { brokers: ['localhost:9092'], clientId: 'construction-service-organization-moves' },
      logger,
    );
    const consumer = new OrganizationMovedConsumer(
      (handler) => {
        const real = factory(handler);
        (real as unknown as { kafka: { consumer: () => unknown } }).kafka = {
          consumer: () => fake,
        };
        return real;
      },
      { enqueueMove } as unknown as PolicySuspensionService,
      logger,
    );

    await consumer.start();
    expect(subscribed).toEqual(['rasta.organization.v1', 'rasta.organization.v1.retry']);

    const replay = envelope('ORGANIZATION_MOVED', { organizationId: 'ORG_M' });
    await eachMessage!({
      topic: 'rasta.organization.v1.retry',
      partition: 0,
      message: { value: Buffer.from(JSON.stringify(replay)), headers: {}, offset: '7', key: null },
    });
    expect(enqueueMove).toHaveBeenCalledTimes(1);
    expect(enqueueMove).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'EVT_1', movedOrganizationId: 'ORG_M' }),
    );
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
