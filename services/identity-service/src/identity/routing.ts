import { AUDIT_EVENT_RECORDED, AUDIT_TRAIL_TOPIC } from '@rasta/contracts';
import { IDENTITY_EVENTS, type IdentityEventName } from './events';

/**
 * Where each identity event goes on the wire.
 *
 * Introduced by ADR-051 Phase B3 for the same reason the economic, marketplace
 * and document services already have one: **the stream is
 * `topic + partitionKey` (§ C-7)**, so whatever decides the partition key also
 * decides what a sequence is allocated against. Leaving that decision implicit
 * — as a default applied inside `buildOutboxRow` — meant no single file said
 * what this service's streams are.
 *
 * **Nothing about the routing changes.** Every event here is *aggregate-scoped*
 * and always has been: the partition key is the aggregate id, which is exactly
 * what the `buildOutboxRow` default produced before this file existed. What is
 * new is that the policy is written down, exhaustive under the type checker,
 * and impossible for one call site to diverge from.
 *
 * A user, a membership, a role grant and a registration each have their own
 * lifecycle and no shared ordering requirement, so each is its own stream.
 *
 * This service's events are **DETECT** class under ADR-051 § D-1: a consumer
 * detects a gap or a stale event from the sequence, and nothing blocks the
 * queue on one. B3 allocates the sequence; enforcement is B4/B5 and is not
 * implemented.
 */

export const PARTITION_SCOPES = {
  AGGREGATE: 'AGGREGATE',
  /**
   * AUD-003 correction: an audit correction is ordered by the record it corrects. The key
   * is the target audit-event id (`correctionOf`), so every correction of one
   * record is one stream on the trail topic.
   */
  AUDIT_TARGET: 'AUDIT_TARGET',
} as const;
export type PartitionScope = (typeof PARTITION_SCOPES)[keyof typeof PARTITION_SCOPES];

export interface PartitionDecision {
  readonly scope: PartitionScope;
  readonly key: string;
}

/**
 * Everything this service puts on its standard outbox: its own domain events,
 * plus the one audit-trail event the correction command produces (AUD-003 correction).
 *
 * The correction is deliberately **not** an identity domain event: it is not in
 * `IDENTITY_EVENTS`, it has no identity payload schema, and it never goes to
 * `rasta.identity.v1`. It shares only the outbox, the relay and ADR-050's
 * fencing — which is exactly what ADR-053 § 7 asks of it.
 */
export type OutboundEventName = IdentityEventName | typeof AUDIT_EVENT_RECORDED;

/**
 * Every event this service produces, and the scope that orders it.
 *
 * A `Record` over the outbound union, so adding a name to `IDENTITY_EVENTS`
 * without deciding how it is ordered fails `pnpm typecheck` rather than
 * silently inheriting a default.
 */
export const PARTITION_SCOPE_OF = {
  USER_REGISTERED: 'AGGREGATE',
  USER_ACTIVATED: 'AGGREGATE',
  USER_UPDATED: 'AGGREGATE',
  USER_SUSPENDED: 'AGGREGATE',
  USER_DEACTIVATED: 'AGGREGATE',
  MEMBERSHIP_CREATED: 'AGGREGATE',
  MEMBERSHIP_REVOKED: 'AGGREGATE',
  ROLE_ASSIGNED: 'AGGREGATE',
  ROLE_REVOKED: 'AGGREGATE',
  REGISTRATION_SUBMITTED: 'AGGREGATE',
  REGISTRATION_APPROVED: 'AGGREGATE',
  REGISTRATION_REJECTED: 'AGGREGATE',
  [AUDIT_EVENT_RECORDED]: 'AUDIT_TARGET',
} as const satisfies Record<OutboundEventName, PartitionScope>;

/**
 * The topic each outbound event must be written to — checked, not defaulted.
 *
 * The audit-trail event goes to `rasta.audit.trail.v1` and nowhere else, and no
 * identity domain event may ever go there: the trail topic is audit evidence,
 * and a domain event on it would be dead-lettered by audit-service at best.
 */
export function assertTopicFor(eventName: OutboundEventName, topic: string): void {
  const isTrailEvent = eventName === AUDIT_EVENT_RECORDED;
  if (isTrailEvent !== (topic === AUDIT_TRAIL_TOPIC)) {
    throw new Error(
      `Identity routing: ${eventName} may not be written to topic "${topic}". ` +
        `Only ${AUDIT_EVENT_RECORDED} belongs on ${AUDIT_TRAIL_TOPIC}, and it belongs nowhere else.`,
    );
  }
}

/**
 * Resolves the partition key for one event.
 *
 * Aggregate-scoped throughout, so the key is the aggregate id the caller
 * already supplies. It is resolved here rather than defaulted deep inside
 * `buildOutboxRow` so that one function decides the key, the stream and the
 * sequence together.
 */
export function resolvePartitionKey(
  eventName: OutboundEventName,
  aggregateId: string,
): PartitionDecision {
  const scope = PARTITION_SCOPE_OF[eventName];
  if (!aggregateId) {
    throw new Error(
      `Identity routing: ${eventName} resolved to an empty partition key. ` +
        'An event without a stream cannot be ordered or sequenced.',
    );
  }
  return { scope, key: aggregateId };
}

/** Every event this service produces, for the exhaustiveness tests. */
export const PRODUCED_EVENTS = Object.values(IDENTITY_EVENTS);
