import type { ZodIssue } from 'zod';
import {
  AUDIT_EVENT_RECORDED,
  AUDIT_EVENT_RECORDED_VERSION,
  AUDIT_TRAIL_TOPIC,
  auditTrailPayloadSchemaV1,
  eventEnvelopeSchema,
  type AuditChange,
  type AuditChangeValue,
  type AuditTrailPayloadV1,
  type EventEnvelope,
} from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import { isSensitiveKey, toEnvelopeProvenance, type AuditEventRecord } from './audit.mapper';
import { INGESTION_FAILURE_REASONS } from '../observability/metrics';

/**
 * Path B of ADR-053: one `AUDIT_EVENT_RECORDED` message becomes one audit row
 * (AUD-004 Phase B).
 *
 * ## The opposite posture to path A, on purpose
 *
 * The domain projector's mapper is total — it refuses no envelope, because a
 * store that dropped an unfamiliar domain event would be least reliable on the
 * day a new service ships. This mapper is the reverse, and for an equally
 * specific reason: a path-B message is written *for* audit, by a producer that
 * chose every field. A field that is wrong is therefore not an unfamiliar fact
 * to be preserved, it is a claim this store would be making on the producer's
 * behalf forever. So everything is checked first, nothing is repaired, and a
 * message that fails any check throws — which the shared consumer retries and
 * then dead-letters, leaving the original bytes replayable once the producer is
 * fixed. Nothing is written and nothing is marked processed.
 *
 * ## Tenant identity comes from exactly two places, and they must agree
 *
 * `envelope.tenantId` and `payload.organizationId`. Both present and equal is a
 * tenant record; both absent is a platform record (ADR-053 §§ 5, 10). Every
 * other combination is refused — including a blank pair, which PostgreSQL
 * would refuse anyway, and a pair that differs only by case. There is no
 * fallback to the actor, the resource or anything else: picking a tenant for a
 * producer that disagreed with itself is how a record ends up in the wrong
 * tenant's chain and in the wrong tenant's search results.
 *
 * ## What a rejection may say
 *
 * `AuditTrailRejectedError.message` reaches the platform log **and** the
 * `x-dlq-error` header of the dead-letter copy (`EventConsumer.deadLetter`), and
 * both are read with none of the audit store's access controls. So a rejection
 * names schema paths, Zod issue codes and fixed phrases — never a value, and
 * never a Zod message, which quotes the value it received.
 */

/** The audit-trail consumer group. Also the `processed_event` key. */
export const AUDIT_TRAIL_CONSUMER = 'audit-service.trail';

/** `audit_event.correction_of VARCHAR(64)`. The contract sets no upper bound. */
const CORRECTION_OF_MAX_LENGTH = 64;

/** `audit_event.occurrence_count INTEGER`. The contract bounds it below only. */
const OCCURRENCE_COUNT_MAX = 2_147_483_647;

/** How many schema issues or change entries one rejection names. */
const MAX_REPORTED_ITEMS = 10;

/** The closed set of reasons a path-B message is refused for. */
export const AUDIT_TRAIL_REJECTION_REASONS = [
  INGESTION_FAILURE_REASONS.TRAIL_INVALID_ENVELOPE,
  INGESTION_FAILURE_REASONS.TRAIL_UNSUPPORTED_EVENT,
  INGESTION_FAILURE_REASONS.TRAIL_INVALID_PAYLOAD,
  INGESTION_FAILURE_REASONS.TRAIL_TENANT_MISMATCH,
  INGESTION_FAILURE_REASONS.TRAIL_UNREDACTED_SENSITIVE_CHANGE,
] as const;

export type AuditTrailRejectionReason = (typeof AUDIT_TRAIL_REJECTION_REASONS)[number];

/** A path-B message this store will not record. Carries no value from it. */
export class AuditTrailRejectedError extends Error {
  constructor(
    readonly reason: AuditTrailRejectionReason,
    readonly detail: string,
  ) {
    super(`audit trail message rejected: ${reason} (${detail})`);
    this.name = 'AuditTrailRejectedError';
  }
}

function rejected(reason: AuditTrailRejectionReason, detail: string): AuditTrailRejectedError {
  return new AuditTrailRejectedError(reason, detail);
}

