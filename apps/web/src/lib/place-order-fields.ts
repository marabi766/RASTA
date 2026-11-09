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
 * It sends **no note**. marketplace-service accepts one but never stores it (no
 * column), so a field for it would promise the supplier something the platform
 * drops. It returns when the service keeps it.
 *
 * It sends **no price**. marketplace-service prices an order from its own
 * offers and refuses a body that carries one (`createOrderSchema` is
 * `.strict()`, ADR-037 § 5). What it sends instead is the **version** of the
 * offer the page drew (D-156): the service places the order only at that
 * version, so the price a person saw is the price charged, or nothing is
 * placed. The version is not a field anyone types: `offerStamp` is the signed
 * stamp the page drew for each offer (`server/offer-stamp.ts`), posted under
 * {@link offerStampField}, and the action reads the version out of it.
 */

import { toLatinDigits } from './format';

/** `createOrderSchema` — one line per order from this form; the cart is deferred (ADR-037 § 3). */
export const PLACE_ORDER_FIELDS = ['offerId', 'quantity', 'offerStamp'] as const;

export type PlaceOrderField = (typeof PLACE_ORDER_FIELDS)[number];
export type PlaceOrderFormValues = Readonly<Record<PlaceOrderField, string>>;

export const EMPTY_PLACE_ORDER_FORM: PlaceOrderFormValues = {
  offerId: '',
  quantity: '',
  offerStamp: '',
};

/** Where the stamp of offer `offerId` is posted: one per drawn offer, so the one sent is the chosen offer's. */
export function offerStampField(offerId: string): string {
  return `offerStamp:${offerId}`;
}

/**
 * The refusal of an order whose offer was repriced after the page drew it (D-156):
 * definite — nothing was placed — and answered by reading the offers again.
 */
export const OFFER_CHANGED_MESSAGE =
  'قیمت این پیشنهاد پس از باز شدن صفحه تغییر کرد و سفارشی ثبت نشد؛ پیشنهاد را دوباره ببینید.';

/** Copied from marketplace-service `createOrderSchema`; the service enforces them again. */
export const PLACE_ORDER_LIMITS = {
  quantity: { max: 1_000_000 },
  /** A stamp is under 300 characters; anything longer was not drawn here. */
  offerStamp: { max: 512 },
} as const;

/**
 * The quantity as the action validates and sends it — Latin digits, no leading
 * zeros — or null when it is not a count the action would accept.
 *
 * The one place the text becomes a number's text: `'٠٠٣'` and `'00000000000000003'`
 * are both the order for 3, and what is remembered for a retry (`unresolved-order.ts`)
 * is this, so the remembered order is the one that was sent.
 */
export function canonicalQuantity(value: string): string | null {
  const text = toLatinDigits(value).trim();
  if (!/^[0-9]+$/.test(text)) return null;
  const count = Number(text);
  if (!Number.isSafeInteger(count) || count < 1 || count > PLACE_ORDER_LIMITS.quantity.max) {
    return null;
  }
  return String(count);
}
