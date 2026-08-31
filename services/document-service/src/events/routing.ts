import type { DocumentEventName } from './events';

/**
 * Where each document event goes on the wire.
 *
 * ADR-036's distinction applies here too — aggregate identity and partition
 * ordering are different questions — but in this domain they happen to agree
 * for all three events, and the reason is worth writing down rather than
 * leaving as a coincidence.
 *
 * Everything this service publishes is *about* one document and must stay in
 * order with the other events about that same document: an `UPLOADED` and the
 * `DELETED` that follows it, or an `UPLOADED` and the `SCANNED` that resolves
 * it. A consumer that saw the deletion before the upload would hold a
 * reference to a document it believes still exists; one that saw `SCANNED`
 * before `UPLOADED` would learn a verdict about a document it has never heard
 * of. Keying by `documentId` puts all of them on one partition, which is the
 * only place Kafka guarantees order.
 *
 * That ordering became load-bearing with ADR-049. Scanning is asynchronous, so
 * `DOCUMENT_UPLOADED` now always carries `PENDING` and the outcome arrives
 * later as its own fact — a sequence that is only meaningful if it stays a
 * sequence.
 *
 * Keying by organization instead would be the tempting alternative and is
 * wrong: it would order every document in a tenant against every other,
 * which buys nothing and makes one busy tenant a single partition's problem.
 */

export const AGGREGATE_OF = {
  DOCUMENT_UPLOADED: 'Document',
  DOCUMENT_SCANNED: 'Document',
  DOCUMENT_DELETED: 'Document',
  VIRUS_DETECTED: 'Document',
} as const satisfies Record<DocumentEventName, string>;

export interface PartitionDecision {
  readonly key: string;
  readonly reason: string;
}

/**
 * The partition key for an event, derived from the validated payload.
 *
 * Read off the payload rather than taken from the call site, so the key and
 * what the consumer sees cannot disagree — the failure Q-26 recorded in the
 * economic domain.
 */
export function resolvePartitionKey(
  eventName: DocumentEventName,
  payload: { documentId: string },
): PartitionDecision {
  return {
    key: payload.documentId,
    reason: `${eventName} is ordered by the document it concerns`,
  };
}
