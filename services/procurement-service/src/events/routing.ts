import type { ProcurementEventName } from './events';

/**
 * Where each procurement event goes on the wire, and what it shares a stream with.
 *
 * `docs/07` § 7.7 and ADR-051 § C-7 keep two questions apart: `aggregateType`/`aggregateId` say
 * what an event is **about**; `partitionKey` says which stream it belongs to. A demand's events are
 * about the demand, a window's about the aggregation — and both are keyed by `aggregationId`
 * (ADR-070 § 9), so a consumer reasoning about one window finds every demand that joined or left
 * it, and its end, on one partition.
 *
 * Co-partitioning, not ordering: several relay replicas may publish separate rows of one key
 * concurrently; that is D-027 and it is open.
 */

export const DEMAND_AGGREGATE_TYPE = 'DemandRequest';
export const AGGREGATION_AGGREGATE_TYPE = 'DemandAggregation';

export const AGGREGATE_OF = {
  DEMAND_SUBMITTED: DEMAND_AGGREGATE_TYPE,
  DEMAND_WITHDRAWN: DEMAND_AGGREGATE_TYPE,
  DEMAND_AGGREGATED: AGGREGATION_AGGREGATE_TYPE,
  AGGREGATION_WINDOW_EXTENDED: AGGREGATION_AGGREGATE_TYPE,
  AGGREGATION_REFERRED: AGGREGATION_AGGREGATE_TYPE,
  AGGREGATION_LAPSED: AGGREGATION_AGGREGATE_TYPE,
  AGGREGATION_CANCELLED: AGGREGATION_AGGREGATE_TYPE,
} as const satisfies Record<ProcurementEventName, string>;

export interface PartitionDecision {
  readonly key: string;
  readonly reason: string;
}

/**
 * The partition key, read off the validated payload rather than the call site, so the key and what
 * the consumer sees cannot disagree (the Q-26 failure).
 */
export function resolvePartitionKey(
  eventName: ProcurementEventName,
  payload: { aggregationId?: string },
): PartitionDecision {
  if (!payload.aggregationId) {
    throw new Error(`${eventName} carries no aggregationId to partition by`);
  }
  return {
    key: payload.aggregationId,
    reason:
      `${eventName} is keyed by the aggregation it concerns: a window and the demands that ` +
      'joined it are one stream (docs/07 § 7.7, ADR-070 § 9)',
  };
}
