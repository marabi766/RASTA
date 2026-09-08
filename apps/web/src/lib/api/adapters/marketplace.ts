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
