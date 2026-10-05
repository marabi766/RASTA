import type { ContractEventName } from './events';

/**
 * Where each contract event goes on the wire, and what it shares a stream with.
 *
 * `docs/07` § 7.7 and ADR-051 § C-7 keep two questions apart:
 * `aggregateType`/`aggregateId` say what an event is **about**; `partitionKey`
 * says which stream it belongs to. For a contract the two coincide: every event
 * is about a `Contract`, identified by `contractId`, and keyed by it, so a consumer
 * reasoning about one contract finds its whole history on one partition.
 *
 * Co-partitioning, not ordering: several relay replicas may publish separate rows of
 * one key concurrently; that is D-027 and it is open.
 */

export const AGGREGATE_TYPE = 'Contract';

export const AGGREGATE_OF = {
  CONTRACT_DRAFTED: AGGREGATE_TYPE,
} as const satisfies Record<ContractEventName, string>;

export interface PartitionDecision {
  readonly key: string;
  readonly reason: string;
}

/**
 * The partition key, read off the validated payload rather than the call site,
 * so the key and what the consumer sees cannot disagree (the Q-26 failure).
 */
export function resolvePartitionKey(
  eventName: ContractEventName,
  payload: { contractId?: string },
): PartitionDecision {
  if (!payload.contractId) {
    throw new Error(`${eventName} carries no contractId to partition by`);
  }
  return {
    key: payload.contractId,
    reason:
      `${eventName} is keyed by the contract it concerns: the contract is its own ` +
      'aggregate and its lifecycle is one stream (docs/03 § 3.3, ADR-068)',
  };
}
