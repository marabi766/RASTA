import { z } from 'zod';

/**
 * The envelope every Kafka message on the platform carries.
 *
 * Its job is to make a message self-describing enough that a consumer written
 * two years from now can decide what to do with it: what happened, to which
 * aggregate, at which version, on whose behalf, and caused by what.
 *
 * `eventId` doubles as the consumer-side idempotency key. `tenantId` is on the
 * envelope rather than buried in each payload so that scoping is uniform and
 * cannot be forgotten by one event's author.
 */

export const actorTypeSchema = z.enum(['USER', 'SERVICE', 'SYSTEM']);
export type ActorType = z.infer<typeof actorTypeSchema>;

export const eventActorSchema = z.object({
  type: actorTypeSchema,
  id: z.string().min(1),
});
export type EventActor = z.infer<typeof eventActorSchema>;

export const eventEnvelopeSchema = z.object({
  /** ULID. The consumer-side idempotency key. */
  eventId: z.string().min(1),
  eventName: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Event names are SCREAMING_SNAKE_CASE'),
  /** Payload schema version. Distinct from the topic's envelope version. */
  eventVersion: z.number().int().positive().default(1),

  /** When it happened in the domain — not when it was published. */
  occurredAt: z.string().datetime(),

  producer: z.string().min(1),
  producerVersion: z.string().default('0.0.0'),

  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  /**
   * Monotonic per aggregate. Lets a consumer detect a gap or a reordering
   * without consulting the producer.
   */
  aggregateVersion: z.number().int().nonnegative().optional(),

  /** The organization this event belongs to. Consumers must apply it. */
  tenantId: z.string().optional(),

  correlationId: z.string().min(1),
  /** The event or command that caused this one — the causal chain. */
  causationId: z.string().optional(),
  traceparent: z.string().optional(),

  actor: eventActorSchema.optional(),

  /**
   * ADR-051 — the event's position within its ordered stream.
   *
   * The stream is `topic + partitionKey` and nothing else (§ C-7), so
   * `streamKey` is today's partition key under a name that says what it is
   * for. A consumer that keeps the last sequence it saw per
   * `(streamKey, consumerName)` can tell a duplicate from a gap without asking
   * the producer — which is what ADR-051 § R6 measured as missing today.
   *
   * **Both are optional, and must stay optional.** During a staged rollout an
   * old producer emits neither and a new consumer must still accept the
   * envelope; a new producer emits both and an old consumer ignores them. That
   * is why `eventVersion` does not change: an added optional field is not a
   * breaking change.
   *
   * `streamSeq` is a **number**, not a string. PostgreSQL stores the column as
   * `BIGINT`, so the conversion at the wire boundary is checked and fails
   * loudly rather than silently truncating — see `assertSafeStreamSeq`. A
   * JavaScript `bigint` is never serialised into JSON; `JSON.stringify` throws
   * on one, and a string here would change the accepted wire type.
   *
   * Carrying these two adds no personal data: `streamKey` is the partition key
   * already on the row, and `streamSeq` is a counter.
   */
  streamSeq: z.number().int().positive().safe().optional(),
  streamKey: z.string().min(1).optional(),

  payload: z.unknown(),
});

/**
 * The largest stream sequence that survives a round trip through JSON.
 *
 * `outbox_stream_sequence.next_seq` is a `BIGINT`, whose range is far wider
 * than a JavaScript safe integer. A stream would have to emit 9,007,199,254,
 * 740,991 events to reach this, which is not a number any real stream gets to
 * — but "cannot happen" is not the same as "is not checked", and the failure
 * mode if it did would be a silently wrong sequence on the wire.
 */
export const MAX_STREAM_SEQ = Number.MAX_SAFE_INTEGER;

/**
 * Converts an allocated sequence to the wire representation, or throws.
 *
 * The database hands back a `bigint` (Prisma maps `BIGINT` that way). This is
 * the single boundary where it becomes a `number`, and it refuses rather than
 * rounds: a sequence that cannot be represented exactly would put a consumer's
 * gap detection permanently out of step with the producer.
 */
export function toStreamSeq(value: bigint | number): number {
  const asNumber = typeof value === 'bigint' ? Number(value) : value;
  assertSafeStreamSeq(asNumber);
  return asNumber;
}

