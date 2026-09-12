import { ulid } from 'ulid';
import { SENSITIVE_KEYS, REDACTED } from '@rasta/logging';
import type { EventEnvelope } from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';

/**
 * Turns a domain envelope into the row the audit store keeps.
 *
 * Path A of ADR-053 § 1: every envelope on the ten domain topics becomes one
 * `audit_event`, without asking any of the nine producing services to change.
 *
 * The mapper is deliberately total — there is no envelope it refuses. An audit
 * store that drops evidence because it did not recognise an event name is not
 * an audit store, so an unknown name is stored under its own name rather than
 * discarded (§ 12).
 */

/** The domain-projector consumer group. Also the `processed_event` key. */
export const DOMAIN_PROJECTOR_CONSUMER = 'audit-service.domain-projector';

/**
 * The ten topics AUD-001 subscribes to.
 *
 * Exactly the topics that are produced today. `procurement`, `inventory`,
 * `construction` and `contract` have no producer yet, and subscribing to a
 * topic nothing writes would make the consumer look broader than it is while
 * `allowAutoTopicCreation: false` refused to start. `rasta.audit.trail.v1` is
 * path B and belongs to AUD-004; consuming it here would mean this service
 * auditing its own writes.
 */
export const DOMAIN_TOPICS = [
  'rasta.identity.v1',
  'rasta.organization.v1',
  'rasta.asset.v1',
  'rasta.insurance.v1',
  'rasta.fleet.v1',
  'rasta.maintenance.v1',
  'rasta.marketplace.v1',
  'rasta.economic.v1',
  'rasta.document.v1',
  'rasta.supplier.v1',
] as const;

export type AuditActorType = 'USER' | 'SERVICE' | 'SYSTEM' | 'ANONYMOUS';
export type AuditOutcome = 'SUCCESS' | 'FAILURE' | 'REFUSED';

export interface AuditEventRecord {
  id: string;
  occurredAt: Date;
  actorType: AuditActorType;
  actorId: string | null;
  actorRoles: string[];
  organizationId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  outcome: AuditOutcome;
  occurrenceCount: number;
  sourceService: string;
  sourceServiceVersion: string | null;
  sourceEventId: string;
  sourceEventName: string;
  sourceTopic: string;
  correlationId: string;
  causationId: string | null;
  traceparent: string | null;
  sourceStreamSeq: bigint | null;
}

/**
 * Column bounds, mirrored from the migration.
 *
 * Truncation happens here rather than being left to PostgreSQL, which would
 * raise `22001 value too long` and turn one oversized field into a lost audit
 * record. Losing the tail of a user agent is a smaller harm than losing the
 * evidence that something happened.
 */
const LIMITS = {
  actorId: 256,
  organizationId: 128,
  action: 256,
  resourceType: 128,
  resourceId: 256,
  sourceService: 128,
  sourceServiceVersion: 64,
  sourceEventId: 128,
  sourceEventName: 128,
  sourceTopic: 256,
  correlationId: 128,
  causationId: 128,
  traceparent: 256,
} as const;

function bound(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function boundOptional(value: string | undefined | null, max: number): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  // The migration refuses a blank string in these columns: a blank actor id is
  // not an actor. Absent and blank mean the same thing, so both become null.
  return trimmed.length === 0 ? null : bound(trimmed, max);
}

/**
 * Event names ADR-053 gives a stable dotted action.
 *
 * Deliberately small. A dotted action is a *promise* that the verb will not
 * change, because queries and later access rules will be written against it,
 * and inventing one for an event the ADR does not name would be inventing a
 * contract nobody agreed to (AGENTS.md § 9). Every other name falls through to
 * itself, which is honest: the row says exactly what the producer called it.
 */
const ACTION_BY_EVENT_NAME: Readonly<Record<string, string>> = Object.freeze({});

/**
 * The lower-cased sensitive-key set, reused from `@rasta/logging`.
 *
 * The *same* list the platform's log redaction uses — not a second copy that
 * would drift. ADR-053 § 5 point 4 is explicit about this, and the failure it
 * prevents is a key being added to one list and forgotten in the other.
 */
const SENSITIVE = new Set<string>(SENSITIVE_KEYS.map((key) => key.toLowerCase()));

