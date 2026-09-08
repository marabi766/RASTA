import { Kafka, type Consumer, type Producer, type IHeaders } from 'kafkajs';
import {
  DLQ_HEADERS,
  DLQ_REASONS,
  EVENT_HEADERS,
  eventEnvelopeSchema,
  type DlqReason,
  type EventEnvelope,
} from '@rasta/contracts';
import { createSystemContext, runWithContext } from '../context/request-context';

/**
 * The consuming half of the outbox pattern (ADR-021).
 *
 * `OutboxRelay` guarantees at-least-once delivery. That guarantee is only
 * useful if the other end can absorb a duplicate, so everything here is built
 * around one assumption: **the same message will arrive twice**. Handlers are
 * expected to be idempotent — in practice by recording `envelope.eventId` in
 * their own `processed_event` table, inside the same transaction as the effect,
 * so a duplicate is recognised and skipped.
 *
 * Failure handling distinguishes two cases, because they need opposite
 * responses:
 *
 *   - **A message this consumer can never process** — malformed JSON, an
 *     envelope that fails validation. Retrying is pointless; it goes straight
 *     to the dead-letter topic and the partition keeps moving.
 *   - **A handler that failed** — a database blip, a downstream timeout.
 *     Retried in-process with backoff, and dead-lettered only once the
 *     attempts are exhausted.
 *
 * What it deliberately does not do is commit an offset it could not account
 * for. If even the dead-letter write fails, the error propagates, kafkajs
 * retries, and the partition stalls. A stalled partition is visible in lag
 * metrics and recoverable; a silently skipped financial event is neither.
 */

export interface EventConsumerOptions {
  brokers: string[];
  clientId: string;
  /**
   * Kafka consumer group. One per (service, purpose) — never shared between
   * two services, or they would steal each other's partitions and each see
   * half the stream.
   */
  groupId: string;
  topics: string[];
  /**
   * Where messages go when they cannot be processed. Omit only for a consumer
   * whose failures are genuinely safe to drop; there are very few of those.
   */
  deadLetterTopic?: string;
  /** In-process attempts before dead-lettering. */
  maxRetries?: number;
  retryBackoffMs?: number;
  /** Start at the beginning of the topic when the group has no committed
   *  offset. True for projectors that need the full history. */
  fromBeginning?: boolean;
}

export interface ConsumerLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string, trace?: unknown): void;
}

/** Return value of a handler, so the consumer can report what it did. */
export type HandlerOutcome = void | 'SKIPPED';

/**
 * Where a message was actually delivered from.
 *
 * The envelope deliberately does not carry this. `producer` names the service
 * that emitted the event, which is not the same fact: one service publishes to
 * several topics, a retry arrives on `<topic>.retry`, and a replayed message
 * can be re-published anywhere. A consumer that needs to record *which topic a
 * row came from* — audit-service does, to tell its domain-projector rows apart
 * from its explicit-trail rows (ADR-053 § 1) — can only get that from the
 * broker.
 *
 * Passed as a second argument rather than merged into the envelope, and that
 * choice is the whole point: the envelope is a producer-signed contract shared
 * across nine services, and adding a consumer-side field to it would let a
 * producer set a topic it did not publish to. Delivery metadata is observed by
 * the consumer, never asserted by the sender.
 *
 * `readonly` throughout so a handler cannot hand a mutated copy to something
 * downstream and have it read as what the broker said.
 */
export interface EventDelivery {
  readonly topic: string;
  readonly partition: number;
}

/**
 * A handler may ignore the second argument entirely.
 *
 * TypeScript assigns a function of fewer parameters to a type of more, so every
 * existing `(envelope) => …` handler in the repository still satisfies this
 * unchanged, and passing an extra argument at runtime is inert for them. That
 * is what makes this additive rather than a breaking change.
 */
export type EventHandler = (
  envelope: EventEnvelope,
  delivery: EventDelivery,
) => Promise<HandlerOutcome>;

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 500;

export class EventConsumer {
  private readonly kafka: Kafka;
  private consumer?: Consumer;
  private dlqProducer?: Producer;
  private running = false;

  constructor(
    private readonly options: EventConsumerOptions,
    private readonly handler: EventHandler,
    private readonly logger: ConsumerLogger,
  ) {
    this.kafka = new Kafka({
      clientId: options.clientId,
      brokers: options.brokers,
      retry: { initialRetryTime: 300, retries: 8 },
      logLevel: 1, // ERROR — kafkajs is extremely chatty at INFO
    });
  }

  async start(): Promise<void> {
    if (this.running) return;

    const consumer = this.kafka.consumer({
      groupId: this.options.groupId,
      // A projector doing database writes per message can exceed the default
      // 30s heartbeat window on a cold cache; 60s avoids a rebalance storm
      // that would only make the backlog worse.
      sessionTimeout: 60_000,
      allowAutoTopicCreation: false,
    });

    await consumer.connect();

    // Everything past `connect()` runs against a consumer that already holds a
    // socket and a group membership, and `this.consumer` is assigned only once
    // startup has fully succeeded — so between here and there, `stop()` cannot
    // reach it. A subscription the broker refuses is not hypothetical: it is
    // the designed behaviour of `allowAutoTopicCreation: false`, which is how a
    // missing topic fails loudly instead of silently creating itself. Without
    // this guard that loud failure would also leak the connection, and a
    // supervisor retrying `start()` would leak another one per attempt until
    // the broker's connection limit, not the missing topic, became the visible
    // problem.
    try {
      for (const topic of this.options.topics) {
        await consumer.subscribe({ topic, fromBeginning: this.options.fromBeginning ?? false });
      }

      await consumer.run({
        // Sequential per partition. Ordering within an aggregate is the whole
        // reason the producer sets a partition key; processing concurrently
        // inside a partition would throw it away.
        eachMessage: async ({ topic, partition, message }) => {
          await this.handleMessage(topic, partition, message.value, message.headers);
        },
      });
    } catch (error) {
      await this.discardAfterFailedStart(consumer, error);
      throw error;
    }

    this.consumer = consumer;
    this.running = true;
    this.logger.log(`Consuming ${this.options.topics.join(', ')} as group ${this.options.groupId}`);
  }

