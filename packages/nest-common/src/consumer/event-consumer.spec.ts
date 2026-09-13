import { EventConsumer } from './event-consumer';
import type {
  ConsumerLogger,
  EventConsumerOptions,
  EventDelivery,
  EventHandler,
} from './event-consumer';
import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import { dlqMessagesTotal, registry } from '@rasta/observability';

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

/**
 * Startup has to give back everything a successful `connect()` took.
 *
 * `start()` connects first and only then subscribes and runs, so the window
 * between them owns a real socket and a real group membership that nothing else
 * holds a reference to. Failing in that window is the *designed* behaviour of
 * `allowAutoTopicCreation: false` — a missing topic is meant to fail loudly
 * rather than create itself — which makes it the likeliest failure this class
 * has, not an exotic one. A leak there is invisible in the way that costs most:
 * the service still reports the missing topic, so the visible error is right,
 * while every supervisor retry adds another connected member to the group until
 * the broker's limit becomes the symptom and the real cause is far behind.
 *
 * Everything below drives the real `EventConsumer` against a fake kafkajs
 * consumer, so the assertions are about this class's own bookkeeping — how many
 * times it disconnects, and what it reports — rather than about a broker.
 */
describe('EventConsumer startup failure', () => {
  const SUBSCRIBE_FAILURE = 'This server does not host this topic-partition';
  const RUN_FAILURE = 'The group is rebalancing';
  const DISCONNECT_FAILURE = 'Connection already closed';

  const TOPICS = ['rasta.identity.v1', 'rasta.asset.v1'];

  const startupOptions: EventConsumerOptions = {
    brokers: ['localhost:9092'],
    clientId: 'nest-common-startup-spec',
    groupId: 'nest-common-startup-spec.group',
    topics: TOPICS,
  };

  /** Where in the startup sequence the broker refuses. */
  type FailurePoint = 'none' | 'subscribe' | 'run';

  class FakeKafkaConsumer {
    connects = 0;
    disconnects = 0;
    runs = 0;
    readonly subscribed: string[] = [];

    constructor(
      private readonly failAt: FailurePoint = 'none',
      private readonly failDisconnect = false,
    ) {}

    async connect(): Promise<void> {
      this.connects += 1;
    }

    async subscribe(config: { topic: string }): Promise<void> {
      if (this.failAt === 'subscribe') throw new Error(SUBSCRIBE_FAILURE);
      this.subscribed.push(config.topic);
    }

    async run(): Promise<void> {
      if (this.failAt === 'run') throw new Error(RUN_FAILURE);
      this.runs += 1;
    }

    async disconnect(): Promise<void> {
      this.disconnects += 1;
      if (this.failDisconnect) throw new Error(DISCONNECT_FAILURE);
    }
  }

  /** The one private member these tests replace, named rather than cast to `any`. */
  interface PrivateKafka {
    kafka: { consumer(config: unknown): unknown };
  }

  function capturingLogger(lines: string[]): ConsumerLogger {
    return {
      log: (message) => lines.push(message),
      warn: (message) => lines.push(message),
      error: (message, trace) => lines.push(trace ? `${message} ${String(trace)}` : message),
    };
  }

  /**
   * Builds the real consumer with its Kafka client swapped for the fake.
   *
   * The client is created in the constructor, so it is replaced on the instance
   * rather than through a module mock — the delivery-metadata suite above shares
   * this file and must keep exercising the untouched class.
   */
  function build(fake: FakeKafkaConsumer, logger: ConsumerLogger): EventConsumer {
    const consumer = new EventConsumer(startupOptions, async () => undefined, logger);
    (consumer as unknown as PrivateKafka).kafka = { consumer: () => fake };
    return consumer;
  }

  it('disconnects the consumer that a refused subscription left connected', async () => {
    const lines: string[] = [];
    const fake = new FakeKafkaConsumer('subscribe');
    const consumer = build(fake, capturingLogger(lines));

    await expect(consumer.start()).rejects.toThrow(SUBSCRIBE_FAILURE);

    expect(fake.connects).toBe(1);
    expect(fake.disconnects).toBe(1);
    expect(consumer.isRunning()).toBe(false);

    // And nothing stale is left behind for `stop()` to disconnect a second
    // time — a double disconnect on a member the broker has already dropped is
    // how orderly shutdown turns into a crash on the way out.
    await consumer.stop();
    expect(fake.disconnects).toBe(1);
  });

  it('disconnects the consumer when run() fails after the subscriptions succeeded', async () => {
    const lines: string[] = [];
    const fake = new FakeKafkaConsumer('run');
    const consumer = build(fake, capturingLogger(lines));

    await expect(consumer.start()).rejects.toThrow(RUN_FAILURE);

    // The later failure point: every subscription was accepted, so the group
    // membership is fully established by the time this fails.
    expect(fake.subscribed).toEqual(TOPICS);
    expect(fake.disconnects).toBe(1);
    expect(consumer.isRunning()).toBe(false);

    await consumer.stop();
    expect(fake.disconnects).toBe(1);
  });

  it('rethrows the startup error, not the cleanup error, when the disconnect also fails', async () => {
    // The error that reaches the caller must stay the one that explains why the
    // service will not come up. A cleanup failure replacing it would hide a
    // missing topic behind its own tidying, so it is logged instead — with the
    // original named alongside it, so neither is lost.
    const lines: string[] = [];
    const fake = new FakeKafkaConsumer('subscribe', true);
    const consumer = build(fake, capturingLogger(lines));

    await expect(consumer.start()).rejects.toThrow(SUBSCRIBE_FAILURE);

    expect(fake.disconnects).toBe(1);
    expect(consumer.isRunning()).toBe(false);
    expect(
      lines.some((line) => line.includes(DISCONNECT_FAILURE) && line.includes(SUBSCRIBE_FAILURE)),
    ).toBe(true);
  });

  it('disconnects exactly once however often stop is called after a successful start', async () => {
    const lines: string[] = [];
    const fake = new FakeKafkaConsumer();
    const consumer = build(fake, capturingLogger(lines));

    await consumer.start();

    expect(fake.subscribed).toEqual(TOPICS);
    expect(fake.runs).toBe(1);
    expect(consumer.isRunning()).toBe(true);

    await consumer.stop();
    await consumer.stop();

    expect(fake.disconnects).toBe(1);
    expect(consumer.isRunning()).toBe(false);
  });
});

