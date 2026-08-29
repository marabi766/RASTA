import type { z } from 'zod';
import { MARKETPLACE_EVENT_SCHEMAS, type MarketplaceEventName } from './events';

/**
 * Where each marketplace event goes on the wire.
 *
 * The same shape ADR-036 established for the economic domain, and for the same
 * reason: **aggregate identity** (what the event is about) and **partition
 * ordering** (what it must stay in order with) are different questions, and
 * collapsing them into one field is what scattered a transaction's events
 * across four partitions.
 *
 * Here they agree for every order event and disagree for exactly one:
 * `REVIEW_SUBMITTED` is *about* a `Review` and is ordered by the **order**,
 * because a review is the last thing that happens to an order and a consumer
 * rebuilding that order should see it after the completion that permitted it.
 */

export type MarketplacePayload<N extends MarketplaceEventName> = z.infer<
  (typeof MARKETPLACE_EVENT_SCHEMAS)[N]
>;

/** The aggregate each event is *about*, typed against the event union. */
export const AGGREGATE_OF = {
  OFFER_PUBLISHED: 'Offer',
  ORDER_CREATED: 'Order',
  ORDER_CONFIRMED: 'Order',
  ORDER_FULFILLED: 'Order',
  ORDER_RECEIPT_CONFIRMED: 'Order',
  ORDER_COMPLETED: 'Order',
  ORDER_CANCELLED: 'Order',
  ORDER_DISPUTED: 'Order',
  REVIEW_SUBMITTED: 'Review',
} as const satisfies Record<MarketplaceEventName, string>;

export const PARTITION_SCOPES = {
  ORDER: 'ORDER',
  OFFER: 'OFFER',
} as const;

export type PartitionScope = (typeof PARTITION_SCOPES)[keyof typeof PARTITION_SCOPES];

export interface PartitionDecision {
  readonly scope: PartitionScope;
  readonly key: string;
}

type PartitionRule<N extends MarketplaceEventName> = (
  payload: MarketplacePayload<N>,
) => PartitionDecision;

/**
 * The one place a marketplace event's Kafka key is decided.
 *
 * A mapped type over the event union, so adding a name to
 * `MARKETPLACE_EVENTS` without deciding how it is ordered fails `pnpm
 * typecheck` rather than quietly inheriting the aggregate id.
 *
 * **Every order-lifecycle event uses `orderId`.** That is the invariant a
 * consumer of this stream depends on: a saga rebuilding one order must see
 * created → confirmed → fulfilled → receipt-confirmed → completed in that
 * order, and Kafka guarantees ordering within a partition and nowhere else.
 */
export const PARTITION_KEY_POLICY: { [N in MarketplaceEventName]: PartitionRule<N> } = {
  // ---- Order lifecycle: one partition per order ---------------------------
  ORDER_CREATED: (payload) => ({ scope: 'ORDER', key: payload.orderId }),
  ORDER_CONFIRMED: (payload) => ({ scope: 'ORDER', key: payload.orderId }),
  ORDER_FULFILLED: (payload) => ({ scope: 'ORDER', key: payload.orderId }),
  ORDER_RECEIPT_CONFIRMED: (payload) => ({ scope: 'ORDER', key: payload.orderId }),
  ORDER_COMPLETED: (payload) => ({ scope: 'ORDER', key: payload.orderId }),
  ORDER_CANCELLED: (payload) => ({ scope: 'ORDER', key: payload.orderId }),
  ORDER_DISPUTED: (payload) => ({ scope: 'ORDER', key: payload.orderId }),

  /**
   * Ordered by the order, not by the review.
   *
   * A review can only exist for a completed order, so it belongs to that
   * order's stream. Keying it by `reviewId` would put the last fact about an
   * order on a different partition from the rest of it — and a review has no
   * lifecycle of its own to be ordered against.
   */
  REVIEW_SUBMITTED: (payload) => ({ scope: 'ORDER', key: payload.orderId }),

  // ---- Catalogue ----------------------------------------------------------
  /**
   * Ordered by the offer, which is its own lifecycle.
   *
   * An offer is repriced repeatedly and a search index must apply those in
   * order; it has no relationship to any particular order.
   */
  OFFER_PUBLISHED: (payload) => ({ scope: 'OFFER', key: payload.offerId }),
};

/**
 * Decides the partition key for one already-validated payload.
 *
 * Refuses an empty key rather than passing it on: Kafka round-robins a message
 * with no key, which is exactly the loss of ordering this policy exists to
 * prevent — and it would happen silently.
 */
export function resolvePartitionKey<N extends MarketplaceEventName>(
  eventName: N,
  payload: MarketplacePayload<N>,
): PartitionDecision {
  // The lookup is exhaustive by construction; TypeScript cannot correlate the
  // generic parameter with the mapped type's value, hence the assertion.
  const rule = PARTITION_KEY_POLICY[eventName] as PartitionRule<N>;
  const decision = rule(payload);

  if (!decision.key) {
    throw new Error(
      `${eventName} resolved an empty ${decision.scope} partition key; ` +
        'publishing it would let Kafka round-robin the message and lose ordering',
    );
  }

  return decision;
}
