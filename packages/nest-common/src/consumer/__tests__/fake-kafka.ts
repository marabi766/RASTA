import type { EventConsumer } from '../event-consumer';

/**
 * A kafkajs consumer and dead-letter producer, reduced to what decides a
 * stopping consumer's outcome — so the tests can assert it without a broker.
 *
 * The consumer copies kafkajs 2.2.4's runner where it matters
 * (`consumer/runner.js`, `processEachMessage` and `stop`):
 *   - a message whose `eachMessage` **returned** is committed; one whose
 *     `eachMessage` threw is not, and the group delivers it again;
 *   - `disconnect()` stops the runner at once, then waits for the message in
 *     flight before it resolves (`waitForConsumer`).
 *
 * The producer's `connect` and `send` can be made to hang; a hanging one fails
 * once the producer is disconnected, as a request on a closed connection does.
 */
export interface FakeMessage {
  topic: string;
  partition: number;
  offset: string;
  value: Buffer;
}

type EachMessage = (payload: {
  topic: string;
  partition: number;
  message: { value: Buffer; headers: Record<string, never>; offset: string; key: null };
  heartbeat: () => Promise<void>;
  pause: () => () => void;
}) => Promise<void>;

export class FakeKafkaConsumer {
  /** Offsets whose `eachMessage` returned: kafkajs resolves and commits these. */
  readonly committed: string[] = [];
  /** Offsets whose `eachMessage` threw: uncommitted, so delivered again. */
  readonly uncommitted: { offset: string; error: unknown }[] = [];
  disconnects = 0;
  disconnected = false;
  private running = false;
  private eachMessage?: EachMessage;
  private inFlight: Promise<void> = Promise.resolve();

  async connect(): Promise<void> {}
  async subscribe(): Promise<void> {}

  async run(config: { eachMessage: EachMessage }): Promise<void> {
    this.eachMessage = config.eachMessage;
    this.running = true;
  }

  /** What the runner does for one fetched message. Never rejects. */
  deliver(message: FakeMessage): Promise<void> {
    if (!this.running || !this.eachMessage) throw new Error('the runner is not running');
    const run = this.eachMessage({
      topic: message.topic,
      partition: message.partition,
      message: { value: message.value, headers: {}, offset: message.offset, key: null },
      heartbeat: async () => undefined,
      pause: () => () => undefined,
    }).then(
      () => {
        this.committed.push(message.offset);
      },
      (error: unknown) => {
        this.uncommitted.push({ offset: message.offset, error });
      },
    );
    this.inFlight = run;
    return run;
  }

  async disconnect(): Promise<void> {
    this.disconnects += 1;
    this.running = false;
    await this.inFlight;
    this.disconnected = true;
  }
}

export class FakeDlqProducer {
  readonly sent: { topic: string }[] = [];
  connects = 0;
  disconnects = 0;
  private closed?: () => void;
  private readonly closedSignal = new Promise<void>((resolve) => (this.closed = resolve));

  constructor(private readonly hang: 'none' | 'connect' | 'send' = 'none') {}

  async connect(): Promise<void> {
    this.connects += 1;
    if (this.hang === 'connect') await this.untilClosed('connect');
  }

  async send(record: { topic: string }): Promise<void> {
    if (this.hang === 'send') await this.untilClosed('send');
    this.sent.push(record);
  }

  async disconnect(): Promise<void> {
    this.disconnects += 1;
    this.closed?.();
  }

  private async untilClosed(what: string): Promise<never> {
    await this.closedSignal;
    throw new Error(`Closed connection: the ${what} did not complete`);
  }
}

/** The private member the fakes replace, named rather than cast to `any`. */
interface PrivateKafka {
  kafka: { consumer(config: unknown): unknown; producer(config: unknown): unknown };
}

/** Swaps the consumer's Kafka client for the fakes; the client is built in the constructor. */
export function withFakeKafka(
  consumer: EventConsumer,
  fake: FakeKafkaConsumer,
  producer: FakeDlqProducer = new FakeDlqProducer(),
): EventConsumer {
  (consumer as unknown as PrivateKafka).kafka = {
    consumer: () => fake,
    producer: () => producer,
  };
  return consumer;
}

/** A valid envelope on `rasta.asset.v1`, from its declared producer. */
export function envelopeOnAssetTopic(eventId: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      eventId,
      eventName: 'ASSET_DECOMMISSIONED',
      eventVersion: 1,
      occurredAt: '2026-10-14T10:00:00.000Z',
      producer: 'asset-service',
      producerVersion: '1.4.0',
      aggregateType: 'Asset',
      aggregateId: 'AST_STOP_SPEC_1',
      correlationId: 'corr-stop-spec',
      payload: { reason: 'sold' },
    }),
    'utf8',
  );
}

/** Settles once `condition` holds, polling every 5 ms; fails after `withinMs`. */
export async function until(condition: () => boolean, withinMs = 2000): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