/** Bounded list, with the overflow counted rather than printed. */
function summarise(items: readonly string[]): string {
  const shown = items.slice(0, MAX_REPORTED_ITEMS).join(', ');
  return items.length > MAX_REPORTED_ITEMS ? `${shown}, …(${items.length} total)` : shown;
}

/**
 * Where a schema failed and how, without what it failed on.
 *
 * A path is made of declared schema keys and array indices only: every object
 * in the envelope and the v1 payload is a fixed-shape `z.object`, so no segment
 * can be a key the producer invented, and `unrecognized_keys` reports at the
 * parent's path without naming the extra key.
 */
function describeIssues(issues: readonly ZodIssue[]): string {
  return summarise(
    issues.map(
      (issue) => `${issue.path.length === 0 ? '(root)' : issue.path.join('.')} ${issue.code}`,
    ),
  );
}

const isBlank = (value: string): boolean => value.trim().length === 0;

/**
 * The organization a record belongs to, or `null` for a platform record.
 *
 * Exact string equality, deliberately: `ORG-1` and `org-1` are two identifiers
 * as far as every tenant-scoped query in this service is concerned, so
 * normalising one into the other here would file a record under a tenant the
 * producer did not name.
 */
function resolveOrganization(
  tenantId: string | undefined,
  organizationId: string | undefined,
): string | null {
  if (tenantId === undefined && organizationId === undefined) return null;

  const mismatch = INGESTION_FAILURE_REASONS.TRAIL_TENANT_MISMATCH;
  if (tenantId === undefined) {
    throw rejected(mismatch, 'payload organizationId present, envelope tenantId absent');
  }
  if (organizationId === undefined) {
    throw rejected(mismatch, 'envelope tenantId present, payload organizationId absent');
  }
  if (isBlank(tenantId) || isBlank(organizationId)) {
    throw rejected(mismatch, 'blank organization identifier');
  }
  if (tenantId !== organizationId) {
    throw rejected(mismatch, 'payload organizationId differs from envelope tenantId');
  }
  return organizationId;
}

/**
 * The checks the contract leaves to the store, because they are facts about
 * the columns rather than about the wire.
 *
 * Refused rather than truncated. Path A truncates an oversized envelope field
 * because dropping an unfamiliar domain event is the larger harm; here a
 * truncated `correctionOf` would point a correction at a record nobody named,
 * and a blank actor would be a refusal attributed to no-one.
 */
function assertPersistable(payload: AuditTrailPayloadV1): void {
  const blank: string[] = [];
  if (isBlank(payload.actor.id)) blank.push('actor.id');
  if (isBlank(payload.resourceType)) blank.push('resourceType');
  if (payload.resourceId !== null && isBlank(payload.resourceId)) blank.push('resourceId');
  // ADR-053 § 7 requires a correction's reason to be non-empty, and a reason of
  // spaces satisfies the contract's `min(1)` while saying nothing.
  if (payload.reason !== undefined && isBlank(payload.reason)) blank.push('reason');
  if (payload.correctionOf !== undefined && isBlank(payload.correctionOf)) {
    blank.push('correctionOf');
  }

  const invalid = INGESTION_FAILURE_REASONS.TRAIL_INVALID_PAYLOAD;
  if (blank.length > 0) throw rejected(invalid, `${summarise(blank)} blank`);

  if (
    payload.correctionOf !== undefined &&
    payload.correctionOf.length > CORRECTION_OF_MAX_LENGTH
  ) {
    throw rejected(invalid, `correctionOf exceeds ${CORRECTION_OF_MAX_LENGTH} characters`);
  }
  if (payload.occurrenceCount > OCCURRENCE_COUNT_MAX) {
    throw rejected(invalid, `occurrenceCount exceeds ${OCCURRENCE_COUNT_MAX}`);
  }
}

/** A scalar reveals the value; `null` and the two markers do not. */
const discloses = (value: AuditChangeValue): boolean => value !== null && typeof value !== 'object';

/** `password`, and also `credentials.password`: any sensitive segment counts. */
const isSensitiveField = (field: string): boolean =>
  field.split('.').some((segment) => isSensitiveKey(segment));

