import type { OutboxRow } from '@rasta/nest-common';
import { InMemoryEventPublisher, KafkaEventPublisher } from './kafka.publisher';

/**
 * The Kafka side of the outbox relay.
 *
 * The relay guarantees at-least-once delivery; everything that keeps the
 * stream *usable* on the other side is decided here, in producer settings and
 * in how rows are batched. Those are one-line properties that no integration
 * test notices when they change: a batch that dropped the partition key would
 * still publish every event, still pass every consumer test written against a
 * single order, and silently interleave two orders' lifecycles in production.
 *
 * kafkajs itself is stubbed — it is a network client to a broker in another
 * process, and what is under test is the payload this service hands it.
 */

const sendBatch = jest.fn(async () => undefined);
const connect = jest.fn(async () => undefined);
const disconnect = jest.fn(async () => undefined);
const producer = jest.fn(() => ({ connect, sendBatch, disconnect }));

const adminConnect = jest.fn(async () => undefined);
const listTopics = jest.fn(async () => ['rasta.marketplace.v1']);
const adminDisconnect = jest.fn(async () => undefined);
const admin = jest.fn(() => ({
  connect: adminConnect,
  listTopics,
  disconnect: adminDisconnect,
}));

const kafkaOptions = jest.fn();

jest.mock('kafkajs', () => {
  const actual = jest.requireActual('kafkajs');
  return {
    ...actual,
    Kafka: function (options: unknown) {
      kafkaOptions(options);
      return { producer, admin };
    },
  };
});

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'OBX_1',
    aggregateType: 'Order',
    aggregateId: 'ORD_1',
    eventName: 'ORDER_CREATED',
    eventVersion: 1,
    topic: 'rasta.marketplace.v1',
    partitionKey: 'ORD_1',
    payload: { orderId: 'ORD_1' },
    headers: { 'x-correlation-id': 'COR_1' },
    // JUSTIFIED-ANY: `OutboxRow` is the shared relay contract and carries
    // bookkeeping columns this publisher never reads. Spelling all of them out
    // would assert a shape the code under test does not depend on.
    ...overrides,
  } as any as OutboxRow;
}

function publisher(): KafkaEventPublisher {
  return new KafkaEventPublisher({ brokers: ['broker-1:9092'], clientId: 'marketplace-test' });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the producer settings', () => {
  it('is built with a retry policy, and stays quiet enough to read', () => {
    // kafkajs at INFO logs every metadata refresh, which buries the lines an
    // operator actually needs. The retry policy is what carries the relay
    // across a broker restart without the row failing back to pending.
    void publisher();

    expect(kafkaOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'marketplace-test',
        brokers: ['broker-1:9092'],
        retry: { initialRetryTime: 300, retries: 8 },
        logLevel: 1,
      }),
    );
  });

  it('is idempotent and single-in-flight, so a retry cannot reorder a stream', async () => {
    // maxInFlightRequests=1 is the setting that keeps ORDER_CREATED before
    // ORDER_COMPLETED for one order when the first request is retried. With a
    // higher value the broker can accept the second write first.
    await publisher().publish([row()]);

    expect(producer).toHaveBeenCalledWith(
      expect.objectContaining({ idempotent: true, maxInFlightRequests: 1 }),
    );
  });

  it('refuses to create a topic it was not configured for', async () => {
    // A typo in a topic name would otherwise create it and publish into a
    // stream nobody consumes, which looks exactly like success.
    await publisher().publish([row()]);
    expect(producer).toHaveBeenCalledWith(
      expect.objectContaining({ allowAutoTopicCreation: false }),
    );
  });
});

