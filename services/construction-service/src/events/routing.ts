import type { ConstructionEventName } from './events';

/**
 * Where each construction event goes on the wire, and what it shares a stream with.
 *
 * `docs/07` § 7.7 and ADR-051 § C-7 keep two questions apart:
 * `aggregateType`/`aggregateId` say what an event is **about**; `partitionKey`
 * says which stream it belongs to — the stream ADR-051 will one day keep in
 * order, and which today is only co-partitioned (below).
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
/** A tender is its own aggregate (`docs/03` § 3.3, ADR-065), keyed by `tenderId`. */
export const TENDER_AGGREGATE_TYPE = 'Tender';
/** A criteria template is its own small aggregate, keyed by `{organizationId}/{templateId}`. */
export const TEMPLATE_AGGREGATE_TYPE = 'CriteriaTemplate';

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
  APPROVAL_POLICY_SUSPENDED: POLICY_AGGREGATE_TYPE,
  APPROVAL_POLICY_SUBMITTED: POLICY_AGGREGATE_TYPE,
  APPROVAL_POLICY_REJECTED: POLICY_AGGREGATE_TYPE,
  TENDER_CREATED: TENDER_AGGREGATE_TYPE,
  TENDER_UPDATED: TENDER_AGGREGATE_TYPE,
  TENDER_CANCELLED: TENDER_AGGREGATE_TYPE,
  TENDER_CRITERIA_SET: TENDER_AGGREGATE_TYPE,
  TENDER_PUBLISHED: TENDER_AGGREGATE_TYPE,
  TENDER_BIDDER_INVITED: TENDER_AGGREGATE_TYPE,
  BID_SUBMITTED: TENDER_AGGREGATE_TYPE,
  BID_REVISED: TENDER_AGGREGATE_TYPE,
  BID_WITHDRAWN: TENDER_AGGREGATE_TYPE,
  BID_ACCESSED: TENDER_AGGREGATE_TYPE,
  TENDER_CLOSED: TENDER_AGGREGATE_TYPE,
  BIDS_OPENED: TENDER_AGGREGATE_TYPE,
  BID_OPENING_PROPOSAL_WITHDRAWN: TENDER_AGGREGATE_TYPE,
  BID_OPENING_CONFLICT_DETECTED: TENDER_AGGREGATE_TYPE,
  BID_QUALIFIED: TENDER_AGGREGATE_TYPE,
  BID_DISQUALIFIED: TENDER_AGGREGATE_TYPE,
  BID_SCORED: TENDER_AGGREGATE_TYPE,
  BID_EVALUATOR_RECUSED: TENDER_AGGREGATE_TYPE,
  BIDS_EVALUATED: TENDER_AGGREGATE_TYPE,
  TENDER_AWARDED: TENDER_AGGREGATE_TYPE,
  BID_NOT_AWARDED: TENDER_AGGREGATE_TYPE,
  CRITERIA_TEMPLATE_CREATED: TEMPLATE_AGGREGATE_TYPE,
} as const satisfies Record<ConstructionEventName, string>;

const POLICY_EVENTS: readonly ConstructionEventName[] = [
  'APPROVAL_POLICY_CREATED',
  'APPROVAL_POLICY_ACTIVATED',
  'APPROVAL_POLICY_RETIRED',
  'APPROVAL_POLICY_SUSPENDED',
  'APPROVAL_POLICY_SUBMITTED',
  'APPROVAL_POLICY_REJECTED',
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
  payload: {
    projectId?: string;
    tenderId?: string;
    /** Null on `TENDER_CRITERIA_SET` written out rather than copied; only a template event keys by it. */
    templateId?: string | null;
    organizationId?: string;
    workflowKey?: string;
  },
): PartitionDecision {
  if (AGGREGATE_OF[eventName] === TEMPLATE_AGGREGATE_TYPE) {
    if (!payload.templateId || !payload.organizationId) {
      throw new Error(`${eventName} carries no templateId to partition by`);
    }
    return {
      key: `${payload.organizationId}/${payload.templateId}`,
      reason:
        `${eventName} is keyed by (organization, template): a template is immutable and ` +
        'belongs to no tender (docs/07 § 7.7)',
    };
  }
  if (AGGREGATE_OF[eventName] === TENDER_AGGREGATE_TYPE) {
    // A tender's whole lifecycle — and, in later steps, its bids and its
    // evaluation — is one ordered stream (`docs/07` § 7.4, ADR-065 § 5).
    if (!payload.tenderId) {
      throw new Error(`${eventName} carries no tenderId to partition by`);
    }
    return {
      key: payload.tenderId,
      reason:
        `${eventName} is keyed by the tender it concerns: the tender is its own ` +
        'aggregate and its lifecycle is one stream (docs/03 § 3.3, ADR-065)',
    };
  }
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