  /**
   * Hands back the connection a failed `start()` opened.
   *
   * The disconnect failure is logged and swallowed on purpose. The caller is
   * about to receive the error that actually broke startup, and that is the one
   * an operator needs: replacing it with "disconnect failed" would hide the
   * missing topic behind its own cleanup. Only the key facts of the original
   * error are logged alongside — never a payload, because nothing was consumed
   * yet and nothing here has any.
   */
  private async discardAfterFailedStart(consumer: Consumer, cause: unknown): Promise<void> {
    try {
      await consumer.disconnect();
    } catch (cleanupError) {
      this.logger.error(
        `Could not disconnect ${this.options.groupId} after a failed start ` +
          `(${describe(cause)}): ${describe(cleanupError)}`,
      );
    }
  }

  private async handleMessage(
    topic: string,
    partition: number,
    value: Buffer | null,
    headers: IHeaders | undefined,
  ): Promise<void> {
    let envelope: EventEnvelope;

    try {
      if (!value) throw new Error('Message has no body');
      const parsed = eventEnvelopeSchema.parse(JSON.parse(value.toString('utf8')));
      // `payload` is `unknown` in the schema, which zod infers as optional.
      // Restating it makes it a present key again — the handler is entitled to
      // find the property there even when its value is undefined.
      envelope = { ...parsed, payload: parsed.payload };
    } catch (error) {
      // Unprocessable by construction — no number of retries changes the bytes.
      this.logger.error(`Unparseable message on ${topic}[${partition}]: ${describe(error)}`);
      await this.deadLetter(topic, value, headers, DLQ_REASONS.VALIDATION_FAILED, error, 0);
      return;
    }

    const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const backoff = this.options.retryBackoffMs ?? DEFAULT_BACKOFF_MS;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        // The handler runs inside a context carrying the event's own
        // correlationId and tenant, so its log lines join up with the request
        // that originally caused the event, and tenant-scoped queries resolve
        // to the right organization.
        await runWithContext(
          createSystemContext({
            correlationId: envelope.correlationId,
            ...(envelope.tenantId ? { organizationId: envelope.tenantId } : {}),
            callerService: envelope.producer,
          }),
          // Frozen so a handler cannot mutate what the broker reported and pass
          // it on as fact.
          () => this.handler(envelope, Object.freeze({ topic, partition })),
        );
        return;
      } catch (error) {
        if (attempt === maxRetries) {
          this.logger.error(
            `Handler failed ${maxRetries}x for ${envelope.eventName} ${envelope.eventId}: ${describe(error)}`,
          );
          await this.deadLetter(
            topic,
            value,
            headers,
            DLQ_REASONS.MAX_RETRIES_EXCEEDED,
            error,
            attempt,
          );
          return;
        }

        this.logger.warn(
          `Attempt ${attempt}/${maxRetries} failed for ${envelope.eventName} ${envelope.eventId}: ${describe(error)}`,
        );
        await sleep(backoff * attempt);
      }
    }
  }

  /**
   * Publishes the original bytes, unaltered, to the dead-letter topic.
   *
   * Unaltered matters: whoever replays it needs the message the producer
   * actually sent, not this consumer's re-serialization of it. The reason,
   * the error and the original topic ride along as headers so the runbook
   * (docs/runbooks/replay-dlq.md) can triage without opening the body.
   */
  private async deadLetter(
    originalTopic: string,
    value: Buffer | null,
    headers: IHeaders | undefined,
    reason: DlqReason,
    error: unknown,
    attempts: number,
  ): Promise<void> {
    const target = this.options.deadLetterTopic;
    if (!target) {
      this.logger.error(
        `No dead-letter topic configured for ${this.options.groupId}; message from ${originalTopic} dropped`,
      );
      return;
    }

    const producer = await this.getDlqProducer();

    await producer.send({
      topic: target,
      acks: -1,
      messages: [
        {
          value,
          headers: {
            ...(headers ?? {}),
            [DLQ_HEADERS.reason]: reason,
            [DLQ_HEADERS.originalTopic]: originalTopic,
            [DLQ_HEADERS.attempts]: String(attempts),
            [DLQ_HEADERS.error]: describe(error).slice(0, 1000),
            [DLQ_HEADERS.firstFailedAt]: new Date().toISOString(),
            [EVENT_HEADERS.producer]: this.options.clientId,
          },
        },
      ],
    });
  }

  private async getDlqProducer(): Promise<Producer> {
    if (!this.dlqProducer) {
      const producer = this.kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
      await producer.connect();
      this.dlqProducer = producer;
    }
    return this.dlqProducer;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.consumer) {
      await this.consumer.disconnect();
      this.consumer = undefined;
    }
    if (this.dlqProducer) {
      await this.dlqProducer.disconnect();
      this.dlqProducer = undefined;
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