/**
 * `rasta_dlq_messages_total`, counted where a dead letter is actually written.
 *
 * The counter is the platform's one signal that a message left the stream, so
 * it has to agree with the dead-letter topic in both directions: every completed
 * publish counts once, and nothing else counts — not a retry, not a send the
 * broker refused (that message is still on its partition), and not a drop by a
 * consumer that has no dead-letter topic. These drive the real `handleMessage`
 * and `deadLetter` against a fake producer placed where the lazily connected one
 * would be, so no broker is needed and the private members stay private.
 */
describe('EventConsumer dead-letter metric', () => {
  const SOURCE_TOPIC = 'rasta.asset.v1';
  const DLQ_TOPIC = 'rasta.asset.v1.dlq';
  const CLIENT_ID = 'nest-common-dlq-spec';

  /** Values that must never become a label: identifiers and error text. */
  const EVENT_ID = '01JDLQMETRICSPEC000000001';
  const CORRELATION_ID = 'corr-dlq-metric-spec';
  const TENANT_ID = 'ORG_DLQ_METRIC_TENANT';
  const HANDLER_FAILURE = 'database unavailable for ORG_DLQ_METRIC_TENANT';

  interface SentRecord {
    topic: string;
    messages: { value: Buffer | null; headers: Record<string, unknown> }[];
  }

  class FakeDlqProducer {
    readonly sent: SentRecord[] = [];

    constructor(private readonly failure?: Error) {}

    async send(record: SentRecord): Promise<void> {
      if (this.failure) throw this.failure;
      this.sent.push(record);
    }
  }

  /** The private members these tests reach, named rather than cast to `any`. */
  interface PrivateDeadLetter {
    dlqProducer?: FakeDlqProducer;
    handleMessage(
      topic: string,
      partition: number,
      value: Buffer | null,
      headers: undefined,
    ): Promise<void>;
  }

  const silent: ConsumerLogger = {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  const baseOptions: EventConsumerOptions = {
    brokers: ['localhost:9092'],
    clientId: CLIENT_ID,
    groupId: 'nest-common-dlq-spec.group',
    topics: [SOURCE_TOPIC],
    deadLetterTopic: DLQ_TOPIC,
    maxRetries: 1,
    retryBackoffMs: 0,
  };

  const validBytes = (): Buffer =>
    Buffer.from(
      JSON.stringify({
        eventId: EVENT_ID,
        eventName: 'ASSET_DECOMMISSIONED',
        eventVersion: 1,
        occurredAt: '2026-09-08T10:00:00.000Z',
        producer: 'asset-service',
        producerVersion: '1.4.0',
        aggregateType: 'Asset',
        aggregateId: 'AST_DLQ_METRIC_1',
        correlationId: CORRELATION_ID,
        tenantId: TENANT_ID,
        payload: { reason: 'sold' },
      }),
      'utf8',
    );

  const malformedBytes = (): Buffer =>
    Buffer.from(`{"eventId":"${EVENT_ID}","tenantId":"${TENANT_ID}", not json`, 'utf8');

  /** The real consumer, with a fake producer where the connected one would be. */
  function build(
    producer: FakeDlqProducer | undefined,
    handler: EventHandler,
    overrides: Partial<EventConsumerOptions> = {},
    logger: ConsumerLogger = silent,
  ): PrivateDeadLetter {
    const consumer = new EventConsumer({ ...baseOptions, ...overrides }, handler, logger);
    const handle = consumer as unknown as PrivateDeadLetter;
    handle.dlqProducer = producer;
    return handle;
  }

  interface Sample {
    labels: Record<string, string | number | undefined>;
    value: number;
  }

  async function counted(): Promise<Sample[]> {
    return (await dlqMessagesTotal.get()).values
      .filter((sample) => sample.value > 0)
      .map((sample) => ({ labels: { ...sample.labels }, value: sample.value }));
  }

  const failingHandler: EventHandler = async () => {
    throw new Error(HANDLER_FAILURE);
  };

  beforeEach(() => {
    dlqMessagesTotal.reset();
  });

  afterAll(() => {
    dlqMessagesTotal.reset();
  });

  it('counts a malformed message once its dead letter is published', async () => {
    const producer = new FakeDlqProducer();
    const consumer = build(producer, async () => undefined);

    await consumer.handleMessage(SOURCE_TOPIC, 3, malformedBytes(), undefined);

    expect(producer.sent).toHaveLength(1);
    expect(producer.sent[0]?.topic).toBe(DLQ_TOPIC);
    expect(await counted()).toEqual([
      {
        labels: { service: CLIENT_ID, topic: SOURCE_TOPIC, reason: DLQ_REASONS.VALIDATION_FAILED },
        value: 1,
      },
    ]);
  });

  it('counts a handler that exhausted its retries once, as MAX_RETRIES_EXCEEDED', async () => {
    let attempts = 0;
    const producer = new FakeDlqProducer();
    const consumer = build(producer, async () => {
      attempts += 1;
      throw new Error(HANDLER_FAILURE);
    });

    await consumer.handleMessage(SOURCE_TOPIC, 0, validBytes(), undefined);

    expect(attempts).toBe(1);
    expect(producer.sent).toHaveLength(1);
    expect(await counted()).toEqual([
      {
        labels: {
          service: CLIENT_ID,
          topic: SOURCE_TOPIC,
          reason: DLQ_REASONS.MAX_RETRIES_EXCEEDED,
        },
        value: 1,
      },
    ]);
  });

  it('does not count a dead letter the broker refused, and still rejects with that failure', async () => {
    // The message was written nowhere and is still on its partition, so
    // counting it would report a DLQ entry that does not exist.
    const refusal = new Error('DLQ unreachable');
    const consumer = build(new FakeDlqProducer(refusal), failingHandler);

    await expect(consumer.handleMessage(SOURCE_TOPIC, 0, validBytes(), undefined)).rejects.toBe(
      refusal,
    );
    await expect(consumer.handleMessage(SOURCE_TOPIC, 0, malformedBytes(), undefined)).rejects.toBe(
      refusal,
    );

    expect(await counted()).toEqual([]);
  });

  it('does not count a message dropped by a consumer with no dead-letter topic', async () => {
    const lines: string[] = [];
    const logger: ConsumerLogger = {
      log: (message) => lines.push(message),
      warn: (message) => lines.push(message),
      error: (message) => lines.push(message),
    };
    const consumer = build(
      undefined,
      async () => undefined,
      { deadLetterTopic: undefined },
      logger,
    );

    await expect(
      consumer.handleMessage(SOURCE_TOPIC, 0, malformedBytes(), undefined),
    ).resolves.toBeUndefined();

    expect(lines.some((line) => line.includes('dropped'))).toBe(true);
    expect(await counted()).toEqual([]);
  });

  it('counts one per completed publish, not one per retry', async () => {
    let attempts = 0;
    const producer = new FakeDlqProducer();
    const consumer = build(
      producer,
      async () => {
        attempts += 1;
        throw new Error(HANDLER_FAILURE);
      },
      { maxRetries: 3 },
    );

    await consumer.handleMessage(SOURCE_TOPIC, 0, validBytes(), undefined);
    await consumer.handleMessage(SOURCE_TOPIC, 1, validBytes(), undefined);

    // Six handler attempts, two publishes, two counts.
    expect(attempts).toBe(6);
    expect(producer.sent).toHaveLength(2);
    const samples = await counted();
    expect(samples).toEqual([
      {
        labels: {
          service: CLIENT_ID,
          topic: SOURCE_TOPIC,
          reason: DLQ_REASONS.MAX_RETRIES_EXCEEDED,
        },
        value: 2,
      },
    ]);
    expect(samples.reduce((total, sample) => total + sample.value, 0)).toBe(2);
  });

  it('labels with the closed set only, never an identifier, error text or position', async () => {
    const producer = new FakeDlqProducer();
    const consumer = build(producer, failingHandler);

    await consumer.handleMessage(SOURCE_TOPIC, 7, validBytes(), undefined);
    await consumer.handleMessage(SOURCE_TOPIC, 7, malformedBytes(), undefined);

    // One sample per code path, two publishes in total.
    const samples = await counted();
    expect(samples).toHaveLength(2);
    expect(samples.reduce((total, sample) => total + sample.value, 0)).toBe(2);
    for (const { labels } of samples) {
      expect(Object.keys(labels).sort()).toEqual(['reason', 'service', 'topic']);
    }

    const exposition = await registry.getSingleMetricAsString('rasta_dlq_messages_total');
    for (const forbidden of [EVENT_ID, CORRELATION_ID, TENANT_ID, HANDLER_FAILURE, DLQ_TOPIC]) {
      expect(exposition).not.toContain(forbidden);
    }
    expect(exposition).not.toMatch(/partition|offset|event_id|tenant|correlation|error/i);
  });
});
