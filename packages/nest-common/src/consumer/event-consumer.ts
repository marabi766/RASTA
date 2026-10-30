import {
  CompressionTypes,
  Kafka,
  KafkaJSError,
  type Consumer,
  type Producer,
  type IHeaders,
} from 'kafkajs';
import {
  DLQ_ADDED_HEADERS_MAX_BYTES,
  DLQ_HEADER_VALUE_MAX_BYTES,
  DLQ_HEADERS,
  DLQ_REASONS,
  EVENT_HEADERS,
  consumerDeclarationProblem,
  consumerGroupService,
  eventEnvelopeSchema,
  isAllowedProducer,
  isDeclaredConsumer,
  isDeclaredTopic,
  isLegacyRefusal,
  legacyParse,
  RETRY_TOPIC_SUFFIX,
  type DlqReason,
  type EventEnvelope,
} from '@rasta/contracts';
import { dlqMessagesTotal } from '@rasta/observability';
import { createSystemContext, runWithContext } from '../context/request-context';
import { RastaError } from '../errors/rasta-error';
import { LOG_TEXT_MAX, safeLogText } from '../errors/safe-log-text';
import { kafkaClientConfig, type KafkaConnectionOptions } from '../kafka/connection';
import { kafkaShutdownDeadline } from '../kafka/bounded-disconnect';
import { withinDeadline, type OutboxStopOptions } from '../outbox/outbox';

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
 * A handler can also reach the first verdict itself, after the envelope has
 * parsed: it throws {@link UnprocessableEventError} and the message goes
 * straight to the dead-letter topic under the reason it names.
 *
 * What it deliberately does not do is commit an offset it could not account
 * for. If even the dead-letter write fails, the error propagates and nothing
 * is committed past the message. A retriable failure (a broker away) is
 * retried by kafkajs and the partition stalls meanwhile. A non-retriable one —
 * MESSAGE_TOO_LARGE, a dead letter its topic refuses — crashes the kafkajs
 * consumer, which kafkajs does not restart: every partition this consumer
 * reads stops until the service restarts and meets the message again, and
 * {@link EventConsumer.isRunning} does not notice. Either is visible in lag
 * (where lag is alerted on) and recoverable while the source topic retains
 * the message; a silently skipped financial event is neither. Which dead
 * letters can still be refused is stated in `@rasta/contracts`
 * dead-letter-size.ts (known escapes; PR #378 r4).
 *
 * **What its log lines and dead-letter headers may carry (S-09).** Never the
 * message body: an unparseable one is described by fixed text and its size,
 * never by the parser's words. Of the original Kafka headers, only the
 * platform's own (`EVENT_HEADERS`) ride along to the dead-letter topic — an
 * `authorization` or any other header a client library added does not. A
 * handler's error message is service-authored and operators need it, but it
 * is not trusted blindly: every line and `x-dlq-error` is a fixed
 * classification, the `DlqReason`, and the message with control characters
 * stripped and cut to {@link HANDLER_MESSAGE_MAX} characters. The rule for
 * whoever writes those messages is on {@link UnprocessableEventError}.
 */

/** Every platform service's name ends so (`fleet-service`, `audit-service`). */
const SERVICE_NAME_SUFFIX = '-service';

export interface EventConsumerOptions extends KafkaConnectionOptions {
  /**
   * Kafka consumer group. One per (service, purpose) — never shared between
   * two services, or they would steal each other's partitions and each see
   * half the stream.
   */
  groupId: string;
  /**
   * The declared topics to consume. Each is subscribed together with its
   * `.retry` twin ({@link subscribedTopics}), so a replay lands somewhere.
   */
  topics: string[];
  /**
   * Where messages go when they cannot be processed. **Required** for every
   * service's consumer: it must be the service's own dead-letter topic as
   * `TOPIC_CONSUMERS` declares it, or the consumer refuses to start — without
   * one an unprocessable event is logged and committed past, i.e. lost
   * (RUN-006, Codex review of #128). Only a non-service observer (a test's
   * `itest-observer`) may omit it.
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
  /**
   * The record's key and offset, when the broker reported them. A handler that
   * holds an event back to dead-letter it later (fleet's parked insurance
   * events, #240 r8) needs both to write a dead letter the replay tool accepts:
   * the replay goes out under the kept key, and the offset finds the original.
   */
  readonly key?: string | null;
  readonly offset?: string;
  /**
   * Keeps this member in its group while a long handler runs (fleet's
   * asset-sync, #240 r12): kafkajs heartbeats between messages, not during one,
   * so a handler that waits on other services calls this before and after each
   * question. It starts kafkajs's heartbeat — sent only once its interval has
   * passed, and shared with any already in flight — and returns at once; it
   * never throws (a failure is logged). The consumer also calls it between a
   * message's attempts. Absent when no broker delivered the message (a test).
   */
  readonly heartbeat?: () => void;
}

/**
 * Why and from where a message is dead-lettered: what {@link deadLetterHeaders}
 * writes beside the original's platform headers.
 */
export interface DeadLetterDescription {
  readonly reason: DlqReason;
  readonly originalTopic: string;
  /** Omitted when unknown (a dead letter written later, from what was kept). */
  readonly originalPartition?: number;
  readonly originalOffset?: string;
  readonly attempts: number;
  /**
   * Fixed text and identifiers only (S-09), like an {@link UnprocessableEventError}'s
   * message; cut to 1,000 UTF-8 bytes on a character boundary, never otherwise rewritten.
   */
  readonly detail: string;
  /**
   * Who writes the dead letter: the consumer's client id, never the original
   * producer. Cut to 128 UTF-8 bytes.
   */
  readonly producer: string;
  readonly failedAt: Date;
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

/**
 * Thrown by a handler for a message it has decided it can never process.
 *
 * The consumer dead-letters it **at once**, with this reason, and does not
 * retry: the handler has already established that the answer will not change.
 * ADR-061 § 4 is the case it exists for. The owning service said the fact the
 * event claims is not so, and asking three more times would only delay the
 * DLQ and hold the partition.
 *
 * Only for a verdict. A handler that merely *failed* (a timeout, a database
 * blip) throws anything else and is retried as before.
 *
 * The message goes into `x-dlq-error` and the log, so it must name what
 * disagreed and never carry a secret, a token or a value that is not the
 * platform's to copy. **Identifiers yes, payload values no** (S-09): an event
 * id, an aggregate id, a field name or a closed code such as
 * `amount_mismatch` — never an amount, a name, an address or free text from
 * the payload. The same holds for any error a handler lets escape, since its
 * message reaches the same places. The consumer strips control characters and
 * bounds the length ({@link handlerMessage}); it cannot tell a value from an
 * identifier, so that part is the handler's.
 */
export class UnprocessableEventError extends Error {
  constructor(
    readonly reason: DlqReason,
    message: string,
  ) {
    super(message);
    this.name = 'UnprocessableEventError';
  }
}

/**
 * Thrown out of kafkajs's `eachMessage` for a message a stopping consumer gives
 * up on: before its handler runs, instead of a further attempt or the pause
 * before one, instead of its dead letter or its send, or once it has ended
 * after the stop's deadline, however it ended.
 *
 * Throwing is what keeps the message: kafkajs commits only the offsets of
 * messages whose `eachMessage` returned, so this one stays uncommitted and the
 * group delivers it again — to another member, or to this service when it
 * starts. Returning instead would commit past a message nothing handled.
 * Nothing is applied twice beyond what A-09 already absorbs: an attempt that
 * failed rolled back, and one that is redelivered meets the handler's
 * `processed_event` check.
 *
 * A `KafkaJSError`, and retriable, only so kafkajs treats it as its own: it
 * does not log it as a handler failure (the consumer's own warning says what
 * happened), and a retriable error never crashes the runner — which, stopping,
 * ends its loop instead of retrying.
 */
export class ConsumerStoppingError extends KafkaJSError {
  override readonly name = 'ConsumerStoppingError';

  constructor(message: string) {
    super(message, { retriable: true });
  }
}

/**
 * The DLQ reason for a handler whose retries ran out.
 *
 * An owning service that was down the whole time is `UPSTREAM_UNAVAILABLE`,
 * not a generic exhaustion. The event may be perfectly good, and whoever
 * triages the DLQ should know to replay it once the upstream is back rather
 * than look for a defect in it.
 */
function exhaustedReason(error: unknown): DlqReason {
  if (
    error instanceof RastaError &&
    (error.code === 'UPSTREAM_UNAVAILABLE' || error.code === 'UPSTREAM_TIMEOUT')
  ) {
    return DLQ_REASONS.UPSTREAM_UNAVAILABLE;
  }
  return DLQ_REASONS.MAX_RETRIES_EXCEEDED;
}

/**
 * What the consumer subscribes to: each declared topic and its `.retry` twin
 * (D-039), in that order, without repeats. The twin is where `ops-replay`
 * republishes a dead letter; it goes through the same checks as the original
 * topic — `isAllowedProducer` reads the owner topic from the delivery topic.
 */
export function subscribedTopics(topics: readonly string[]): string[] {
  const all = topics.flatMap((topic) =>
    topic.endsWith(RETRY_TOPIC_SUFFIX) ? [topic] : [topic, `${topic}${RETRY_TOPIC_SUFFIX}`],
  );
  return [...new Set(all)];
}

/** In-process attempts before dead-lettering, unless the consumer's options say otherwise. */
export const DEFAULT_MAX_RETRIES = 3;
/** The pause after failed attempt `n` is `n ×` this, unless the options say otherwise. */
export const DEFAULT_BACKOFF_MS = 500;
/**
 * The group session timeout. kafkajs heartbeats between messages, not while a
 * handler runs, so one message's attempts, their pauses and its dead letter
 * must finish within it or the broker evicts the member and rebalances — unless
 * the handler heartbeats itself ({@link EventDelivery.heartbeat}); the consumer
 * does between attempts.
 */
export const CONSUMER_SESSION_TIMEOUT_MS = 60_000;

/**
 * One run of the consumer, from a `start()` to its stop. A message keeps the
 * run it was delivered in, so a stop's verdict on it outlives a later `start()`
 * — a handler abandoned at the deadline may still be running then.
 */
interface ConsumerRun {
  /** Set when a stop begins: from then on nothing new starts for a message. */
  stopRequested: boolean;
  /** The stop's deadline (epoch ms): once past, no message of this run returns (#270 r1). */
  deadlineAt?: number;
  /** Set when the stop gave up waiting at its deadline. */
  abandoned: boolean;
  /**
   * Present while a stop is waiting for the disconnect: re-reads `deadlineAt`, so a later,
   * earlier deadline ends the wait at that one (PR #493 r1, F1).
   */
  rearm?: () => void;
}

export class EventConsumer {
  private readonly kafka: Kafka;
  private consumer?: Consumer;
  /** Assigned before it has connected, so a stop reaches a connection still being made. */
  private dlqProducer?: Producer;
  private dlqConnecting?: Promise<void>;
  private running = false;
  /** The current run; replaced by each `start()`. */
  private run: ConsumerRun = { stopRequested: false, abandoned: false };
  /** The one stop in progress or done since the last `start()`; later calls join it. */
  private stopping?: Promise<void>;
  /** Wakes the pauses between attempts, so a stop does not wait one out. */
  private readonly pauses = new Set<() => void>();

  constructor(
    private readonly options: EventConsumerOptions,
    private readonly handler: EventHandler,
    private readonly logger: ConsumerLogger,
  ) {
    // ADR-061 § 2: a consumer does not subscribe to a topic nobody is declared
    // to own. Refused here, at construction, so a mistyped or undeclared topic
    // fails the service at startup rather than dead-lettering every message.
    const undeclared = options.topics.filter((topic) => !isDeclaredTopic(topic));
    if (undeclared.length > 0) {
      // The group is not named: it can come from KAFKA_CONSUMER_GROUP (#385 r4).
      throw new Error(
        `A consumer subscribes to ${undeclared.join(', ')}, which ` +
          `${undeclared.length === 1 ? 'has' : 'have'} no producer declared in TOPIC_PRODUCERS ` +
          '(@rasta/contracts, ADR-061 § 1). Declare the owner there first.',
      );
    }

    // RUN-006: a consumer in a declared service's namespace reads only what
    // TOPIC_CONSUMERS declares for it and dead-letters where it says. Once
    // the consumer authenticates, its principal is the service it acts for,
    // and its group must be in that namespace — the same rule the broker's
    // ACLs enforce, refused here first so it fails at startup, legibly.
    // A group in any `<name>-service.` namespace is a service's consumer and
    // must be declared, authenticated or not. A principal that is not a
    // service (the development `itest-observer`, `ops-replay`) is not in
    // TOPIC_CONSUMERS at all: what it may read is the broker's ACLs alone
    // (broker-acls.<profile>.json), so it is left to the topic check above.
    const service = options.sasl?.username ?? consumerGroupService(options.groupId);
    if (
      service !== undefined &&
      (isDeclaredConsumer(service) || service.endsWith(SERVICE_NAME_SUFFIX))
    ) {
      const problem = consumerDeclarationProblem(service, options);
      if (problem !== undefined) {
        throw new Error(
          `A consumer is refused: ${problem} (@rasta/contracts TOPIC_CONSUMERS, RUN-006). ` +
            'Declare the subscription there first.',
        );
      }
    }

    this.kafka = new Kafka({
      ...kafkaClientConfig(options),
      retry: { initialRetryTime: 300, retries: 8 },
      logLevel: 1, // ERROR — kafkajs is extremely chatty at INFO
    });
    this.initializeDlqSeries();
  }

  /**
   * Exports this consumer's `rasta_dlq_messages_total` series at zero.
   *
   * `RastaDeadLetterMessagePublished` is `increase(...[5m]) > 0`, and
   * prom-client exports a labelled series only once it has a value: without
   * this, the first dead letter for a (topic, reason) after a restart would be
   * born at 1 and never alert. So every tuple this consumer can ever count —
   * its `clientId`, each subscribed source topic, each `DlqReason` — exists at
   * zero from construction, before any connection to Kafka.
   *
   * Only with a dead-letter topic: a consumer without one never counts, so it
   * gets no series either. `inc(labels, 0)` adds zero, so a second consumer
   * with the same client id and topics leaves an existing count untouched.
   */
  private initializeDlqSeries(): void {
    if (!this.options.deadLetterTopic) return;
    for (const topic of subscribedTopics(this.options.topics)) {
      for (const reason of Object.values(DLQ_REASONS)) {
        dlqMessagesTotal.inc({ service: this.options.clientId, topic, reason }, 0);
      }
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    const run: ConsumerRun = { stopRequested: false, abandoned: false };
    this.run = run;
    this.stopping = undefined;

    const consumer = this.kafka.consumer({
      groupId: this.options.groupId,
      // A projector doing database writes per message can exceed the default
      // 30s heartbeat window on a cold cache; 60s avoids a rebalance storm
      // that would only make the backlog worse.
      sessionTimeout: CONSUMER_SESSION_TIMEOUT_MS,
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
      for (const topic of subscribedTopics(this.options.topics)) {
        await consumer.subscribe({ topic, fromBeginning: this.options.fromBeginning ?? false });
      }

      await consumer.run({
        // Sequential per partition. Ordering within an aggregate is the whole
        // reason the producer sets a partition key; processing concurrently
        // inside a partition would throw it away.
        eachMessage: async ({ topic, partition, message, heartbeat }) => {
          await this.handleMessage(
            topic,
            partition,
            message.value,
            message.headers,
            message.offset,
            message.key,
            heartbeat,
            run,
          );
          // kafkajs resolves the offset as soon as this returns. A message
          // the stop gave up on at its deadline must not return, however it
          // ended — a handler or a dead letter that finished late included:
          // its offset stays uncommitted and the group delivers it again
          // (A-09 absorbs the late effect; Codex r1 on #270).
          this.abandonIfPastDeadline(run, { topic, partition, offset: message.offset });
        },
      });
    } catch (error) {
      await this.discardAfterFailedStart(consumer, error);
      throw error;
    }

    this.consumer = consumer;
    this.running = true;
    this.logger.log(
      `Consuming ${subscribedTopics(this.options.topics).join(', ')} as group ${this.options.groupId}`,
    );
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
    const closed: { failed: boolean; error?: unknown } = { failed: false };
    // Consumed here whether it ends in time or not: a disconnect that fails after the budget
    // must not become an unhandled rejection in a process that is already failing to start.
    const disconnecting = (async () => consumer.disconnect())().catch((error: unknown) => {
      closed.failed = true;
      closed.error = error;
    });
    const deadlineAt = kafkaShutdownDeadline(this.options);
    if ((await withinDeadline(disconnecting, deadlineAt - Date.now())) === 'abandoned') {
      this.logger.error(this.cleanupGaveUpMessage());
      return;
    }
    if (closed.failed) {
      this.logger.error(
        `Could not disconnect ${this.options.groupId} after a failed start ` +
          `(${describe(cause)}): ${describe(closed.error)}`,
      );
    }
  }

  /**
   * The one line every startup-failure cleanup logs when it gives up at the shutdown budget.
   * Fixed text: nothing the cleanup raised, nothing the broker said.
   */
  private cleanupGaveUpMessage(): string {
    return (
      `${this.options.groupId}: cleanup after a failed start did not finish within the ` +
      'shutdown budget; abandoned, the original startup error stands'
    );
  }

  private async handleMessage(
    topic: string,
    partition: number,
    value: Buffer | null,
    headers: IHeaders | undefined,
    offset?: string,
    key?: Buffer | null,
    heartbeat?: () => Promise<void>,
    run: ConsumerRun = this.run,
  ): Promise<void> {
    const beat = heartbeat === undefined ? undefined : () => this.beat(heartbeat);
    const read = readEnvelope(value);
    if (!read.ok) {
      // Unprocessable by construction — no number of retries changes the bytes.
      //
      // Never the parser's own message (S-09): Node's JSON.parse quotes a
      // snippet of the bytes it choked on, and a zod message can repeat a
      // received value. The log line and the dead-letter header carry fixed
      // text and metadata only; the dead-lettered message keeps the original
      // bytes, which is what it is for.
      const reason = unparseableReason(read.failure, value);
      const where = `${topic}[${partition}]${offset === undefined ? '' : `@${offset}`}`;
      this.logger.error(`Unparseable message on ${where}: ${reason}`);
      await this.deadLetter(
        { topic, partition, offset, key },
        value,
        headers,
        DLQ_REASONS.VALIDATION_FAILED,
        `Unparseable message (${DLQ_REASONS.VALIDATION_FAILED}): ${reason}`,
        0,
        run,
      );
      return;
    }
    const { envelope } = read;

    // ADR-061 § 2, before any handler and before any retry: the producer the
    // envelope names must be allowed on the topic the *broker* delivered it on
    // — never a topic the envelope claims. A refusal is a verdict, not a
    // failure, so it is dead-lettered at once and the partition moves on.
    // Consistency, not authentication: see `TOPIC_PRODUCERS`.
    //
    // The claim itself is never repeated as free text (Codex review of #124,
    // finding 1). The dead-letter header is fixed text naming only the topic
    // this consumer subscribed to; the log line is fixed text plus bounded,
    // escaped fields. The envelope schema already bounds `producer` to a
    // service name, so the escaping is a second line, not the only one.
    if (!isAllowedProducer(topic, envelope.producer)) {
      const refusal = new UnprocessableEventError(
        DLQ_REASONS.PRODUCER_NOT_ALLOWED,
        `The envelope's producer is not declared for ${topic} (ADR-061 § 2)`,
      );
      this.logger.error(
        `Refused before any handler (PRODUCER_NOT_ALLOWED) on ${topic}: ` +
          `eventId=${logField(envelope.eventId)} eventName=${logField(envelope.eventName)} ` +
          `producer=${logField(envelope.producer)}`,
      );
      await this.deadLetter(
        { topic, partition, offset, key },
        value,
        headers,
        refusal.reason,
        `Refused before any handler (${refusal.reason}): ${refusal.message}`,
        0,
        run,
      );
      return;
    }

    const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const backoff = this.options.retryBackoffMs ?? DEFAULT_BACKOFF_MS;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      // Once stopping, no attempt starts — the first included — and the pause
      // before a further one ends at once (`pause`).
      this.abandonIfStopping(run, { topic, partition, offset }, `before attempt ${attempt}`);
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
          () =>
            this.handler(
              envelope,
              Object.freeze({
                topic,
                partition,
                ...(key === undefined ? {} : { key: key === null ? null : key.toString('utf8') }),
                ...(offset === undefined ? {} : { offset }),
                ...(beat === undefined ? {} : { heartbeat: beat }),
              }),
            ),
        );
        return;
      } catch (error) {
        // The envelope's eventId is the sender's text, so it is a quoted,
        // escaped field; the handler's message is sanitised and bounded.
        const event = `${envelope.eventName} ${logField(envelope.eventId)}`;
        const message = handlerMessage(error);

        if (error instanceof UnprocessableEventError) {
          this.logger.error(`Handler refused ${event} (${error.reason}): ${message}`);
          await this.deadLetter(
            { topic, partition, offset, key },
            value,
            headers,
            error.reason,
            `Handler refused (${error.reason}): ${message}`,
            attempt,
            run,
          );
          return;
        }

        if (attempt === maxRetries) {
          const reason = exhaustedReason(error);
          this.logger.error(`Handler failed ${maxRetries}x for ${event} (${reason}): ${message}`);
          await this.deadLetter(
            { topic, partition, offset, key },
            value,
            headers,
            reason,
            `Handler failed ${maxRetries}x (${reason}): ${message}`,
            attempt,
            run,
          );
          return;
        }

        this.logger.warn(`Attempt ${attempt}/${maxRetries} failed for ${event}: ${message}`);
        // The member stays in its group across the pause (#240 r12).
        beat?.();
        await this.pause(run, backoff * attempt);
        beat?.();
      }
    }
  }

  /**
   * Gives up on a message once a stop has begun ({@link ConsumerStoppingError}):
   * thrown out of `eachMessage`, it leaves the message's offset uncommitted, so
   * the group delivers it again. Called before anything new starts for a
   * message — an attempt, a dead letter, its send — never in the middle of one:
   * what is already running is the stop's to wait for, by its deadline.
   */
  private abandonIfStopping(
    run: ConsumerRun,
    at: { topic: string; partition: number; offset: string | undefined },
    when: string,
  ): void {
    if (!run.stopRequested) return;
    this.abandon(at, when);
  }

  /**
   * Gives up on a message that ended after its stop's deadline, however it
   * ended: the stop has already returned and warned that it is delivered again,
   * so its `eachMessage` must not return and let kafkajs commit it. Also once the
   * deadline has passed by the clock but the stop's timer has not yet fired.
   */
  private abandonIfPastDeadline(
    run: ConsumerRun,
    at: { topic: string; partition: number; offset: string | undefined },
  ): void {
    const past = run.abandoned || (run.deadlineAt !== undefined && Date.now() >= run.deadlineAt);
    if (!past) return;
    this.abandon(at, 'after the shutdown deadline');
  }

  private abandon(
    at: { topic: string; partition: number; offset: string | undefined },
    when: string,
  ): never {
    const where = `${at.topic}[${at.partition}]${at.offset === undefined ? '' : `@${at.offset}`}`;
    this.logger.warn(
      `${this.options.groupId} is stopping: ${where} left uncommitted ${when}; it is delivered again`,
    );
    throw new ConsumerStoppingError(
      `${this.options.groupId} is stopping; ${where} is left uncommitted ${when}`,
    );
  }

  /** The backoff between attempts; a stop ends it at once, and none starts once stopping. */
  private pause(run: ConsumerRun, ms: number): Promise<void> {
    if (run.stopRequested) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.pauses.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.pauses.add(wake);
    });
  }

  /**
   * Starts kafkajs's heartbeat and returns at once: it is sent only when its
   * interval has passed, and one in flight is shared. A failure — a rebalance
   * under way, a broker that does not answer — is logged, never thrown into the
   * handler: the message's own outcome decides its fate, and the runner sees the
   * rebalance after it.
   */
  private beat(heartbeat: () => Promise<void>): void {
    void heartbeat().catch((error: unknown) => {
      this.logger.warn(`Heartbeat of ${this.options.groupId} failed: ${describe(error)}`);
    });
  }

  /**
   * Publishes the original bytes, unaltered, to the dead-letter topic.
   *
   * Unaltered matters: whoever replays it needs the message the producer
   * actually sent, not this consumer's re-serialization of it. The reason,
   * the error text and where the original sat (topic, partition, offset) ride
   * along as headers so the runbook (docs/runbooks/replay-dlq.md) can triage
   * without opening the body.
   *
   * Of the original headers, only the platform's own are copied
   * ({@link forwardedHeaders}); `detail` is text the caller already built
   * from fixed words and sanitised parts, never an error object to describe.
   *
   * `rasta_dlq_messages_total` counts completed publishes, so it moves only
   * after `send` resolves: a rejected send propagates without counting, and a
   * consumer with no dead-letter topic drops without counting. Its labels are
   * the closed set the metric declares — this consumer's `clientId`, the source
   * topic and the `DlqReason` — and never an event, tenant or error value.
   */
  private async deadLetter(
    original: {
      topic: string;
      partition: number;
      offset: string | undefined;
      key?: Buffer | null;
    },
    value: Buffer | null,
    headers: IHeaders | undefined,
    reason: DlqReason,
    detail: string,
    attempts: number,
    run: ConsumerRun = this.run,
  ): Promise<void> {
    // A stopping consumer starts no dead letter: the message is delivered
    // again, and its next consumer reaches the same verdict (Codex on #267).
    this.abandonIfStopping(run, original, 'before its dead letter was written');
    const originalTopic = original.topic;
    const target = this.options.deadLetterTopic;
    if (!target) {
      this.logger.error(
        `No dead-letter topic configured for ${this.options.groupId}; message from ${originalTopic} dropped`,
      );
      return;
    }

    const producer = await this.getDlqProducer();
    // Checked again after the connection: a stop that began while it was being
    // made has closed this producer, but kafkajs reopens it for sends once a
    // pending connect completes (Codex r1 on #270). No send starts then; the
    // producer is closed again, since the stop's own close may have come first.
    if (run.stopRequested) {
      void producer.disconnect().catch((error: unknown) => {
        this.logger.warn(
          `Closing the dead-letter producer of ${this.options.groupId} failed: ${describe(error)}`,
        );
      });
      this.abandon(original, 'before its dead letter was sent');
    }

    // A send in flight when the deadline passes is not cancelled — kafkajs's
    // disconnect waits for pending requests — but its message is: it may reach
    // the broker, and `eachMessage` still throws (`abandonIfPastDeadline`).
    await producer.send({
      topic: target,
      acks: -1,
      // GZIP, as every service publisher sends (organization-service's
      // `kafka.publisher.ts`, for one). The broker's size limit applies to the
      // compressed batch, so a message it admitted compressed can be far larger
      // once decompressed — and these are the decompressed bytes. Sent
      // uncompressed, such a dead letter can exceed the limit the original
      // passed and the send fails (PR #378 r1 F2). The bytes themselves are
      // unchanged. At KafkaJS's default level: a source compressed at a higher
      // level can still be refused (known escape (i), dead-letter-size.ts).
      compression: CompressionTypes.GZIP,
      messages: [
        {
          // The publisher's partition key (D-040): it carries the aggregate's
          // ordering, and a replay cannot always rebuild it from the body.
          key: original.key ?? null,
          value,
          headers: deadLetterHeaders(headers, {
            reason,
            originalTopic,
            originalPartition: original.partition,
            ...(original.offset === undefined ? {} : { originalOffset: original.offset }),
            attempts,
            detail,
            producer: this.options.clientId,
            failedAt: new Date(),
          }),
        },
      ],
    });

    dlqMessagesTotal.inc({ service: this.options.clientId, topic: originalTopic, reason });
  }

  /**
   * The dead-letter producer, connected on first use. It is held from before
   * its connection is made, so a stop can disconnect one still connecting; a
   * failed connection is let go, and the next dead letter tries again.
   */
  private async getDlqProducer(): Promise<Producer> {
    if (!this.dlqProducer) {
      const producer = this.kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
      this.dlqProducer = producer;
      this.dlqConnecting = producer.connect().catch((error: unknown) => {
        if (this.dlqProducer === producer) {
          this.dlqProducer = undefined;
          this.dlqConnecting = undefined;
        }
        throw error;
      });
    }
    const producer = this.dlqProducer;
    await this.dlqConnecting;
    return producer;
  }

  /**
   * Stops consuming, and returns by `deadlineAt` when one is given.
   *
   * Nothing new starts once it is called: no further message, no attempt, no
   * pause between attempts, no dead letter ({@link ConsumerStoppingError}).
   * kafkajs's `disconnect()` then waits for the message in flight, commits
   * the offsets of messages that finished, and leaves the group; the
   * dead-letter producer is closed after it.
   *
   * That wait used to have no bound: a handler's own timeouts, or a dead letter
   * whose producer was still connecting or whose send did not return, could
   * hold the close past SHUTDOWN_TIMEOUT_MS into the forced exit (Codex on
   * #267, Medium). With `deadlineAt` — the shared shutdown deadline that
   * `OutboxShutdown` hands its workers — the stop returns by then whatever is
   * still running, with a warning:
   *
   *   - the message in flight is left uncommitted, so the group delivers it
   *     again (A-09 absorbs a handler that did commit its effect). That holds
   *     however it ends: a handler or a dead letter that finishes after the
   *     deadline still throws out of `eachMessage`, so kafkajs never commits
   *     it (Codex r1 on #270) — the deadline bounds the message, not only the
   *     wait for it;
   *   - the dead-letter producer is closed, and no send starts once stopping,
   *     even on a connection that completes late. kafkajs's close waits for a
   *     send already in flight rather than cancel it, so that one may still
   *     reach the broker: a second dead letter on redelivery is possible, as
   *     after any crash between a send and its commit;
   *   - kafkajs's disconnect carries on in the background while the close
   *     goes on, and the partition passes to another member when it ends or,
   *     at the latest, when the session times out.
   *
   * Without `deadlineAt` (a test, a CLI) it waits as before. One stop per
   * `start()`: a later call joins the first and, once that has returned,
   * returns at once. While the first is still waiting, the EARLIEST deadline
   * of any caller applies — a later bounded call tightens an unbounded or
   * longer wait, and no call ever loosens it (PR #493 r1, F1). A disconnect
   * that fails rejects the stop, as it always has.
   */
  stop(options: OutboxStopOptions = {}): Promise<void> {
    if (this.stopping) {
      this.tightenStop(options.deadlineAt);
      return this.stopping;
    }
    this.stopping = this.halt(options.deadlineAt);
    return this.stopping;
  }

  /**
   * Cleans up after a step of the CALLER's start-up that failed once `start()` had succeeded
   * (a coverage write, a registration): the one policy for such a path, so none of them can
   * hold the failing start-up on an unbounded disconnect (PR #493 r1, F1).
   *
   * It stops by the shutdown budget the connection carries (`kafkaShutdownDeadline`, the same
   * bound a stop without a deadline gets from `kafkaConnection`), and a stop already pending
   * is tightened to it. It never rejects: a disconnect that fails is logged, one that does
   * not finish by the budget is abandoned with a fixed line, and either way the caller
   * rethrows ITS error — the one that explains why the service will not come up.
   */
  async stopAfterFailedStart(cause?: unknown): Promise<void> {
    const run = this.run;
    try {
      await this.stop({ deadlineAt: kafkaShutdownDeadline(this.options) });
    } catch (error) {
      this.logger.error(
        `Could not stop ${this.options.groupId} after a failed start` +
          `${cause === undefined ? '' : ` (${describe(cause)})`}: ${describe(error)}`,
      );
      return;
    }
    if (run.abandoned) this.logger.error(this.cleanupGaveUpMessage());
  }

  /** A stop already pending ends at the earliest deadline any caller gave it. */
  private tightenStop(deadlineAt: number | undefined): void {
    const run = this.run;
    if (deadlineAt === undefined || !run.rearm) return;
    if (run.deadlineAt !== undefined && run.deadlineAt <= deadlineAt) return;
    run.deadlineAt = deadlineAt;
    run.rearm();
  }

  /**
   * Waits for `work`, or until `run.deadlineAt` — re-read whenever a later stop tightens it.
   * Without a deadline it waits for `work` alone, until one is given.
   */
  private waitWithinDeadline(
    run: ConsumerRun,
    work: Promise<unknown>,
  ): Promise<'finished' | 'abandoned'> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const settle = (outcome: 'finished' | 'abandoned'): void => {
        clearTimeout(timer);
        run.rearm = undefined;
        resolve(outcome);
      };
      const arm = (): void => {
        clearTimeout(timer);
        if (run.deadlineAt === undefined) return;
        const boundMs = run.deadlineAt - Date.now();
        if (boundMs <= 0) return settle('abandoned');
        timer = setTimeout(() => settle('abandoned'), boundMs);
        timer.unref?.();
      };
      run.rearm = arm;
      work.then(
        () => settle('finished'),
        () => settle('finished'),
      );
      arm();
    });
  }

  private async halt(deadlineAt: number | undefined): Promise<void> {
    const run = this.run;
    this.running = false;
    run.stopRequested = true;
    run.deadlineAt = deadlineAt;
    for (const wake of [...this.pauses]) wake();

    const consumer = this.consumer;
    const producer = this.dlqProducer;
    this.consumer = undefined;
    this.dlqProducer = undefined;
    this.dlqConnecting = undefined;
    if (!consumer && !producer) return;

    let producerClosed: Promise<void> | undefined;
    const closeProducer = (): Promise<void> =>
      (producerClosed ??= producer ? producer.disconnect() : Promise.resolve());
    // The consumer first: its disconnect waits for the message in flight, which
    // may be writing its dead letter through the producer.
    const disconnecting = (async () => {
      if (consumer) await consumer.disconnect();
      await closeProducer();
    })();

    if ((await this.waitWithinDeadline(run, disconnecting)) === 'finished') return disconnecting;

    // From here the message in flight cannot be committed, however it ends.
    run.abandoned = true;
    this.logger.warn(
      `${this.options.groupId} did not stop by the shutdown deadline: the message in flight is ` +
        'abandoned uncommitted and is delivered again; the group reassigns its partition when ' +
        `the disconnect ends or the ${CONSUMER_SESSION_TIMEOUT_MS} ms session times out`,
    );
    void closeProducer().catch((error: unknown) => {
      this.logger.warn(
        `Closing the dead-letter producer of ${this.options.groupId} failed: ${describe(error)}`,
      );
    });
    void disconnecting.catch((error: unknown) => {
      this.logger.warn(`Late disconnect of ${this.options.groupId} failed: ${describe(error)}`);
    });
  }

  isRunning(): boolean {
    return this.running;
  }
}

