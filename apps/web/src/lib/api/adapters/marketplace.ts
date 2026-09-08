import { z } from 'zod';
import { amountMinorSchema, currencySchema } from '@rasta/contracts';
import type { AdapterDescriptor } from '../adapter';
import type { ApiClient } from '../client';

/**
 * Catalogue reads from `marketplace-service`, through the gateway.
 *
 * Every shape below was read from
 * `services/marketplace-service/src/offer/dto.ts` at the branch baseline, not
 * from the design prototype. Two of them carry a rule the UI must not soften:
 *
 *  - `unitPriceMinor` is a **string** of integer minor units (ADR-022). It is
 *    parsed by `amountMinorSchema` from `@rasta/contracts` — the same schema
 *    the service validates with — and it stays a string all the way to the
 *    DOM. `Number('12000000000')` is fine; `Number('9007199254740993')` is
 *    not, and a rial figure reaches that range.
 *  - `supplierQualification` is the literal `'UNAVAILABLE'`, never a boolean.
 *    `supplier-service` phase 2 has not started, so nothing has checked a
 *    supplier's qualification; a `false` would report a verdict nobody reached
 *    (ADR-041 § 1).
 */

export const MARKETPLACE_CATALOGUE_ADAPTER = {
  id: 'marketplace.catalogue',
  service: 'marketplace-service',
  routes: ['GET /v1/products', 'GET /v1/products/{id}/offers'],
} as const satisfies AdapterDescriptor;

/** Mirrors `OfferView`. */
export const offerViewSchema = z.object({
  id: z.string(),
  productId: z.string(),
  supplierOrganizationId: z.string(),
  unitPriceMinor: amountMinorSchema,
  currency: currencySchema,
  availableQuantity: z.number().int(),
  leadTimeDays: z.number().int(),
  minimumQuantity: z.number().int(),
  status: z.string(),
  version: z.number().int(),
  supplierQualification: z.literal('UNAVAILABLE'),
});

export type OfferView = z.infer<typeof offerViewSchema>;

/** Mirrors `ProductView`. */
export const productViewSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  category: z.string(),
  kind: z.string(),
  unit: z.string(),
  status: z.string(),
  offers: z.array(offerViewSchema).optional(),
});

export type ProductView = z.infer<typeof productViewSchema>;

const searchResponseSchema = z.object({ items: z.array(productViewSchema) });
const offersResponseSchema = z.object({ items: z.array(offerViewSchema) });

/**
 * The three sort values the service accepts.
 *
 * `RATING` is deliberately absent upstream and stays absent here. Offering it
 * and ordering by price would tell the buyer their ordering had been applied
 * when it had not (ADR-042 § 2).
 */
export const SORT_OPTIONS = ['PRICE_ASC', 'PRICE_DESC', 'LEAD_TIME_ASC'] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];

export const SORT_LABELS: Record<SortOption, string> = {
  PRICE_ASC: 'ارزان‌ترین',
  PRICE_DESC: 'گران‌ترین',
  LEAD_TIME_ASC: 'سریع‌ترین تحویل اعلامی',
};

export interface CatalogueQuery {
  /** Free text, matched on a trigram index. Omitted when empty. */
  readonly q?: string;
  readonly category?: string;
  readonly sort?: SortOption;
  /** Server maximum is 100. */
  readonly limit?: number;
}

export async function searchProducts(
  client: ApiClient,
  query: CatalogueQuery,
  signal?: AbortSignal,
): Promise<ProductView[]> {
  const result = await client.request({
    path: '/v1/products',
    schema: searchResponseSchema,
    signal,
    query: {
      q: query.q?.trim() || undefined,
      category: query.category?.trim() || undefined,
      sort: query.sort ?? 'PRICE_ASC',
      limit: query.limit ?? 25,
    },
  });

  return result.data.items;
}

