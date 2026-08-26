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

  payload: z.unknown(),
});

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