/**
 * A sender-supplied value made safe to put in a log line: at most 64
 * characters, in quotes, with everything outside printable ASCII escaped — so
 * a newline, an ANSI sequence or a right-to-left override cannot forge or
 * disguise output. Longer values say how long they were, not what followed.
 */
export function logField(value: string, max = 64): string {
  const clipped = value.length > max ? value.slice(0, max) : value;
  const escaped = clipped.replace(
    /[^\x20-\x7e]|["\\]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return value.length > max ? `"${escaped}"...(${value.length} chars)` : `"${escaped}"`;
}

/**
 * The original headers a dead letter keeps: the platform's own, which the
 * outbox relay sets from the envelope (`EVENT_HEADERS` — event id and name,
 * version, correlation and causation ids, tenant, producer, `traceparent`,
 * stream sequence). Those are identifiers and trace context, and they are what
 * a replay to the original topic republishes. Anything else a sender attached
 * — an `authorization`, a cookie, a custom header — is dropped (S-09): the
 * dead-letter topic is read by operators, and it is not this consumer's to
 * copy. Names match exactly; the relay writes them in lower case.
 */
const FORWARDED_HEADERS: ReadonlySet<string> = new Set(Object.values(EVENT_HEADERS));

export function forwardedHeaders(headers: IHeaders | undefined): IHeaders {
  const kept: IHeaders = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (FORWARDED_HEADERS.has(name) && value !== undefined) kept[name] = value;
  }
  return kept;
}

/**
 * The most a dead letter's headers add to the original record, serialized:
 * every header {@link deadLetterHeaders} adds at its byte cap, and the varint
 * framing they can grow (`@rasta/contracts`' `dead-letter-size.ts`, which the
 * topic limits are derived from). Each dead-letter topic allows this much,
 * plus GZIP's worst case, over the largest topic it takes dead letters from
 * (`topics.txt`, `create-topics.sh`, `scripts/check-kafka-topic-limits.mjs`;
 * PR #378 r2 F1). That is proved to fit this consumer's dead letter of a
 * source batch sent uncompressed, or GZIP that did not shrink it; it is only
 * measured for compressible GZIP batches, and does not cover the known
 * escapes `dead-letter-size.ts` names.
 */
export { DLQ_ADDED_HEADERS_MAX_BYTES };

/**
 * The headers of a dead letter: the original's platform headers
 * ({@link forwardedHeaders}; any other is dropped), then why and from where
 * (`DLQ_HEADERS`) and who wrote it. The consumer's own dead letters use it, and
 * so does a service that dead-letters through its outbox an event it held back
 * (fleet's parked insurance events, #240 r9), so the replay tool and the
 * runbook read both alike.
 *
 * Every value it adds is bounded in UTF-8 bytes ({@link DLQ_ADDED_HEADERS_MAX_BYTES}).
 * What a replay depends on — the original topic, partition and offset — is
 * never cut: a value no broker could have delivered (a topic name Kafka would
 * refuse, a partition outside int32, an offset outside int64) is refused with
 * a {@link DeadLetterHeaderError}, and the message is not committed, as when
 * the send fails. The error text and the client id are cut on a character
 * boundary; the reason is one of `DLQ_REASONS`, the time an ISO instant.
 */
export function deadLetterHeaders(
  original: IHeaders | undefined,
  letter: DeadLetterDescription,
): IHeaders {
  const cap = DLQ_HEADER_VALUE_MAX_BYTES;
  if (!KAFKA_TOPIC_NAME.test(letter.originalTopic)) {
    throw new DeadLetterHeaderError('the original topic is not a Kafka topic name');
  }
  if (
    letter.originalPartition !== undefined &&
    !(
      Number.isInteger(letter.originalPartition) &&
      letter.originalPartition >= 0 &&
      letter.originalPartition <= INT32_MAX
    )
  ) {
    throw new DeadLetterHeaderError('the original partition is not a non-negative int32');
  }
  if (letter.originalOffset !== undefined && !KAFKA_OFFSET.test(letter.originalOffset)) {
    throw new DeadLetterHeaderError('the original offset is not a non-negative int64');
  }
  if (!(Number.isSafeInteger(letter.attempts) && letter.attempts >= 0)) {
    throw new DeadLetterHeaderError('the attempts are not a non-negative integer');
  }
  return {
    ...forwardedHeaders(original),
    [DLQ_HEADERS.reason]: utf8Prefix(letter.reason, cap.reason),
    [DLQ_HEADERS.originalTopic]: letter.originalTopic,
    ...(letter.originalPartition === undefined
      ? {}
      : { [DLQ_HEADERS.originalPartition]: String(letter.originalPartition) }),
    ...(letter.originalOffset === undefined
      ? {}
      : { [DLQ_HEADERS.originalOffset]: letter.originalOffset }),
    [DLQ_HEADERS.attempts]: String(letter.attempts),
    [DLQ_HEADERS.error]: utf8Prefix(letter.detail, cap.error),
    [DLQ_HEADERS.firstFailedAt]: letter.failedAt.toISOString(),
    [EVENT_HEADERS.producer]: utf8Prefix(letter.producer, cap.producer),
  };
}

/** A dead letter that would carry a value no broker delivers; never sent. */
export class DeadLetterHeaderError extends Error {
  override readonly name = 'DeadLetterHeaderError';

  constructor(problem: string) {
    super(`Dead letter not written: ${problem}`);
  }
}

/** Kafka's own rule for a topic name. At most 249 bytes. */
const KAFKA_TOPIC_NAME = /^[A-Za-z0-9._-]{1,249}$/;
/** A kafkajs offset: a non-negative int64 in decimal, at most 19 digits. */
const KAFKA_OFFSET = /^(0|[1-9][0-9]{0,18})$/;
const INT32_MAX = 2_147_483_647;

/**
 * `text`, or its longest prefix of at most `maxBytes` UTF-8 bytes that ends on
 * a character boundary. Measured as kafkajs writes a header (`Buffer.from`):
 * a lone surrogate is three bytes.
 */
export function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

/** The longest handler message a log line or `x-dlq-error` repeats, in characters. */
export const HANDLER_MESSAGE_MAX = LOG_TEXT_MAX;

/**
 * A handler's error message, fit for a log line and a header: `Name: message`
 * (the refusal's own message for {@link UnprocessableEventError}, whose
 * reason is stated beside it), through `safeLogText` — the rule the HTTP
 * exception filter applies too: credentials scrubbed, control characters,
 * line and paragraph separators and bidirectional overrides replaced by a
 * space, so it cannot forge a second log line or disguise itself, and cut to
 * {@link HANDLER_MESSAGE_MAX} characters with an ellipsis. Persian text passes
 * through: the message is the service's own, and operators read it.
 */
export function handlerMessage(error: unknown): string {
  const text = error instanceof UnprocessableEventError ? error.message : describe(error);
  return safeLogText(text, HANDLER_MESSAGE_MAX);
}

/**
 * The message's bytes as an event envelope, or why not: the `JSON.parse`
 * error, or the envelope schema's `LegacyRefusal` (from `legacyParse`,
 * so {@link unparseableReason} names zod 3's codes against the schema that
 * refused — PR #444 r1 F1).
 */
function readEnvelope(
  value: Buffer | null,
): { ok: true; envelope: EventEnvelope } | { ok: false; failure: unknown } {
  try {
    if (!value) throw new Error('Message has no body');
    const parsed = legacyParse(eventEnvelopeSchema, JSON.parse(value.toString('utf8')));
    if (!parsed.success) return { ok: false, failure: parsed.refusal };
    // `payload` is `unknown` in the schema, which zod infers as optional.
    // Restating it makes it a present key again — the handler is entitled to
    // find the property there even when its value is undefined.
    return { ok: true, envelope: { ...parsed.data, payload: parsed.data.payload } };
  } catch (error) {
    return { ok: false, failure: error };
  }
}

/**
 * Why a message could not be read as an event envelope, in words that contain
 * nothing from the message itself: fixed text, the body's size, and — for an
 * envelope that parsed as JSON but failed the schema — each issue's path and
 * zod 3 code, from the envelope schema's `LegacyRefusal`. Paths name
 * schema fields (escaped and bounded all the same); messages are left out
 * because some repeat the value received. Anything else — a bare zod error
 * included, which carries no schema to translate against — is described by its
 * class only.
 */
export function unparseableReason(failure: unknown, value: Buffer | null): string {
  if (!value) return 'the message has no body';
  const size = `${value.length} bytes`;
  if (isLegacyRefusal(failure)) {
    const { issues } = failure;
    const named = issues
      .slice(0, 5)
      .map((issue) => `${logField(issue.path.join('.') || '(root)', 48)} ${issue.code}`)
      .join('; ');
    const more = issues.length > 5 ? `; and ${issues.length - 5} more` : '';
    return `the body is not a valid event envelope (${size}): ${named}${more}`;
  }
  if (failure instanceof SyntaxError) return `the body is not valid JSON (${size})`;
  return `the body could not be read (${size}, ${failure instanceof Error ? failure.name : 'unknown error'})`;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
