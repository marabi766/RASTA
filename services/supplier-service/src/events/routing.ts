import type { SupplierEventName } from './events';

/**
 * Where each supplier event goes on the wire, and what it is ordered by.
 *
 * ## Two questions, not one
 *
 * `docs/07` § 7.7 and ADR-051 § C-7 insist on the distinction and this file is
 * where it is kept: `aggregateType`/`aggregateId` say what the event is
 * **about**; `partitionKey` says what it must stay **in order with**. They are
 * not the same question and they do not have the same answer here.
 *
 * `SUPPLIER_QUALIFIED` is about a `Qualification`. `SUPPLIER_SUSPENDED` is about
 * a `Suspension`. Both are keyed by `supplierId`, which is neither aggregate's
 * id. That is a deliberate deviation from the default (`partitionKey =
 * aggregateId`), of the same shape ADR-036 made for `transactionId` in the
 * economic domain and `orderId` in marketplace, and it is documented here
 * because § 7.7 requires every deviation to be explicit.
 *
 * ## Why `supplierId` is the stream
 *
 * Every consumer of this topic reasons about **one counterparty**.
 * `marketplace-service` hides a supplier's offers on `SUPPLIER_SUSPENDED` and
 * would show them on the strength of a qualification; `procurement-service`
 * decides whom to invite to an RFQ; `construction-service` decides who may bid.
 * All three ask "what is true about this supplier now", and reconstructing that
 * from events spread across partitions is not possible — Kafka orders within a
 * partition and nowhere else.
 *
 * Keyed by `qualificationId` instead, a supplier's approval and its later
 * suspension could land on different partitions, and a consumer could apply the
 * approval after the suspension and un-hide an offer that should stay hidden.
 * Keyed by `organizationId` the result would be identical in practice — one
 * profile per organization — but it would tie the stream to an identifier this
 * service does not own, so a future organization merge would silently rewrite
 * the stream identity.
 *
 * ## What this key does not currently buy
 *
 * Co-partitioning, not ordering. Several relay replicas may publish separate
 * rows of one key concurrently, and backoff, a live lease or a manual DLQ
 * replay can move a later event ahead of an earlier one. That is **D-027**, it
 * is open, and ADR-051's fix is accepted but only B1/B2 are merged. Read the
 * key as "these land on one partition", not as "these arrive in order".
 */

export const AGGREGATE_OF = {
  SUPPLIER_REGISTERED: 'Supplier',
  SUPPLIER_QUALIFIED: 'Qualification',
  SUPPLIER_REJECTED: 'Qualification',
  SUPPLIER_SUSPENDED: 'Suspension',
} as const satisfies Record<SupplierEventName, string>;

export interface PartitionDecision {
  readonly key: string;
  readonly reason: string;
}

/**
 * The partition key for an event, derived from the validated payload.
 *
 * Read off the payload rather than taken from the call site, so the key and
 * what the consumer sees cannot disagree — the failure Q-26 recorded in the
 * economic domain, where a service passed one identifier and published another.
 */
export function resolvePartitionKey(
  eventName: SupplierEventName,
  payload: { supplierId: string },
): PartitionDecision {
  return {
    key: payload.supplierId,
    reason:
      `${eventName} is co-partitioned by the supplier it concerns, because every ` +
      'consumer of this topic reasons about one counterparty (docs/07 § 7.7)',
  };
}
