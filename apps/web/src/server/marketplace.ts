import { z } from 'zod';
import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import type { WebSession } from './session';
import type { ReadResult } from './assets';

/**
 * Reading the marketplace catalogue through the gateway (ADR-058 § 3, ADR-059
 * § 3).
 *
 * Read-only, matching `docs/16`'s page map for `PROCUREMENT_USER`: search and
 * compare, never list-your-own-offers or publish — those are `SUPPLIER`
 * actions this portal does not reach from here.
 *
 * `supplierQualification` is always `'UNAVAILABLE'` on the wire
 * (`services/marketplace-service/src/offer/dto.ts`): supplier-service does
 * not exist yet, so nothing has been checked. The schema keeps the value
 * rather than dropping it, precisely so a screen can say that plainly instead
 * of rendering a checkmark nobody earned.
 */

export const OFFER_SORTS = ['PRICE_ASC', 'PRICE_DESC', 'LEAD_TIME_ASC'] as const;

const offerSchema = z.object({
  id: z.string(),
  productId: z.string(),
  supplierOrganizationId: z.string(),
  unitPriceMinor: z.string(),
  currency: z.string(),
  availableQuantity: z.number().int(),
  leadTimeDays: z.number().int(),
  minimumQuantity: z.number().int(),
  supplierQualification: z.string(),
});

export type Offer = z.infer<typeof offerSchema>;

const productSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
  category: z.string(),
  kind: z.string(),
  unit: z.string(),
  // Sorted by the same `sort` the search query carried, so the first entry is
  // "the price this row leads with" without a second request.
  offers: z.array(offerSchema).default([]),
});

export type Product = z.infer<typeof productSchema>;

const productPageSchema = z.object({
  items: z.array(productSchema),
});

export type ProductPage = z.infer<typeof productPageSchema>;

const offersPageSchema = z.object({
  items: z.array(offerSchema),
});

export type OffersPage = z.infer<typeof offersPageSchema>;

// Re-exported so a screen needs one import for both this module's results and
// `assets.ts`'s — the shape is identical, and only one module should define it.
export type { ReadResult };

async function read<S extends z.ZodTypeAny>(
  session: WebSession,
  path: string,
  schema: S,
): Promise<ReadResult<z.infer<S>>> {
  try {
    const response = await callGateway<unknown>({
      baseUrl: webServerEnv().API_GATEWAY_URL,
      path,
      accessToken: session.accessToken,
    });

    const parsed = schema.safeParse(response.data);
    if (!parsed.success) return { kind: 'MALFORMED', correlationId: response.correlationId };
    return { kind: 'OK', data: parsed.data };
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      if (error.status === 403) return { kind: 'FORBIDDEN' };
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

export interface ProductSearchQuery {
  readonly q?: string;
  readonly category?: string;
  readonly sort?: (typeof OFFER_SORTS)[number];
}

export function searchProducts(
  session: WebSession,
  query: ProductSearchQuery = {},
): Promise<ReadResult<ProductPage>> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.category) params.set('category', query.category);
  if (query.sort) params.set('sort', query.sort);
  const search = params.toString();

  return read(session, `/v1/products${search ? `?${search}` : ''}`, productPageSchema);
}

export function fetchProduct(session: WebSession, productId: string): Promise<ReadResult<Product>> {
  // The id goes in a path segment, so it is encoded rather than interpolated,
  // matching every other domain read in this portal.
  return read(session, `/v1/products/${encodeURIComponent(productId)}`, productSchema);
}

export function fetchOffers(
  session: WebSession,
  productId: string,
  sort?: (typeof OFFER_SORTS)[number],
): Promise<ReadResult<OffersPage>> {
  const params = new URLSearchParams();
  if (sort) params.set('sort', sort);
  const search = params.toString();

  return read(
    session,
    `/v1/products/${encodeURIComponent(productId)}/offers${search ? `?${search}` : ''}`,
    offersPageSchema,
  );
}
