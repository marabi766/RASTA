import { DLQ_HEADERS, DLQ_REASONS, TOPIC_PRODUCERS } from '@rasta/contracts';
import { dlqMessagesTotal } from '@rasta/observability';
import {
  EventConsumer,
  subscribedTopics,
  type ConsumerLogger,
  type EventHandler,
} from './event-consumer';

/**
 * D-039 and D-040: a replay lands on `<topic>.retry`, is judged as the original
 * topic was, and a dead letter keeps the publisher's partition key.
 *
 * Driven through the real `EventConsumer` with a fake dead-letter producer and
 * a fake kafkajs consumer, so no broker is needed. The broker-backed halves
 * (the SASL ACLs, the per-service `processed_event` idempotency) are in the
 * consuming services' integration suites.
 */

interface SentRecord {
  topic: string;
  messages: { key: Buffer | null; value: Buffer | null; headers: Record<string, unknown> }[];
}

class FakeDlqProducer {
  readonly sent: SentRecord[] = [];

  async send(record: SentRecord): Promise<void> {
    this.sent.push(record);
  }
}

interface PrivateHandle {
  dlqProducer?: FakeDlqProducer;
  kafka: { consumer(config: unknown): unknown };
  handleMessage(
    topic: string,
    partition: number,
    value: Buffer | null,
    headers: undefined,
    offset?: string,
    key?: Buffer | null,
  ): Promise<void>;
}

const TOPIC = 'rasta.asset.v1';
const RETRY = `${TOPIC}.retry`;
const OWNER = TOPIC_PRODUCERS[TOPIC][0];
const silent: ConsumerLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function bytes(producer: string, eventId = '01JRETRYTOPICSPEC0000001'): Buffer {
  return Buffer.from(
    JSON.stringify({
      eventId,
      eventName: 'ASSET_DECOMMISSIONED',
      eventVersion: 1,
      occurredAt: '2026-09-29T10:00:00.000Z',
      producer,
      producerVersion: '1.0.0',
      aggregateType: 'Asset',
      aggregateId: 'AST_RETRY_1',
      correlationId: 'corr-retry',
      tenantId: 'ORG_RETRY',
      payload: {},
    }),
    'utf8',
  );
}

function build(handler: EventHandler): { handle: PrivateHandle; dlq: FakeDlqProducer } {
  const dlq = new FakeDlqProducer();
  const consumer = new EventConsumer(
    {
      brokers: ['localhost:9092'],
      clientId: 'nest-common-retry-topic-spec',
      groupId: 'nest-common-retry-topic-spec.group',
      topics: [TOPIC],
      deadLetterTopic: 'rasta.test.v1.dlq',
      maxRetries: 1,
      retryBackoffMs: 0,
    },
    handler,
    silent,
  );
  const handle = consumer as unknown as PrivateHandle;
  handle.dlqProducer = dlq;
  return { handle, dlq };
}

beforeEach(() => {
  dlqMessagesTotal.reset();
});

afterAll(() => {
  dlqMessagesTotal.reset();
});

describe('subscribedTopics', () => {
  it('adds the .retry twin after each topic, once', () => {
    expect(subscribedTopics([TOPIC, 'rasta.fleet.v1'])).toEqual([
      TOPIC,
      RETRY,
      'rasta.fleet.v1',
      'rasta.fleet.v1.retry',
    ]);
    expect(subscribedTopics([RETRY, TOPIC])).toEqual([RETRY, TOPIC]);
    expect(subscribedTopics([TOPIC, TOPIC])).toEqual([TOPIC, RETRY]);
  });
});

describe('a record delivered on <topic>.retry', () => {
  it('reaches the handler like the original, saying it came from the retry topic', async () => {
    const seen: { eventId: string; topic: string }[] = [];
    const { handle, dlq } = build(async (envelope, delivery) => {
      seen.push({ eventId: envelope.eventId, topic: delivery.topic });
    });

    await handle.handleMessage(RETRY, 0, bytes(OWNER), undefined);

    expect(seen).toEqual([{ eventId: '01JRETRYTOPICSPEC0000001', topic: RETRY }]);
    expect(dlq.sent).toEqual([]);
  });

  it('is dead-lettered PRODUCER_NOT_ALLOWED when the producer is not the original topic’s', async () => {
    const handled: string[] = [];
    const { handle, dlq } = build(async (envelope) => {
      handled.push(envelope.eventId);
    });

    await handle.handleMessage(RETRY, 0, bytes('fleet-service'), undefined);

    expect(handled).toEqual([]);
    expect(dlq.sent).toHaveLength(1);
    expect(dlq.sent[0]?.topic).toBe('rasta.test.v1.dlq');
    const headers = dlq.sent[0]?.messages[0]?.headers ?? {};
    expect(headers[DLQ_HEADERS.reason]).toBe(DLQ_REASONS.PRODUCER_NOT_ALLOWED);
    expect(headers[DLQ_HEADERS.originalTopic]).toBe(RETRY);
  });

  it('is dead-lettered VALIDATION_FAILED when the envelope is malformed', async () => {
    const { handle, dlq } = build(async () => undefined);

    await handle.handleMessage(RETRY, 0, Buffer.from('not json', 'utf8'), undefined);

    const headers = dlq.sent[0]?.messages[0]?.headers ?? {};
    expect(headers[DLQ_HEADERS.reason]).toBe(DLQ_REASONS.VALIDATION_FAILED);
  });
});

describe('the dead letter keeps the original message key (D-040)', () => {
  const key = Buffer.from('AST_RETRY_1', 'utf8');

  it.each([
    ['a malformed body', () => Buffer.from('not json', 'utf8'), async () => undefined],
    ['a foreign producer', () => bytes('fleet-service'), async () => undefined],
    [
      'a failing handler',
      () => bytes(OWNER),
      async () => {
        throw new Error('database unavailable');
      },
    ],
  ])('for %s', async (_name, body, handler) => {
    const { handle, dlq } = build(handler);

    await handle.handleMessage(TOPIC, 3, body(), undefined, '42', key);

    const message = dlq.sent[0]?.messages[0];
    expect(message?.key?.toString('utf8')).toBe('AST_RETRY_1');
    expect(message?.headers[DLQ_HEADERS.originalPartition]).toBe('3');
    expect(message?.headers[DLQ_HEADERS.originalOffset]).toBe('42');
  });

  it('writes a keyless record when the original had none', async () => {
    const { handle, dlq } = build(async () => undefined);

    await handle.handleMessage(TOPIC, 0, Buffer.from('not json', 'utf8'), undefined, '1', null);

    expect(dlq.sent[0]?.messages[0]?.key).toBeNull();
  });
});
