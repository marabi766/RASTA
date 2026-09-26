import type { ConstructionEventName } from './events';

/**
 * Where each construction event goes on the wire, and what it is ordered by.
 *
 * `docs/07` § 7.7 and ADR-051 § C-7 keep two questions apart:
 * `aggregateType`/`aggregateId` say what an event is **about**; `partitionKey`
 * says what it must stay **in order with**.
 *
 * For every project event the two answers coincide. A need, an approval and a
 * progress report live inside the project aggregate
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
export const POLICY_AGGREGATE_TYPE = 'ApprovalPolicy';

export const AGGREGATE_OF = {
  PROJECT_CREATED: AGGREGATE_TYPE,
  PROJECT_UPDATED: AGGREGATE_TYPE,
  PROJECT_STATUS_CHANGED: AGGREGATE_TYPE,
  PROJECT_NEED_ADDED: AGGREGATE_TYPE,
  PROJECT_NEED_UPDATED: AGGREGATE_TYPE,
  PROJECT_NEED_SUBMITTED: AGGREGATE_TYPE,
  PROJECT_NEED_WITHDRAWN: AGGREGATE_TYPE,
  APPROVAL_REQUESTED: AGGREGATE_TYPE,
  APPROVAL_GRANTED: AGGREGATE_TYPE,
  APPROVAL_REJECTED: AGGREGATE_TYPE,
  PROJECT_STARTED: AGGREGATE_TYPE,
  PROJECT_PROGRESS_UPDATED: AGGREGATE_TYPE,
  PROJECT_COMPLETED: AGGREGATE_TYPE,
  PROJECT_PROGRESS_REPORT_DRAFTED: AGGREGATE_TYPE,
  PROJECT_PROGRESS_REPORT_DISCARDED: AGGREGATE_TYPE,
  APPROVAL_POLICY_CREATED: POLICY_AGGREGATE_TYPE,
  APPROVAL_POLICY_ACTIVATED: POLICY_AGGREGATE_TYPE,
  APPROVAL_POLICY_RETIRED: POLICY_AGGREGATE_TYPE,
} as const satisfies Record<ConstructionEventName, string>;

const POLICY_EVENTS: readonly ConstructionEventName[] = [
  'APPROVAL_POLICY_CREATED',
  'APPROVAL_POLICY_ACTIVATED',
  'APPROVAL_POLICY_RETIRED',
];

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
  payload: { projectId?: string; organizationId?: string; workflowKey?: string },
): PartitionDecision {
  if (POLICY_EVENTS.includes(eventName)) {
    // A policy's events are ordered with the other versions of the same
    // (organization, workflow key): activating version 2 retires version 1,
    // and a consumer reconstructing "which policy is in force" must see both
    // on one partition. Keyed by that pair rather than by the policy id.
    return {
      key: `${payload.organizationId}/${payload.workflowKey}`,
      reason:
        `${eventName} is keyed by (organization, workflow key): every version of one ` +
        'policy line stays on one partition (docs/07 § 7.7)',
    };
  }
  if (!payload.projectId) {
    throw new Error(`${eventName} carries no projectId to partition by`);
  }
  return {
    key: payload.projectId,
    reason:
      `${eventName} is keyed by the project it concerns: needs live inside the ` +
      'project aggregate (docs/03 § 3.3, docs/07 § 7.7)',
  };
}
