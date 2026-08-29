import { z } from 'zod';

/**
 * Events published by marketplace-service, on `rasta.marketplace.v1`.
 *
 * The names come from the platform catalogue (`docs/events/README.md` §
 * Marketplace and `docs/04` § 4.8). The **payloads do not** — the catalogue
 * has key-field sketches only, and ADR-032 recorded why nobody else could fill
 * them in: defining another service's event contract is inventing a fact you
 * do not own. This service owns them, so this file is where they become real.
 *
 * Every field below is derived from a column that exists on the aggregate that
 * publishes it. Nothing is here "for the future".
 *
 * ## Money
 *
 * Amounts are **strings in minor units** beside an explicit `currency`, never
 * JSON numbers: a rial figure past `Number.MAX_SAFE_INTEGER` does not survive
 * a JSON round trip (ADR-022). Same flat shape as economic-service and
 * maintenance-service already publish.
 *
 * ## What these payloads never carry
 *
 * No personal data, no prices a consumer could use as authority, no wallet or
 * account identifiers. An event lives seven days in a log every service reads
 * (`docs/07` § 7.3). A consumer that needs detail reads it back through the
 * API, under authorization.
 *
 * ## Version
 *
 * `eventVersion` is **1** for all nine. They are new contracts, not changes to
 * an existing one, so there is nothing to be compatible with yet — and
 * starting anywhere but 1 would imply a v0 that consumers might look for.
 */

export const MARKETPLACE_EVENTS = {
  OFFER_PUBLISHED: 'OFFER_PUBLISHED',
  ORDER_CREATED: 'ORDER_CREATED',
  ORDER_CONFIRMED: 'ORDER_CONFIRMED',
  ORDER_FULFILLED: 'ORDER_FULFILLED',
  ORDER_RECEIPT_CONFIRMED: 'ORDER_RECEIPT_CONFIRMED',
  ORDER_COMPLETED: 'ORDER_COMPLETED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  ORDER_DISPUTED: 'ORDER_DISPUTED',
  REVIEW_SUBMITTED: 'REVIEW_SUBMITTED',
} as const;

export type MarketplaceEventName = (typeof MARKETPLACE_EVENTS)[keyof typeof MARKETPLACE_EVENTS];

/** A non-negative integer amount in minor units, as a string (ADR-022). */
const amountMinor = z.string().regex(/^\d{1,30}$/);
const currency = z.string().min(3).max(8);
const isoTimestamp = z.string();

// ---------------------------------------------------------------------------
// Offer
// ---------------------------------------------------------------------------

/**
 * A supplier's offer became visible in the catalogue.
 *
 * Carries `version` because a search index built from this stream has to know
 * which repricing it is looking at — that is the migration path ADR-042 keeps
 * open for OpenSearch.
 */
export const offerPublishedPayload = z.object({
  offerId: z.string(),
  productId: z.string(),
  supplierOrganizationId: z.string(),
  unitPriceMinor: amountMinor,
  currency,
  availableQuantity: z.number().int().nonnegative(),
  leadTimeDays: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  publishedAt: isoTimestamp,
});

// ---------------------------------------------------------------------------
// Order lifecycle
// ---------------------------------------------------------------------------

/**
 * An order was placed and its lines are fixed.
 *
 * `lines[]` carries the **server-side** prices the order was actually created
 * with (ADR-037 § 5), so an analytics consumer never has to ask what was paid.
 * It does not carry a wallet id or a transaction id: at publication time the
 * obligation has not been created yet, and naming one would be a guess.
 */
export const orderCreatedPayload = z.object({
  orderId: z.string(),
  buyerOrganizationId: z.string(),
  supplierOrganizationId: z.string(),
  totalAmountMinor: amountMinor,
  currency,
  lines: z
    .array(
      z.object({
        offerId: z.string(),
        productId: z.string(),
        quantity: z.number().int().positive(),
        unitPriceMinor: amountMinor,
        lineTotalMinor: amountMinor,
        /** Which repricing of the offer this line agreed to. */
        offerVersion: z.number().int().positive(),
      }),
    )
    .min(1),
  createdAt: isoTimestamp,
});

/** The supplier accepted the order. */
export const orderConfirmedPayload = z.object({
  orderId: z.string(),
  buyerOrganizationId: z.string(),
  supplierOrganizationId: z.string(),
  confirmedAt: isoTimestamp,
});

/**
 * The supplier recorded delivery.
 *
 * The order is now waiting for the buyer, and `receiptDueAt` says until when
 * before it is counted overdue. **Nothing expires into a settlement** — the
 * window only decides when a reminder is recorded (ADR-043).
 */
export const orderFulfilledPayload = z.object({
  orderId: z.string(),
  fulfillmentId: z.string(),
  buyerOrganizationId: z.string(),
  supplierOrganizationId: z.string(),
  trackingReference: z.string().nullable(),
  fulfilledAt: isoTimestamp,
  receiptDueAt: isoTimestamp,
});