/** True when a field name is one the platform never stores in the clear. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE.has(key.toLowerCase());
}

/**
 * How AUD-001 represents a payload: it does not.
 *
 * ADR-053 § 5 allows only a bounded, redacted, structured delta in `changes`,
 * and path A cannot build one — a domain envelope carries the new state, not
 * before/after pairs. The honest options were a raw dump or nothing, and a raw
 * dump is the failure the ADR spends a section refusing: it would put bid
 * amounts, sealed payloads and national identifiers into the one table nobody
 * is allowed to delete from.
 *
 * So `changes` stays null in AUD-001 and the payload is never persisted. This
 * function exists for the diagnostics path only — it is what a log line or an
 * error may say about a payload — and it returns key names, never values.
 */
export function describePayloadKeys(payload: unknown): string {
  if (payload === null || payload === undefined) return '(none)';
  if (typeof payload !== 'object' || Array.isArray(payload)) return `(${typeof payload})`;

  const keys = Object.keys(payload as Record<string, unknown>);
  if (keys.length === 0) return '(empty)';

  // Names only, and sensitive names masked even so: a key called
  // `nationalIdHash` tells an observer the field exists, which is as much as a
  // diagnostic needs.
  const shown = keys
    .slice(0, 20)
    .map((key) => (isSensitiveKey(key) ? REDACTED : key))
    .join(',');

  return keys.length > 20 ? `${shown},…(${keys.length} keys)` : shown;
}

/**
 * Maps one envelope and its delivery into a record.
 *
 * `delivery.topic` rather than anything from the envelope, deliberately: the
 * envelope is producer-authored, so a producer could otherwise claim a topic it
 * never published to, and the topic is what tells a path-A row from a path-B
 * row for the rest of this store's life.
 */
export function toAuditEventRecord(
  envelope: EventEnvelope,
  delivery: EventDelivery,
): AuditEventRecord {
  // ADR § 5: actor is assigned explicitly, never left blank. An envelope with
  // an actor keeps it; one without is attributed to the producing service as
  // SYSTEM, so an insurance expiry sweep reads as
  // `SYSTEM / asset-service` rather than an unexplained gap. ANONYMOUS remains
  // for an envelope that names neither, which today's schema makes impossible
  // — `producer` is required — but the branch is here because the ADR defines
  // it and a future envelope version could relax that.
  const actorType: AuditActorType = envelope.actor ? envelope.actor.type : 'SYSTEM';
  const rawActorId = envelope.actor ? envelope.actor.id : envelope.producer;
  const actorId = boundOptional(rawActorId, LIMITS.actorId);

  return {
    id: ulid(),
    occurredAt: new Date(envelope.occurredAt),

    actorType: actorId === null && !envelope.actor ? 'ANONYMOUS' : actorType,
    actorId,
    // Path A never knows roles. An empty array, never null: null would mean
    // "unknown", and this is "known to be unavailable" (ADR § 5).
    actorRoles: [],

    organizationId: boundOptional(envelope.tenantId, LIMITS.organizationId),

    action: bound(ACTION_BY_EVENT_NAME[envelope.eventName] ?? envelope.eventName, LIMITS.action),
    resourceType: bound(envelope.aggregateType, LIMITS.resourceType),
    resourceId: boundOptional(envelope.aggregateId, LIMITS.resourceId),

    // A published domain event is a change that already happened. A refusal
    // never reaches a topic, which is precisely why path B exists.
    outcome: 'SUCCESS',
    occurrenceCount: 1,

    sourceService: bound(envelope.producer, LIMITS.sourceService),
    sourceServiceVersion: boundOptional(envelope.producerVersion, LIMITS.sourceServiceVersion),
    sourceEventId: bound(envelope.eventId, LIMITS.sourceEventId),
    sourceEventName: bound(envelope.eventName, LIMITS.sourceEventName),
    sourceTopic: bound(delivery.topic, LIMITS.sourceTopic),

    correlationId: bound(envelope.correlationId, LIMITS.correlationId),
    causationId: boundOptional(envelope.causationId, LIMITS.causationId),
    traceparent: boundOptional(envelope.traceparent, LIMITS.traceparent),

    // Stored for detection only (ADR § 8). Nothing blocks, buffers or reorders
    // on it, and an envelope without it is processed exactly the same way.
    sourceStreamSeq:
      envelope.streamSeq === undefined || envelope.streamSeq === null
        ? null
        : BigInt(envelope.streamSeq),
  };
}
