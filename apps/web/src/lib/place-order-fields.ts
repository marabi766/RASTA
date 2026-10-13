/**
 * The shape of the place-order form on `/marketplace/[productId]`: its field
 * names, the limits it mirrors, and a blank set of values.
 *
 * Separate from `server/place-order.ts` for the reason `order-fields.ts` gives:
 * that module reaches the gateway client and `node:crypto`, and the build
 * refuses a client component that imports it.
 *
 * ## What the form does not do
 *
 * It sends **no price**. marketplace-service prices an order from its own
 * current offers and refuses a body that carries one (`createOrderSchema` is
 * `.strict()`, ADR-037 § 5). The price a person saw in the table is therefore
 * indicative: the order is priced when it is placed, and the order page shows
 * what it was priced at.
 */

/** `createOrderSchema` — one line per order from this form; the cart is deferred (ADR-037 § 3). */
export const PLACE_ORDER_FIELDS = ['offerId', 'quantity', 'note'] as const;

export type PlaceOrderField = (typeof PLACE_ORDER_FIELDS)[number];
export type PlaceOrderFormValues = Readonly<Record<PlaceOrderField, string>>;

export const EMPTY_PLACE_ORDER_FORM: PlaceOrderFormValues = {
  offerId: '',
  quantity: '',
  note: '',
};

/** Copied from marketplace-service `createOrderSchema`; the service enforces them again. */
export const PLACE_ORDER_LIMITS = {
  quantity: { max: 1_000_000 },
  note: { max: 1000 },
} as const;
