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

export const PARTITION_SCOPES = { AGGREGATE: 'AGGREGATE' } as const;
export type PartitionScope = (typeof PARTITION_SCOPES)[keyof typeof PARTITION_SCOPES];

export interface PartitionDecision {
  readonly scope: PartitionScope;
  readonly key: string;
}

/**
 * Every event this service produces, and the scope that orders it.
 *
 * A `Record` over the event union, so adding a name to `IDENTITY_EVENTS` without
 * deciding how it is ordered fails `pnpm typecheck` rather than silently
 * inheriting a default.
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
} as const satisfies Record<IdentityEventName, PartitionScope>;

/**
 * Resolves the partition key for one event.
 *
 * Aggregate-scoped throughout, so the key is the aggregate id the caller
 * already supplies. It is resolved here rather than defaulted deep inside
 * `buildOutboxRow` so that one function decides the key, the stream and the
 * sequence together.
 */
export function resolvePartitionKey(
  eventName: IdentityEventName,
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