/**
 * The buyer confirmed receipt — the only fact that permits settlement.
 *
 * The catalogue sketch had `orderId, confirmedBy` and nothing else, and
 * ADR-032 named that as the reason economic-service could not consume it:
 * a consumer would have to already know what to settle. It carries the amount
 * now. That is not so economic-service can settle from it — it settles by
 * command (ADR-040) — but so that any consumer reading this stream can tell
 * what was released without a second call.
 */
export const orderReceiptConfirmedPayload = z.object({
  orderId: z.string(),
  buyerOrganizationId: z.string(),
  supplierOrganizationId: z.string(),
  totalAmountMinor: amountMinor,
  currency,
  confirmedBy: z.string(),
  confirmedAt: isoTimestamp,
});

/**
 * Settlement completed and the order is closed.
 *
 * `netAmountMinor` and `commissionAmountMinor` are **echoed from
 * economic-service's settlement response**, not computed here. This service
 * does not know a commission rate and must not appear to (ADR-040 § 6).
 */
export const orderCompletedPayload = z.object({
  orderId: z.string(),
  buyerOrganizationId: z.string(),
  supplierOrganizationId: z.string(),
  totalAmountMinor: amountMinor,
  commissionAmountMinor: amountMinor,
  netAmountMinor: amountMinor,
  currency,
  settlementId: z.string(),
  completedAt: isoTimestamp,
});

/**
 * The order was cancelled and its financial compensation is done.
 *
 * Published **after** the refund succeeds, not when cancellation is requested:
 * a consumer that reacted to the request would be reacting to something that
 * might still fail.
 */
export const orderCancelledPayload = z.object({
  orderId: z.string(),
  buyerOrganizationId: z.string(),
  supplierOrganizationId: z.string(),
  totalAmountMinor: amountMinor,
  currency,
  reason: z.string(),
  cancelledBy: z.string(),
  cancelledAt: isoTimestamp,
});

/**
 * A dispute was raised and settlement is stopped.
 *
 * `reason` is buyer-supplied free text with a minimum length, mirroring
 * economic-service's dispute contract: whoever resolves it needs to know what
 * it is about.
 */
export const orderDisputedPayload = z.object({
  orderId: z.string(),
  disputeId: z.string(),
  buyerOrganizationId: z.string(),
  supplierOrganizationId: z.string(),
  reason: z.string(),
  raisedBy: z.string(),
  raisedAt: isoTimestamp,
});

/**
 * A buyer reviewed a completed order.
 *
 * `rating` only, with an optional comment. There is no computed score here:
 * supplier performance scoring belongs to supplier-service, which does not
 * exist, and a rating average produced here would be a second authority for a
 * number that service will own (ADR-041).
 */
export const reviewSubmittedPayload = z.object({
  reviewId: z.string(),
  orderId: z.string(),
  buyerOrganizationId: z.string(),
  supplierOrganizationId: z.string(),
  rating: z.number().int().min(1).max(5),
  submittedAt: isoTimestamp,
});

export const MARKETPLACE_EVENT_SCHEMAS = {
  [MARKETPLACE_EVENTS.OFFER_PUBLISHED]: offerPublishedPayload,
  [MARKETPLACE_EVENTS.ORDER_CREATED]: orderCreatedPayload,
  [MARKETPLACE_EVENTS.ORDER_CONFIRMED]: orderConfirmedPayload,
  [MARKETPLACE_EVENTS.ORDER_FULFILLED]: orderFulfilledPayload,
  [MARKETPLACE_EVENTS.ORDER_RECEIPT_CONFIRMED]: orderReceiptConfirmedPayload,
  [MARKETPLACE_EVENTS.ORDER_COMPLETED]: orderCompletedPayload,
  [MARKETPLACE_EVENTS.ORDER_CANCELLED]: orderCancelledPayload,
  [MARKETPLACE_EVENTS.ORDER_DISPUTED]: orderDisputedPayload,
  [MARKETPLACE_EVENTS.REVIEW_SUBMITTED]: reviewSubmittedPayload,
} as const satisfies Record<MarketplaceEventName, z.ZodTypeAny>;

/**
 * Validates before the payload reaches the outbox (`docs/07` § 7.8).
 *
 * Returns the parsed payload typed to its own event, so the partition-key
 * policy that reads a field off it afterwards is checked against that event's
 * schema rather than against `unknown` (the shape ADR-036 established).
 */
export function validateMarketplacePayload<N extends MarketplaceEventName>(
  eventName: N,
  payload: unknown,
): z.infer<(typeof MARKETPLACE_EVENT_SCHEMAS)[N]> {
  // The schema is selected by the same key as the return type; TypeScript
  // cannot correlate the two through a generic parameter, hence the assertion.
  return MARKETPLACE_EVENT_SCHEMAS[eventName].parse(payload) as z.infer<
    (typeof MARKETPLACE_EVENT_SCHEMAS)[N]
  >;
}
