import type { ZodIssue } from 'zod';
import {
  AUDIT_EVENT_RECORDED,
  AUDIT_EVENT_RECORDED_VERSION,
  AUDIT_TRAIL_TOPIC,
  EVENT_HEADERS,
  auditTrailPayloadSchemaV1,
  eventEnvelopeSchema,
  type AuditTrailPayloadV1,
  type ErrorCode,
  type EventEnvelope,
} from '@rasta/contracts';
import type { OutboxRow } from '@rasta/nest-common';
import { SERVICE_NAME } from '../config/env';
import { MAX_OCCURRENCE_COUNT } from './refusal-aggregation';

/**
 * One `security_event_outbox` row → one `AUDIT_EVENT_RECORDED` v1 envelope
 * (ADR-053 §§ 1, 4; AUD-004 Phases C1–C2).
 *
 * Every wire value comes from a contract constant or a persisted column:
 *
 *   outcome          `REFUSED` — a constant; the only thing this queue records.
 *   occurrenceCount  the row's `occurrence_count` — how many matching refusals
 *                    its aggregation window counted (Phase C2). Read only from
 *                    a row the relay has claimed, and a claimed row can no
 *                    longer change, so the number published is final.
 *   occurredAt       the row's `occurred_at` — the first occurrence in the
 *                    window, on the database clock.
 *
 * Deterministic per row: `eventId` is the row id and every other value a
 * column that is frozen by the time the row is claimed, so a row delivered
 * twice produces the same envelope — count included — and the audit consumer's
 * `(eventId, consumer)` key keeps the second one out.
 */

export const REFUSAL_OUTCOME = 'REFUSED' as const satisfies AuditTrailPayloadV1['outcome'];

/** The persisted evidence columns of one row, as the store reads them back. */
export interface SecurityEventRecord {
  id: string;
  organizationId: string | null;
  actorType: 'USER' | 'SERVICE' | 'SYSTEM';
  actorId: string;
  actorRoles: readonly string[];
  action: string;
  resourceType: string;
  resourceId: string | null;
  errorCode: ErrorCode;
  reason: string | null;
  sourceIp: string | null;
  sourceUserAgent: string | null;
  correlationId: string;
  traceparent: string | null;
  producerVersion: string;
  /** The first occurrence in the aggregation window. */
  occurredAt: Date;
  /** Matching refusals this row stands for, 1..2147483647 (Phase C2). */
  occurrenceCount: number;
}

/** Delivery state carried alongside, for the relay. */
export interface SecurityEventDeliveryState {
  createdAt: Date;
  publishedAt: Date | null;
  attempts: number;
  lastError: string | null;
}

/**
 * The Kafka key, and the envelope's `aggregateId`.
 *
 * The catalogue's default rule as the implementation plan § 5 applies it to
 * path B: the refused resource's id, falling back to the actor's. Stable per
 * resource, and an identifier the platform already issues — never a request
 * value, an IP or a user agent.
 */
export function partitionKeyOf(record: SecurityEventRecord): string {
  return record.resourceId ?? record.actorId;
}

export function toAuditTrailPayload(record: SecurityEventRecord): AuditTrailPayloadV1 {
  const source = {
    ...(record.sourceIp !== null ? { ip: record.sourceIp } : {}),
    ...(record.sourceUserAgent !== null ? { userAgent: record.sourceUserAgent } : {}),
  };

  return {
    actor: { type: record.actorType, id: record.actorId, roles: [...record.actorRoles] },
    ...(record.organizationId !== null ? { organizationId: record.organizationId } : {}),
    action: record.action,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    outcome: REFUSAL_OUTCOME,
    errorCode: record.errorCode,
    ...(record.reason !== null ? { reason: record.reason } : {}),
    occurrenceCount: record.occurrenceCount,
    ...(Object.keys(source).length > 0 ? { source } : {}),
  };
}

export function toAuditTrailEnvelope(
  record: SecurityEventRecord,
): EventEnvelope<AuditTrailPayloadV1> {
  return {
    eventId: record.id,
    eventName: AUDIT_EVENT_RECORDED,
    eventVersion: AUDIT_EVENT_RECORDED_VERSION,
    occurredAt: record.occurredAt.toISOString(),
    producer: SERVICE_NAME,
    producerVersion: record.producerVersion,
    aggregateType: record.resourceType,
    aggregateId: partitionKeyOf(record),
    // The tenant in both places the contract names, from one column — so the
    // two cannot disagree by construction (the consumer refuses them if they do).
    ...(record.organizationId !== null ? { tenantId: record.organizationId } : {}),
    correlationId: record.correlationId,
    ...(record.traceparent !== null ? { traceparent: record.traceparent } : {}),
    actor: { type: record.actorType, id: record.actorId },
    payload: toAuditTrailPayload(record),
  };
}

function headersOf(envelope: EventEnvelope): Record<string, string> {
  return {
    [EVENT_HEADERS.eventId]: envelope.eventId,
    [EVENT_HEADERS.eventName]: envelope.eventName,
    [EVENT_HEADERS.eventVersion]: String(envelope.eventVersion),
    [EVENT_HEADERS.correlationId]: envelope.correlationId,
    [EVENT_HEADERS.producer]: envelope.producer,
    ...(envelope.tenantId ? { [EVENT_HEADERS.tenantId]: envelope.tenantId } : {}),
    ...(envelope.traceparent ? { [EVENT_HEADERS.traceparent]: envelope.traceparent } : {}),
  };
}

