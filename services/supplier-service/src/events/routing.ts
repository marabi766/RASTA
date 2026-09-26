import {
  PERFORMANCE_FORMULA_EVENTS,
  type PerformanceFormulaEventName,
  type PublishedEventName,
  type SupplierEventName,
} from './events';

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
  SUPPLIER_REINSTATED: 'Suspension',
  PERFORMANCE_FORMULA_VERSION_CREATED: 'PerformanceFormulaVersion',
  PERFORMANCE_FORMULA_VERSION_ACTIVATED: 'PerformanceFormulaVersion',
  PERFORMANCE_FORMULA_VERSION_RETIRED: 'PerformanceFormulaVersion',
} as const satisfies Record<PublishedEventName, string>;

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
 *
 * ## The formula events are the one documented exception to `supplierId`
 *
 * A formula version is about no supplier — it is platform-wide configuration
 * (docs/24 Q-75). Its events are keyed by the version's own id (PM ruling on
 * ADR-052 step 2), which is also its aggregate id: the default of `docs/07`
 * § 7.7, not a deviation from it. An activation therefore puts the new
 * version's CREATED and ACTIVATED on one key and the predecessor's RETIRED on
 * another; the two carry each other's id, so no consumer needs them ordered.
 */
export function resolvePartitionKey(
  eventName: SupplierEventName,
  payload: { supplierId: string },
): PartitionDecision;
export function resolvePartitionKey(
  eventName: PerformanceFormulaEventName,
  payload: { formulaVersionId: string },
): PartitionDecision;
export function resolvePartitionKey(
  eventName: PublishedEventName,
  payload: { supplierId: string } | { formulaVersionId: string },
): PartitionDecision;
export function resolvePartitionKey(
  eventName: PublishedEventName,
  payload: { supplierId: string } | { formulaVersionId: string },
): PartitionDecision {
  if (isFormulaEvent(eventName)) {
    if (!('formulaVersionId' in payload)) {
      throw new Error(`${eventName} must name the formula version it concerns`);
    }
    return {
      key: payload.formulaVersionId,
      reason:
        `${eventName} concerns platform-wide configuration, not a supplier, and is ` +
        'keyed by the formula version it announces (ADR-052 step 2)',
    };
  }
  if (!('supplierId' in payload)) {
    throw new Error(`${eventName} must name the supplier it concerns`);
  }
  return {
    key: payload.supplierId,
    reason:
      `${eventName} is co-partitioned by the supplier it concerns, because every ` +
      'consumer of this topic reasons about one counterparty (docs/07 § 7.7)',
  };
}

export function isFormulaEvent(
  eventName: PublishedEventName,
): eventName is PerformanceFormulaEventName {
  return (Object.values(PERFORMANCE_FORMULA_EVENTS) as string[]).includes(eventName);
}
