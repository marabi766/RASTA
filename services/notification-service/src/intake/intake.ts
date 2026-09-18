import type { EventEnvelope } from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { dedupeKeyFor } from '../rules/dedupe';
import { sanitiseContext, type ContextData } from '../rules/context-sanitiser';
import {
  ruleForEvent,
  type Classification,
  type NotificationRule,
  type Severity,
} from '../rules/rules';

/**
 * Turns one delivered envelope into the intent the consumer will try to write,
 * or into a reason not to. Pure: no I/O, no clock beyond the envelope's own.
 *
 * Three outcomes, and they are answered in this order:
 *
 *   IGNORED   no rule for this event name. `INSURANCE_RECORDED`,
 *             `MAINTENANCE_CREATED` and the rest of the two topics are simply
 *             not this service's concern yet; nothing is written.
 *   POISON    the envelope carries no tenant, the payload fails the rule's
 *             schema, or the payload's organization disagrees with the
 *             envelope's. Retrying changes nothing, so the error is thrown for
 *             the shared consumer to dead-letter (ADR-054 § 7, `POISON`).
 *   INTENT    a fully described intent, ready for the transactional write.
 */

export const ID_PREFIX = {
  intent: 'NTI',
  resolution: 'NTR',
  delivery: 'NTD',
  attempt: 'NTA',
  inApp: 'NTN',
} as const;

export function newId(prefix: keyof typeof ID_PREFIX): string {
  return `${ID_PREFIX[prefix]}_${ulid()}`;
}

/** Thrown for a message no retry can fix. */
export class PoisonEventError extends Error {
  constructor(
    readonly reason: PoisonReason,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = 'PoisonEventError';
  }
}

export const POISON_REASONS = {
  MISSING_TENANT: 'MISSING_TENANT',
  PAYLOAD_INVALID: 'PAYLOAD_INVALID',
  TENANT_MISMATCH: 'TENANT_MISMATCH',
} as const;

export type PoisonReason = (typeof POISON_REASONS)[keyof typeof POISON_REASONS];

export interface IntentInput {
  readonly id: string;
  readonly organizationId: string;
  readonly sourceEventId: string;
  readonly sourceEventName: string;
  readonly sourceTopic: string;
  readonly sourcePartitionKey: string;
  readonly sourceStreamSeq: bigint | null;
  readonly occurredAt: Date;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly ruleKey: string;
  readonly templateKey: string;
  readonly severity: Severity;
  readonly classification: Classification;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly dedupeKey: string;
  readonly contextData: ContextData;
  /** Keys the sanitiser refused — counted, never logged with their values. */
  readonly droppedContextKeys: readonly string[];
}

export type IntakeDecision =
  | { readonly kind: 'IGNORED' }
  | { readonly kind: 'INTENT'; readonly rule: NotificationRule; readonly intent: IntentInput };

export function decideIntake(envelope: EventEnvelope, delivery: EventDelivery): IntakeDecision {
  const rule = ruleForEvent(envelope.eventName);
  if (!rule) return { kind: 'IGNORED' };

  if (!envelope.tenantId) {
    throw new PoisonEventError(
      POISON_REASONS.MISSING_TENANT,
      `${envelope.eventName} ${envelope.eventId} carries no tenantId`,
    );
  }

  const parsed = rule.payloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    // Paths only, never values: the payload is the thing being refused.
    const paths = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw new PoisonEventError(
      POISON_REASONS.PAYLOAD_INVALID,
      `${envelope.eventName} ${envelope.eventId} payload rejected at ${paths.join(', ')}`,
    );
  }

  const payload = parsed.data;
  const payloadOrganizationId = (payload as { organizationId?: unknown }).organizationId;
  if (typeof payloadOrganizationId === 'string' && payloadOrganizationId !== envelope.tenantId) {
    throw new PoisonEventError(
      POISON_REASONS.TENANT_MISMATCH,
      `${envelope.eventName} ${envelope.eventId} names a different organization in its payload than its envelope`,
    );
  }

  const organizationId = envelope.tenantId;
  const subjectId = rule.subjectId(payload);
  const bucket = rule.dedupeBucket(payload);
  const { context, dropped } = sanitiseContext(payload, rule.contextAllowlist);

  return {
    kind: 'INTENT',
    rule,
    intent: {
      id: newId('intent'),
      organizationId,
      sourceEventId: envelope.eventId,
      sourceEventName: envelope.eventName,
      sourceTopic: delivery.topic,
      // The stream is `topic + partitionKey` (ADR-051 § C-7). The envelope's
      // `streamKey` is that key when the producer sent one; the aggregate id
      // is what every producer here partitions on when it did not.
      sourcePartitionKey: envelope.streamKey ?? envelope.aggregateId,
      sourceStreamSeq: envelope.streamSeq === undefined ? null : BigInt(envelope.streamSeq),
      occurredAt: new Date(envelope.occurredAt),
      correlationId: envelope.correlationId,
      causationId: envelope.causationId ?? null,
      ruleKey: rule.ruleKey,
      templateKey: rule.template.key,
      severity: rule.severity,
      classification: rule.classification,
      subjectType: rule.subjectType,
      subjectId,
      dedupeKey: dedupeKeyFor({
        organizationId,
        ruleKey: rule.ruleKey,
        subjectType: rule.subjectType,
        subjectId,
        bucket,
      }),
      contextData: context,
      droppedContextKeys: dropped,
    },
  };
}