/** The row the shared relay publishes. Topic and name are contract constants. */
export function toSecurityEventOutboxRow(
  record: SecurityEventRecord & SecurityEventDeliveryState,
): OutboxRow {
  const envelope = toAuditTrailEnvelope(record);
  return {
    id: record.id,
    aggregateType: envelope.aggregateType,
    aggregateId: envelope.aggregateId,
    eventName: AUDIT_EVENT_RECORDED,
    eventVersion: AUDIT_EVENT_RECORDED_VERSION,
    topic: AUDIT_TRAIL_TOPIC,
    partitionKey: envelope.aggregateId,
    payload: envelope,
    headers: headersOf(envelope),
    organizationId: record.organizationId,
    correlationId: record.correlationId,
    createdAt: record.createdAt,
    publishedAt: record.publishedAt,
    attempts: record.attempts,
    lastError: record.lastError,
  };
}

// ---------------------------------------------------------------------------
// Validation — the last check before anything reaches the topic.
// ---------------------------------------------------------------------------

/**
 * A row this producer refuses to publish.
 *
 * The message is written to `last_error` and to the relay's log, so it names
 * schema paths, Zod issue codes and fixed phrases only — never a value, and
 * never a Zod message, which quotes the value it received.
 */
export class AuditTrailContractError extends Error {
  constructor(readonly detail: string) {
    super(`audit trail event refused before publish: ${detail}`);
    this.name = 'AuditTrailContractError';
  }
}

const MAX_REPORTED_ISSUES = 10;

function describeIssues(issues: readonly ZodIssue[]): string {
  const described = issues.map(
    (issue) => `${issue.path.length === 0 ? '(root)' : issue.path.join('.')} ${issue.code}`,
  );
  const shown = described.slice(0, MAX_REPORTED_ISSUES).join(', ');
  return described.length > MAX_REPORTED_ISSUES ? `${shown}, …(${described.length} total)` : shown;
}

/**
 * Throws unless `row` is exactly what the audit consumer will accept.
 *
 * Re-checks what `toSecurityEventOutboxRow` built, rather than trusting it:
 * the standard envelope, the name/version/topic constants, the v1 payload, the
 * `REFUSED` outcome, an occurrence count inside PostgreSQL `INTEGER`, exact
 * tenant agreement, and a Kafka key equal to the envelope's aggregate. A row that fails stays in the queue and is retried —
 * visible in the failure counter and the pending-age gauge — rather than
 * published into a dead-letter topic.
 */
export function assertPublishableAuditTrailRow(row: OutboxRow): void {
  if (row.topic !== AUDIT_TRAIL_TOPIC) {
    throw new AuditTrailContractError(`topic is not ${AUDIT_TRAIL_TOPIC}`);
  }
  if (row.eventName !== AUDIT_EVENT_RECORDED || row.eventVersion !== AUDIT_EVENT_RECORDED_VERSION) {
    throw new AuditTrailContractError(
      `row is not ${AUDIT_EVENT_RECORDED} v${AUDIT_EVENT_RECORDED_VERSION}`,
    );
  }

  const envelope = eventEnvelopeSchema.safeParse(row.payload);
  if (!envelope.success) {
    throw new AuditTrailContractError(`envelope ${describeIssues(envelope.error.issues)}`);
  }
  if (envelope.data.eventName !== AUDIT_EVENT_RECORDED) {
    throw new AuditTrailContractError(`eventName is not ${AUDIT_EVENT_RECORDED}`);
  }
  if (envelope.data.eventVersion !== AUDIT_EVENT_RECORDED_VERSION) {
    throw new AuditTrailContractError(`eventVersion is not ${AUDIT_EVENT_RECORDED_VERSION}`);
  }
  if (envelope.data.eventId !== row.id) {
    throw new AuditTrailContractError('eventId differs from the row id');
  }
  if (row.partitionKey !== envelope.data.aggregateId) {
    throw new AuditTrailContractError('partition key differs from aggregateId');
  }

  const payload = auditTrailPayloadSchemaV1.safeParse(envelope.data.payload);
  if (!payload.success) {
    throw new AuditTrailContractError(`payload ${describeIssues(payload.error.issues)}`);
  }
  if (payload.data.outcome !== REFUSAL_OUTCOME) {
    throw new AuditTrailContractError(`outcome is not ${REFUSAL_OUTCOME}`);
  }
  // The schema already demands a positive integer. The ceiling is the column
  // both ends store it in; a count above it could only be a producer defect.
  if (payload.data.occurrenceCount > MAX_OCCURRENCE_COUNT) {
    throw new AuditTrailContractError(
      `occurrenceCount exceeds the PostgreSQL INTEGER ceiling ${MAX_OCCURRENCE_COUNT}`,
    );
  }
  if (payload.data.correctionOf !== undefined || payload.data.changes !== undefined) {
    throw new AuditTrailContractError('a refusal carries no correction and no changes');
  }

  const tenantId = envelope.data.tenantId;
  const organizationId = payload.data.organizationId;
  if (tenantId !== organizationId) {
    throw new AuditTrailContractError(
      tenantId === undefined || organizationId === undefined
        ? 'tenant named on only one of envelope and payload'
        : 'payload organizationId differs from envelope tenantId',
    );
  }
  if (tenantId !== undefined && tenantId.trim().length === 0) {
    throw new AuditTrailContractError('blank tenant identifier');
  }
}
