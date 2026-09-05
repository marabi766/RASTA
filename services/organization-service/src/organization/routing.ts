import { ORGANIZATION_EVENTS, type OrganizationEventName } from './events';

/**
 * Where each organization event goes on the wire.
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
 * One organization's own lifecycle is one stream: a consumer rebuilding an
 * organization must see created -> moved -> status-changed in order, and Kafka
 * guarantees order within a partition and nowhere else.
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
 * A `Record` over the event union, so adding a name to `ORGANIZATION_EVENTS` without
 * deciding how it is ordered fails `pnpm typecheck` rather than silently
 * inheriting a default.
 */
export const PARTITION_SCOPE_OF = {
  ORGANIZATION_CREATED: 'AGGREGATE',
  ORGANIZATION_UPDATED: 'AGGREGATE',
  ORGANIZATION_MOVED: 'AGGREGATE',
  ORGANIZATION_STATUS_CHANGED: 'AGGREGATE',
  ORGANIZATION_POLICY_CHANGED: 'AGGREGATE',
  ORGANIZATION_LOCATION_CHANGED: 'AGGREGATE',
} as const satisfies Record<OrganizationEventName, PartitionScope>;

/**
 * Resolves the partition key for one event.
 *
 * Aggregate-scoped throughout, so the key is the aggregate id the caller
 * already supplies. It is resolved here rather than defaulted deep inside
 * `buildOutboxRow` so that one function decides the key, the stream and the
 * sequence together.
 */
export function resolvePartitionKey(
  eventName: OrganizationEventName,
  aggregateId: string,
): PartitionDecision {
  const scope = PARTITION_SCOPE_OF[eventName];
  if (!aggregateId) {
    throw new Error(
      `Organization routing: ${eventName} resolved to an empty partition key. ` +
        'An event without a stream cannot be ordered or sequenced.',
    );
  }
  return { scope, key: aggregateId };
}

/** Every event this service produces, for the exhaustiveness tests. */
export const PRODUCED_EVENTS = Object.values(ORGANIZATION_EVENTS);