describe('publishing', () => {
  it('does nothing at all for an empty batch', async () => {
    // The relay polls on a timer and finds nothing most of the time. Opening a
    // producer connection for each empty poll would dial the broker forever on
    // an idle service.
    await publisher().publish([]);

    expect(producer).not.toHaveBeenCalled();
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it('carries the partition key, so one order keeps its order', async () => {
    // ADR-036 as applied here. Without the key, kafkajs round-robins and two
    // events of one order can land on different partitions, where nothing
    // preserves the sequence between them.
    await publisher().publish([row({ id: 'OBX_1', partitionKey: 'ORD_9' })]);

    const [batch] = sendBatch.mock.calls[0] as unknown as [
      { acks: number; topicMessages: { topic: string; messages: { key: string }[] }[] },
    ];
    expect(batch.acks).toBe(-1);
    expect(batch.topicMessages[0].messages[0].key).toBe('ORD_9');
  });

  it('groups by topic and keeps each topic in the order it was given', async () => {
    // The relay hands rows in insertion order. Grouping must not reorder them
    // within a topic, or the batch itself becomes the thing that breaks
    // ordering the partition key was chosen to preserve.
    await publisher().publish([
      row({ id: 'A', topic: 'rasta.marketplace.v1', payload: { n: 1 } }),
      row({ id: 'B', topic: 'rasta.audit.v1', payload: { n: 2 } }),
      row({ id: 'C', topic: 'rasta.marketplace.v1', payload: { n: 3 } }),
    ]);

    const [batch] = sendBatch.mock.calls[0] as unknown as [
      { topicMessages: { topic: string; messages: { value: string }[] }[] },
    ];
    expect(batch.topicMessages).toHaveLength(2);

    const marketplace = batch.topicMessages.find((t) => t.topic === 'rasta.marketplace.v1');
    expect(marketplace?.messages.map((m) => JSON.parse(m.value).n)).toEqual([1, 3]);
    expect(batch.topicMessages.find((t) => t.topic === 'rasta.audit.v1')?.messages).toHaveLength(1);
  });

  it('passes the headers through, so a consumer can still trace the request', async () => {
    await publisher().publish([row({ headers: { 'x-correlation-id': 'COR_42' } })]);

    const [batch] = sendBatch.mock.calls[0] as unknown as [
      { topicMessages: { messages: { headers: Record<string, string> }[] }[] },
    ];
    expect(batch.topicMessages[0].messages[0].headers['x-correlation-id']).toBe('COR_42');
  });

  it('raises when the send fails, so the relay leaves the row pending', async () => {
    // The one place a failure must *not* be swallowed. A silent failure here
    // marks the outbox row published and the event is lost for good.
    sendBatch.mockRejectedValueOnce(new Error('broker unavailable'));

    await expect(publisher().publish([row()])).rejects.toThrow('broker unavailable');
  });

  it('opens one producer and reuses it', async () => {
    const p = publisher();
    await p.publish([row()]);
    await p.publish([row({ id: 'OBX_2' })]);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(sendBatch).toHaveBeenCalledTimes(2);
  });

  it('does not cache a producer that failed to connect', async () => {
    // A broker that was down at start-up must not leave the service unable to
    // publish once it comes back.
    connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const p = publisher();

    await expect(p.publish([row()])).rejects.toThrow('ECONNREFUSED');
    await expect(p.publish([row()])).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(2);
  });
});

describe('the health probe', () => {
  it('reports healthy when the broker answers, and closes what it opened', async () => {
    await expect(publisher().isHealthy()).resolves.toBe(true);
    expect(adminDisconnect).toHaveBeenCalledTimes(1);
  });

  it('reports unhealthy rather than raising, so readiness can answer', async () => {
    // A probe that throws produces a 500 instead of a "not ready", and an
    // orchestrator reads those differently.
    adminConnect.mockRejectedValueOnce(new Error('no brokers'));
    await expect(publisher().isHealthy()).resolves.toBe(false);
  });
});

describe('shutdown', () => {
  it('disconnects a producer that was opened', async () => {
    const p = publisher();
    await p.publish([row()]);
    await p.onModuleDestroy();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when nothing was ever published', async () => {
    await publisher().onModuleDestroy();
    expect(disconnect).not.toHaveBeenCalled();
  });
});

describe('the in-memory publisher', () => {
  it('records what it was asked to publish rather than pretending', async () => {
    // Used where no broker exists. It must be obviously a recorder, so a suite
    // asserting on `published` is asserting on something real.
    const p = new InMemoryEventPublisher();
    await p.publish([row({ id: 'A' }), row({ id: 'B' })]);

    expect(p.published.map((r) => r.id)).toEqual(['A', 'B']);
    await expect(p.isHealthy()).resolves.toBe(true);

    p.clear();
    expect(p.published).toEqual([]);
  });
});
