import type { ConstructionEventName } from './events';

/**
 * Where each construction event goes on the wire, and what it shares a stream with.
 *
 * `docs/07` § 7.7 and ADR-051 § C-7 keep two questions apart:
 * `aggregateType`/`aggregateId` say what an event is **about**; `partitionKey`
 * says which stream it belongs to — the stream ADR-051 will one day keep in
 * order, and which today is only co-partitioned (below).
 *
 * Here the two answers coincide. A need lives inside the project aggregate
 * (`docs/03` § 3.3: `Project` holds `ProjectNeed` and `Approval`), so every
 * event is about a `Project`, identified by `projectId`, and keyed by it. A
 * consumer reasoning about one project — audit rebuilding its timeline,
 * analytics counting its needs — finds its whole history on one partition.
 * The need's own id travels in the payload.
 *
 * ## What this key does not currently buy
 *
 * Co-partitioning, not ordering. Several relay replicas may publish separate
 * rows of one key concurrently; that is **D-027**, and it is open.
 */

export const AGGREGATE_TYPE = 'Project';

export const AGGREGATE_OF = {
  PROJECT_CREATED: AGGREGATE_TYPE,
  PROJECT_UPDATED: AGGREGATE_TYPE,
  PROJECT_STATUS_CHANGED: AGGREGATE_TYPE,
  PROJECT_NEED_ADDED: AGGREGATE_TYPE,
  PROJECT_NEED_UPDATED: AGGREGATE_TYPE,
  PROJECT_NEED_SUBMITTED: AGGREGATE_TYPE,
  PROJECT_NEED_WITHDRAWN: AGGREGATE_TYPE,
} as const satisfies Record<ConstructionEventName, string>;

export interface PartitionDecision {
  readonly key: string;
  readonly reason: string;
}

/**
 * The partition key, read off the validated payload rather than the call site,
 * so the key and what the consumer sees cannot disagree (the Q-26 failure).
 */
export function resolvePartitionKey(
  eventName: ConstructionEventName,
  payload: { projectId: string },
): PartitionDecision {
  return {
    key: payload.projectId,
    reason:
      `${eventName} is keyed by the project it concerns: needs live inside the ` +
      'project aggregate (docs/03 § 3.3, docs/07 § 7.7)',
  };
}