export async function offersForProduct(
  client: ApiClient,
  productId: string,
  sort: SortOption = 'PRICE_ASC',
  signal?: AbortSignal,
): Promise<OfferView[]> {
  const result = await client.request({
    path: `/v1/products/${encodeURIComponent(productId)}/offers`,
    schema: offersResponseSchema,
    signal,
    query: { sort },
  });

  return result.data.items;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * The order lifecycle.
 *
 * Read-only in this milestone. Placing an order is a write with a financial
 * effect behind it — it holds funds through `economic-service` — and an
 * investor preview has no business creating obligations on a shared dataset.
 *
 * `ORDER_TRANSITIONS` is copied from `order/state-machine.ts` so the stepper
 * renders the real graph rather than a drawing of it. Two absent edges carry
 * the whole safety model and the UI says so:
 *
 *  - `DISPUTED` has **no** edge to `SETTLING`. A dispute stopping settlement is
 *    a missing edge, not a check somebody has to remember.
 *  - `COMPLETED`, `CANCELLED` and `FAILED` have no outgoing edges at all, so a
 *    replayed command on a finished order cannot produce a second financial
 *    effect.
 */
export const MARKETPLACE_ORDERS_ADAPTER = {
  id: 'marketplace.orders',
  service: 'marketplace-service',
  routes: ['GET /v1/orders', 'GET /v1/orders/{id}'],
} as const satisfies AdapterDescriptor;

export const ORDER_STATUSES = [
  'PENDING',
  'FUNDS_HELD',
  'CONFIRMED',
  'AWAITING_RECEIPT_CONFIRMATION',
  'RECEIPT_CONFIRMED',
  'SETTLING',
  'COMPLETED',
  'DISPUTED',
  'CANCELLING',
  'CANCELLED',
  'FAILED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: 'در انتظار',
  FUNDS_HELD: 'وجه نگه‌داشته شد',
  CONFIRMED: 'تأیید تأمین‌کننده',
  AWAITING_RECEIPT_CONFIRMATION: 'در انتظار تأیید دریافت',
  RECEIPT_CONFIRMED: 'دریافت تأیید شد',
  SETTLING: 'در حال تسویه',
  COMPLETED: 'تکمیل‌شده',
  DISPUTED: 'در اعتراض',
  CANCELLING: 'در حال لغو',
  CANCELLED: 'لغوشده',
  FAILED: 'ناموفق',
};

/** The happy path, in order. Used to draw the stepper. */
export const ORDER_HAPPY_PATH: readonly OrderStatus[] = [
  'PENDING',
  'FUNDS_HELD',
  'CONFIRMED',
  'AWAITING_RECEIPT_CONFIRMATION',
  'RECEIPT_CONFIRMED',
  'SETTLING',
  'COMPLETED',
];

/** Verbatim from `order/state-machine.ts`. */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PENDING: ['FUNDS_HELD', 'FAILED', 'CANCELLING'],
  FUNDS_HELD: ['CONFIRMED', 'CANCELLING', 'DISPUTED'],
  CONFIRMED: ['AWAITING_RECEIPT_CONFIRMATION', 'CANCELLING', 'DISPUTED'],
  AWAITING_RECEIPT_CONFIRMATION: ['RECEIPT_CONFIRMED', 'CANCELLING', 'DISPUTED'],
  RECEIPT_CONFIRMED: ['SETTLING', 'DISPUTED'],
  SETTLING: ['COMPLETED', 'RECEIPT_CONFIRMED'],
  DISPUTED: ['RECEIPT_CONFIRMED', 'CANCELLING'],
  CANCELLING: ['CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
};

export const orderLineSchema = z.object({
  offerId: z.string(),
  productId: z.string(),
  productName: z.string(),
  quantity: z.number().int(),
  unitPriceMinor: amountMinorSchema,
  lineTotalMinor: amountMinorSchema,
  currency: currencySchema,
  offerVersion: z.number().int(),
});

export const orderViewSchema = z.object({
  id: z.string(),
  status: z.string(),
  buyerOrganizationId: z.string(),
  supplierOrganizationId: z.string(),
  totalAmountMinor: amountMinorSchema,
  currency: currencySchema,
  lines: z.array(orderLineSchema),
  economicTransactionId: z.string().nullable(),
  economicSettlementId: z.string().nullable(),
  supplierQualification: z.literal('UNAVAILABLE'),
  reminderCount: z.number().int(),
  lastReminderAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  fulfilledAt: z.string().nullable(),
  receiptConfirmedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  placedBy: z.string(),
});

export type OrderView = z.infer<typeof orderViewSchema>;

export type OrderSide = 'BUYER' | 'SUPPLIER';

/**
 * `role` is explicit rather than inferred from the caller's roles.
 *
 * An organization can be both a buyer and a supplier, and guessing which list
 * was meant would silently return the wrong one.
 */
export async function listOrders(
  client: ApiClient,
  role: OrderSide = 'BUYER',
  signal?: AbortSignal,
): Promise<OrderView[]> {
  const result = await client.request({
    // `GET /v1/orders` returns `{ items, nextCursor }` — no `hasMore`.
    path: '/v1/orders',
    schema: z.object({
      items: z.array(orderViewSchema),
      nextCursor: z.string().nullable(),
    }),
    signal,
    query: { role, limit: 50 },
  });

  return result.data.items;
}

export async function fetchOrder(
  client: ApiClient,
  orderId: string,
  signal?: AbortSignal,
): Promise<OrderView> {
  const result = await client.request({
    path: `/v1/orders/${encodeURIComponent(orderId)}`,
    schema: orderViewSchema,
    signal,
  });

  return result.data;
}
