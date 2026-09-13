import { ulid } from 'ulid';
import { SENSITIVE_KEYS, REDACTED } from '@rasta/logging';
import type { AuditChange, EventEnvelope } from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import { AUDIT_DOMAIN_TOPIC_OWNERS, type AuditDomainTopic } from './audit-producer-topology';

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
 * path B and is consumed separately, under its own group, by
 * `AuditTrailConsumer` (AUD-004 Phase B): subscribing to it here would put two
 * opposite validation contracts behind one handler and one idempotency
 * namespace.
 *
 * Derived from `AUDIT_DOMAIN_TOPIC_OWNERS`, which names each topic together
 * with the service that owns it: the subscription and the metric label set
 * cannot disagree about which topics exist.
 */
export const DOMAIN_TOPICS: readonly AuditDomainTopic[] = Object.freeze(
  AUDIT_DOMAIN_TOPIC_OWNERS.map((entry) => entry.topic),
);

/**
 * The dead-letter topic both audit consumers share.
 *
 * audit's own rather than each producer's: a message that failed *this*
 * service's validation is this service's problem to replay, and routing it back
 * to `rasta.asset.v1.dlq` would put it in front of a team that has nothing to
 * fix. The original topic rides along in the `x-dlq-original-topic` header, so a
 * path-A copy and a path-B copy stay distinguishable. The topic is created by
 * `create-topics.sh` and by both CI topic lists, which matters: a dead-letter
 * write to a topic that does not exist stalls the partition.
 */
export const AUDIT_DEAD_LETTER_TOPIC = 'rasta.audit.v1.dlq';

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

  // Path B only (AUD-004 Phase B, `audit-trail.mapper.ts`). A path-A record
  // never carries these keys — a domain envelope has nothing to put in them,
  // and leaving them off keeps "there is nowhere for a payload to go" a
  // structural fact of path A rather than a convention. The repository writes
  // an absent key as SQL NULL, and the record hash already covers all six
  // (`CANONICAL_FIELDS`), so a path-A row hashes exactly as it did before.

  errorCode?: string | null;
  reason?: string | null;
  /** Bounded, marker-redacted delta already validated against the v1 contract. */
  changes?: AuditChange[] | null;
  sourceIp?: string | null;
  sourceUserAgent?: string | null;
  /** The `AuditEvent.id` a correction points at. Never an update of that row. */
  correctionOf?: string | null;
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

/** The columns a record takes from its envelope and delivery, on either path. */
export type AuditEnvelopeProvenance = Pick<
  AuditEventRecord,
  | 'id'
  | 'occurredAt'
  | 'sourceService'
  | 'sourceServiceVersion'
  | 'sourceEventId'
  | 'sourceEventName'
  | 'sourceTopic'
  | 'correlationId'
  | 'causationId'
  | 'traceparent'
  | 'sourceStreamSeq'
>;

/**
 * The envelope-derived half of a record — identical whichever path it came by.
 *
 * Shared by `toAuditEventRecord` below and by path B's `toAuditTrailRecord`, so
 * the two paths cannot drift on what `occurredAt`, the source event, the topic
 * or the causal chain means.
 *
 * `delivery.topic` rather than anything from the envelope, deliberately: the
 * envelope is producer-authored, so a producer could otherwise claim a topic it
 * never published to, and the topic is what tells a path-A row from a path-B
 * row for the rest of this store's life.
 */
export function toEnvelopeProvenance(
  envelope: EventEnvelope,
  delivery: EventDelivery,
): AuditEnvelopeProvenance {
  return {
    id: ulid(),
    occurredAt: new Date(envelope.occurredAt),

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

/** Maps one envelope and its delivery into a record. */
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
    ...toEnvelopeProvenance(envelope, delivery),

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
  };
}
