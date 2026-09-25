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
 *
 * ## The one event that is not about a document
 *
 * `UPLOAD_INTENT_ISSUED` (L7-14) is published before any document exists, so
 * there is no `documentId` to key it by. It is keyed by its own intent: the
 * intent is its aggregate, and nothing else is published about that intent
 * that it would have to stay in order with.
 */

export const AGGREGATE_OF = {
  DOCUMENT_UPLOADED: 'Document',
  DOCUMENT_SCANNED: 'Document',
  DOCUMENT_DELETED: 'Document',
  VIRUS_DETECTED: 'Document',
  UPLOAD_INTENT_ISSUED: 'UploadIntent',
} as const satisfies Record<DocumentEventName, string>;

/** The payload field each event is ordered by. */
const PARTITION_FIELD_OF = {
  DOCUMENT_UPLOADED: 'documentId',
  DOCUMENT_SCANNED: 'documentId',
  DOCUMENT_DELETED: 'documentId',
  VIRUS_DETECTED: 'documentId',
  UPLOAD_INTENT_ISSUED: 'uploadIntentId',
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
  payload: Readonly<Record<string, unknown>>,
): PartitionDecision {
  const field = PARTITION_FIELD_OF[eventName];
  const key = payload[field];
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `Document routing: ${eventName} resolved to an empty partition key (${field}). ` +
        'An event without a stream cannot be ordered or sequenced.',
    );
  }
  return {
    key,
    reason:
      field === 'documentId'
        ? `${eventName} is ordered by the document it concerns`
        : `${eventName} is ordered by the upload intent it concerns`,
  };
}
