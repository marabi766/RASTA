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
 * The producer copies kafkajs 2.2.4 where a stop meets it (`producer/index.js`,
 * `producer/messageProducer.js`, `network/connection.js`), not what one would
 * wish it did (Codex r1 on #270):
 *   - `disconnect()` cancels nothing: it waits for the requests in flight
 *     (`waitForPendingRequests`), so a send that hangs keeps it waiting, and
 *     lands if the broker answers;
 *   - a `connect()` that completes after a `disconnect()` marks the producer
 *     connected again, and it accepts sends;
 *   - a send while disconnecting or disconnected is refused.
 * `connect` or `send` can be made to hang until `release()`, a slow broker
 * finally answering.
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
  /** Records the broker accepted. */
  readonly sent: { topic: string; messages?: { headers?: Record<string, unknown> }[] }[] = [];
  connects = 0;
  disconnects = 0;
  /** Sends begun on a connected producer, whether or not they ever landed. */
  sendsStarted = 0;
  status: 'disconnected' | 'connected' | 'disconnecting' = 'disconnected';
  private readonly pending = new Set<Promise<void>>();
  private answer!: () => void;
  private readonly answered = new Promise<void>((resolve) => (this.answer = resolve));

  constructor(private readonly hang: 'none' | 'connect' | 'send' = 'none') {}

  /** The slow broker answers: a hanging connect or send completes. */
  release(): void {
    this.answer();
  }

  async connect(): Promise<void> {
    this.connects += 1;
    if (this.hang === 'connect') await this.answered;
    this.status = 'connected';
  }

  async send(record: { topic: string }): Promise<void> {
    if (this.status === 'disconnecting') {
      throw new Error("The producer is disconnecting; therefore, it can't safely accept messages");
    }
    if (this.status === 'disconnected') throw new Error('The producer is disconnected');
    this.sendsStarted += 1;
    const request = (this.hang === 'send' ? this.answered : Promise.resolve()).then(() => {
      this.sent.push(record);
    });
    this.pending.add(request);
    try {
      await request;
    } finally {
      this.pending.delete(request);
    }
  }

  async disconnect(): Promise<void> {
    this.disconnects += 1;
    this.status = 'disconnecting';
    await Promise.all([...this.pending]);
    this.status = 'disconnected';
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