/**
 * The store's own last check that no sensitive value is about to become
 * permanent.
 *
 * Redaction is the producer's job and the contract says so (ADR-053 § 5 point
 * 4). This is not a second redactor — nothing is rewritten — it is the refusal
 * to accept a producer's failure to do that job, because this table is the one
 * place a leaked value can never be deleted from. The list is `SENSITIVE_KEYS`
 * from `@rasta/logging`, the same one log redaction and path A's diagnostics
 * use, so a key added there is enforced here the moment it is declared.
 */
function assertRedacted(changes: readonly AuditChange[] | undefined): void {
  if (changes === undefined) return;

  const exposed = changes.flatMap((change, index) =>
    isSensitiveField(change.field) && (discloses(change.from) || discloses(change.to))
      ? [`changes.${index}`]
      : [],
  );

  if (exposed.length > 0) {
    throw rejected(
      INGESTION_FAILURE_REASONS.TRAIL_UNREDACTED_SENSITIVE_CHANGE,
      `${summarise(exposed)} carry a raw value for a sensitive field`,
    );
  }
}

/**
 * Validates one delivered message and maps it into the record the store keeps.
 *
 * The order is the order of what a later check depends on: the envelope has to
 * parse before its name and version mean anything, the name and version select
 * the payload schema, and the payload has to parse before its tenant can be
 * compared with the envelope's. Every envelope-derived column comes from
 * `toEnvelopeProvenance`, the function path A uses, so the two paths cannot
 * disagree about what `occurredAt`, the source event or the topic means.
 */
export function toAuditTrailRecord(
  envelope: EventEnvelope,
  delivery: EventDelivery,
): AuditEventRecord {
  // Re-parsed even though `EventConsumer` parsed it first: this function is
  // the boundary, and a boundary that trusts its caller to have validated is
  // one refactor away from not being one.
  const parsedEnvelope = eventEnvelopeSchema.safeParse(envelope);
  if (!parsedEnvelope.success) {
    throw rejected(
      INGESTION_FAILURE_REASONS.TRAIL_INVALID_ENVELOPE,
      describeIssues(parsedEnvelope.error.issues),
    );
  }
  const checked: EventEnvelope = { ...parsedEnvelope.data, payload: parsedEnvelope.data.payload };

  const unsupported = INGESTION_FAILURE_REASONS.TRAIL_UNSUPPORTED_EVENT;
  if (checked.eventName !== AUDIT_EVENT_RECORDED) {
    throw rejected(unsupported, `eventName is not ${AUDIT_EVENT_RECORDED}`);
  }
  if (checked.eventVersion !== AUDIT_EVENT_RECORDED_VERSION) {
    throw rejected(unsupported, `eventVersion is not ${AUDIT_EVENT_RECORDED_VERSION}`);
  }
  // `sourceTopic` is what tells a path-B row from a path-A row for the rest of
  // the store's life, so a trail event that arrived anywhere else is refused
  // rather than recorded under a topic that would misdescribe it.
  if (delivery.topic !== AUDIT_TRAIL_TOPIC) {
    throw rejected(unsupported, `not delivered on ${AUDIT_TRAIL_TOPIC}`);
  }

  const parsedPayload = auditTrailPayloadSchemaV1.safeParse(checked.payload);
  if (!parsedPayload.success) {
    throw rejected(
      INGESTION_FAILURE_REASONS.TRAIL_INVALID_PAYLOAD,
      describeIssues(parsedPayload.error.issues),
    );
  }
  const payload = parsedPayload.data;

  const organizationId = resolveOrganization(checked.tenantId, payload.organizationId);
  assertPersistable(payload);
  assertRedacted(payload.changes);

  return {
    ...toEnvelopeProvenance(checked, delivery),

    actorType: payload.actor.type,
    actorId: payload.actor.id,
    // A copy, so nothing downstream can mutate the parsed payload through it.
    actorRoles: [...payload.actor.roles],

    organizationId,

    action: payload.action,
    resourceType: payload.resourceType,
    resourceId: payload.resourceId,

    outcome: payload.outcome,
    errorCode: payload.errorCode ?? null,
    reason: payload.reason ?? null,
    // An empty array stays an empty array: "declared no field changes" and
    // "no delta applies" are different statements, and the hash keeps them
    // different.
    changes: payload.changes ?? null,
    occurrenceCount: payload.occurrenceCount,

    sourceIp: payload.source?.ip ?? null,
    sourceUserAgent: payload.source?.userAgent ?? null,

    correctionOf: payload.correctionOf ?? null,
  };
}
