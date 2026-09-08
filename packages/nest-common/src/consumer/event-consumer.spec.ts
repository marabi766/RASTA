import { EventConsumer } from './event-consumer';
import type {
  ConsumerLogger,
  EventConsumerOptions,
  EventDelivery,
  EventHandler,
} from './event-consumer';
import type { EventEnvelope } from '@rasta/contracts';

/**
 * The delivery-metadata contract added for ADR-053 AUD-001.
 *
 * audit-service must persist the topic a row actually arrived on, and the
 * envelope cannot supply it: `producer` names the emitting service, which is a
 * different fact — one service publishes to several topics, a retry arrives on
 * `<topic>.retry`, and a replay can be re-published anywhere. Only the broker
 * knows, so `EventConsumer` now passes it.
 *
 * These tests exist because the change touches the one class every consumer in
 * the platform is built on. Nothing here needs a broker: the constructor builds
 * a `Kafka` client lazily and `handleMessage` reaches the handler without ever
 * connecting.
 */
/** The one private member these tests reach, named rather than cast to `any`. */
interface PrivateHandle {
  handleMessage(
    topic: string,
    partition: number,
    value: Buffer | null,
    headers: undefined,
  ): Promise<void>;
}

describe('EventConsumer delivery metadata', () => {
  const silentLogger: ConsumerLogger = {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };

  const options: EventConsumerOptions = {
    brokers: ['localhost:9092'],
    clientId: 'nest-common-spec',
    groupId: 'nest-common-spec.group',
    topics: ['rasta.asset.v1'],
  };

  function envelopeBytes(overrides: Partial<EventEnvelope> = {}): Buffer {
    return Buffer.from(
      JSON.stringify({
        eventId: '01JCONSUMERSPEC0000000001',
        eventName: 'ASSET_DECOMMISSIONED',
        eventVersion: 1,
        occurredAt: '2026-09-08T10:00:00.000Z',
        producer: 'asset-service',
        producerVersion: '1.4.0',
        aggregateType: 'Asset',
        aggregateId: 'AST_SPEC_1',
        correlationId: 'corr-spec-1',
        payload: { reason: 'sold' },
        ...overrides,
      }),
      'utf8',
    );
  }

  /**
   * `handleMessage` is private because nothing outside the class should drive
   * it in production. A test that went through `run()` would need a live
   * broker to assert a pure argument-passing property, so it is reached
   * directly here rather than weakening the class's visibility.
   */
  function deliver(
    consumer: EventConsumer,
    topic: string,
    partition: number,
    value: Buffer | null,
  ): Promise<void> {
    // JUSTIFIED-ANY: reaching one private method to test it without a broker.
    return (consumer as unknown as PrivateHandle).handleMessage(topic, partition, value, undefined);
  }

  it('gives the handler the topic and partition the broker reported', async () => {
    const seen: EventDelivery[] = [];
    const consumer = new EventConsumer(
      options,
      async (_envelope, delivery) => {
        seen.push(delivery);
      },
      silentLogger,
    );

    await deliver(consumer, 'rasta.asset.v1', 2, envelopeBytes());

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ topic: 'rasta.asset.v1', partition: 2 });
  });

  it('reports the real topic even when the producer publishes elsewhere', async () => {
    // The reason this metadata exists at all. `producer` is `asset-service` on
    // both messages below; the topic is what tells a retry delivery apart from
    // a first delivery, and audit-service stores that distinction.
    const topics: string[] = [];
    const consumer = new EventConsumer(
      options,
      async (_envelope, delivery) => {
        topics.push(delivery.topic);
      },
      silentLogger,
    );

    await deliver(consumer, 'rasta.asset.v1', 0, envelopeBytes());
    await deliver(consumer, 'rasta.asset.v1.retry', 1, envelopeBytes());

    expect(topics).toEqual(['rasta.asset.v1', 'rasta.asset.v1.retry']);
  });

  it('hands over frozen metadata, so a handler cannot pass on a rewritten topic', async () => {
    let captured: EventDelivery | undefined;
    const consumer = new EventConsumer(
      options,
      async (_envelope, delivery) => {
        captured = delivery;
      },
      silentLogger,
    );

    await deliver(consumer, 'rasta.economic.v1', 5, envelopeBytes());

    expect(Object.isFrozen(captured)).toBe(true);
    // Mutation is silently ignored in sloppy mode and throws in strict mode;
    // either way the value must not change.
    try {
      (captured as unknown as { topic: string }).topic = 'rasta.audit.trail.v1';
    } catch {
      // strict-mode TypeError is an acceptable outcome
    }
    expect(captured?.topic).toBe('rasta.economic.v1');
  });

  it('still accepts a handler that declares only the envelope', async () => {
    // The backward-compatibility guarantee, asserted rather than assumed.
    // Every existing consumer in this repository is written this way, and
    // TypeScript assigns a shorter function to a longer signature — so this
    // must compile *and* run with the extra argument passed.
    const calls: string[] = [];
    const legacyHandler = async (envelope: EventEnvelope): Promise<void> => {
      calls.push(envelope.eventId);
    };

    const asHandler: EventHandler = legacyHandler;
    const consumer = new EventConsumer(options, asHandler, silentLogger);

    await deliver(consumer, 'rasta.asset.v1', 0, envelopeBytes());

    expect(calls).toEqual(['01JCONSUMERSPEC0000000001']);
  });

  it('does not reach the handler at all for an unparseable message', async () => {
    // Delivery metadata must not change the DLQ path: a malformed body is
    // still refused before any handler sees it.
    const calls: string[] = [];
    const consumer = new EventConsumer(
      options,
      async (envelope) => {
        calls.push(envelope.eventId);
      },
      silentLogger,
    );

    // `deadLetter` needs a producer this consumer never connected, so the
    // rejection surfaces as a throw rather than a publish. Either way the
    // handler must not have run.
    await deliver(consumer, 'rasta.asset.v1', 0, Buffer.from('{not json', 'utf8')).catch(
      () => undefined,
    );

    expect(calls).toEqual([]);
  });
});