/** Throws unless `value` is a positive safe integer. */
export function assertSafeStreamSeq(value: number): asserts value is number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(
      `streamSeq must be a positive safe integer, received ${String(value)}. ` +
        `The outbox counter is a BIGINT; values above ${MAX_STREAM_SEQ} cannot be ` +
        'represented exactly on the wire and must not be silently rounded.',
    );
  }
}

/** The canonical decimal representation of a sequence, for the Kafka header. */
export function formatStreamSeq(value: number): string {
  assertSafeStreamSeq(value);
  return String(value);
}

export type EventEnvelope<TPayload = unknown> = Omit<
  z.infer<typeof eventEnvelopeSchema>,
  'payload'
> & { payload: TPayload };

/**
 * Validates an envelope and its payload together.
 *
 * Called on publish *and* on consume. Validating twice is deliberate: the
 * publish check stops a malformed event from ever entering the log, and the
 * consume check stops a consumer from acting on an event whose shape changed
 * under it during a rollout.
 */
export function parseEnvelope<TSchema extends z.ZodTypeAny>(
  raw: unknown,
  payloadSchema: TSchema,
): EventEnvelope<z.infer<TSchema>> {
  const envelope = eventEnvelopeSchema.parse(raw);
  const payload = payloadSchema.parse(envelope.payload);
  return { ...envelope, payload };
}

export function isEventName(value: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(value);
}

/** Topic for a domain's main stream. */
export function topicFor(domain: string, majorVersion = 1): string {
  return `rasta.${domain}.v${majorVersion}`;
}

export function retryTopicFor(domain: string, majorVersion = 1): string {
  return `${topicFor(domain, majorVersion)}.retry`;
}

export function deadLetterTopicFor(domain: string, majorVersion = 1): string {
  return `${topicFor(domain, majorVersion)}.dlq`;
}

export const AUDIT_TRAIL_TOPIC = 'rasta.audit.trail.v1';

/** Headers carried alongside the message body, for cheap broker-level filtering. */
export const EVENT_HEADERS = {
  eventId: 'x-event-id',
  eventName: 'x-event-name',
  eventVersion: 'x-event-version',
  correlationId: 'x-correlation-id',
  causationId: 'x-causation-id',
  tenantId: 'x-tenant-id',
  producer: 'x-producer',
  traceparent: 'traceparent',
  /**
   * ADR-051 § D-5. The sequence only — the accepted design names no
   * `x-stream-key` header, because the partition key is already the Kafka
   * message key and a second copy could disagree with it.
   */
  streamSeq: 'x-stream-seq',
} as const;

/** Dead-letter headers. Every DLQ message explains how it got there. */
export const DLQ_HEADERS = {
  reason: 'x-dlq-reason',
  originalTopic: 'x-dlq-original-topic',
  attempts: 'x-dlq-attempts',
  error: 'x-dlq-error',
  firstFailedAt: 'x-dlq-first-failed-at',
} as const;

export const DLQ_REASONS = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  SCHEMA_VERSION_UNSUPPORTED: 'SCHEMA_VERSION_UNSUPPORTED',
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  MAX_RETRIES_EXCEEDED: 'MAX_RETRIES_EXCEEDED',
} as const;

export type DlqReason = (typeof DLQ_REASONS)[keyof typeof DLQ_REASONS];

/**
 * Whether a dead-lettered message may be replayed automatically.
 *
 * Financial events never may. Replaying a settlement without first checking
 * what actually happened to the money is a larger risk than the original
 * failure. See docs/runbooks/replay-dlq.md.
 */
export const NEVER_AUTO_REPLAY = new Set([
  'ORDER_RECEIPT_CONFIRMED',
  'PAYMENT_AUTHORIZED',
  'PAYMENT_COMPLETED',
  'PAYMENT_FAILED',
  'COMMISSION_APPLIED',
  'SETTLEMENT_COMPLETED',
  'STATEMENT_APPROVED',
  'JOURNAL_POSTED',
  'REWARD_GRANTED',
]);

export function isAutoReplayable(eventName: string): boolean {
  return !NEVER_AUTO_REPLAY.has(eventName);
}
