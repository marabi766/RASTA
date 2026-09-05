import {
  ASSET_EVENTS,
  INSURANCE_EVENTS,
  type AssetEventName,
  type InsuranceEventName,
} from './events';

/**
 * Where each asset-service event goes on the wire.
 *
 * Introduced by ADR-051 Phase B3 for the same reason the economic, marketplace
 * and document services already have one: **the stream is
 * `topic + partitionKey` (§ C-7)**, so whatever decides the partition key also
 * decides what a sequence is allocated against. Leaving that decision implicit
 * — as a default applied inside `buildOutboxRow` — meant no single file said
 * what this service's streams are.
 *
 * **Nothing about the routing changes.** Every event here is *aggregate-scoped*
 * and always has been: the partition key is the aggregate id, exactly what the
 * `buildOutboxRow` default produced before this file existed. What is new is
 * that the policy is written down, exhaustive under the type checker, and
 * impossible for one call site to diverge from.
 *
 * ## Two topics, two independent stream spaces
 *
 * This service publishes on `rasta.asset.v1` and `rasta.insurance.v1`. The
 * stream is the **pair**, so an asset id appearing on both topics is two
 * streams with two counters, and no ordering is claimed between them. That is
 * the same rule that keeps `rasta.fleet.v1` and `rasta.maintenance.v1`
 * independent for one machine, and it applies here inside a single database
 * just as much as it does across two.
 *
 * Both families are **DETECT** class under ADR-051 § D-1: a consumer detects a
 * gap or a stale event from the sequence, and nothing blocks the queue on one.
 * B3 allocates the sequence; enforcement is B4/B5 and is not implemented.
 */

export const PARTITION_SCOPES = { AGGREGATE: 'AGGREGATE' } as const;
export type PartitionScope = (typeof PARTITION_SCOPES)[keyof typeof PARTITION_SCOPES];

export interface PartitionDecision {
  readonly scope: PartitionScope;
  readonly key: string;
}

/** Every event this service produces, and the scope that orders it. */
export const PARTITION_SCOPE_OF = {
  // rasta.asset.v1 — one stream per machine
  ASSET_CREATED: 'AGGREGATE',
  ASSET_UPDATED: 'AGGREGATE',
  ASSET_ACTIVATED: 'AGGREGATE',
  ASSET_STATUS_CHANGED: 'AGGREGATE',
  ASSET_TRANSFERRED: 'AGGREGATE',
  ASSET_DECOMMISSIONED: 'AGGREGATE',
  ASSET_LOCATION_RECORDED: 'AGGREGATE',
  ASSET_DOCUMENT_ATTACHED: 'AGGREGATE',

  // rasta.insurance.v1 — one stream per policy or inspection
  INSURANCE_RECORDED: 'AGGREGATE',
  INSURANCE_EXPIRING: 'AGGREGATE',
  INSURANCE_EXPIRED: 'AGGREGATE',
  INSPECTION_RECORDED: 'AGGREGATE',
  INSPECTION_EXPIRING: 'AGGREGATE',
  INSPECTION_FAILED: 'AGGREGATE',
} as const satisfies Record<AssetEventName | InsuranceEventName, PartitionScope>;

/**
 * Resolves the partition key for one event.
 *
 * Aggregate-scoped throughout, so the key is the aggregate id the caller
 * already supplies. It is resolved here rather than defaulted deep inside
 * `buildOutboxRow` so that one function decides the key, the stream and the
 * sequence together.
 */
export function resolvePartitionKey(
  eventName: AssetEventName | InsuranceEventName,
  aggregateId: string,
): PartitionDecision {
  const scope = PARTITION_SCOPE_OF[eventName];
  if (!aggregateId) {
    throw new Error(
      `Asset routing: ${eventName} resolved to an empty partition key. ` +
        'An event without a stream cannot be ordered or sequenced.',
    );
  }
  return { scope, key: aggregateId };
}

/** Every event this service produces, for the exhaustiveness tests. */
export const PRODUCED_EVENTS = [...Object.values(ASSET_EVENTS), ...Object.values(INSURANCE_EVENTS)];
