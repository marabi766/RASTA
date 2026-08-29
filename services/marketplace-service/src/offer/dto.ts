import { z } from 'zod';
import { amountMinorSchema, currencySchema } from '@rasta/contracts';

/**
 * Catalogue request and response shapes.
 *
 * `sort` deliberately has no `RATING`. Supplier performance scoring belongs to
 * supplier-service, which does not exist; accepting the value and ordering by
 * something else would tell a client its ordering had been applied when it had
 * not (ADR-042 § 2, ADR-041).
 */

export const createProductSchema = z
  .object({
    sku: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    category: z.string().trim().min(1).max(100),
    kind: z.enum(['GOOD', 'SERVICE']).default('GOOD'),
    /** Free text from the defining organization: "عدد", "لیتر", "ساعت". */
    unit: z.string().trim().min(1).max(32),
  })
  .strict();

export type CreateProductDto = z.infer<typeof createProductSchema>;

export const createOfferSchema = z
  .object({
    productId: z.string().trim().min(1).max(64),
    /** Minor units as a string, never a JSON number (ADR-022). */
    unitPriceMinor: amountMinorSchema,
    currency: currencySchema.default('IRR'),
    /**
     * What the supplier says it can supply.
     *
     * **Not** warehouse stock. inventory-service owns that and does not exist;
     * this number is the supplier's own declaration and the API says so
     * (ADR-041 § 2).
     */
    availableQuantity: z.number().int().min(0).max(10_000_000),
    leadTimeDays: z.number().int().min(0).max(365),
    minimumQuantity: z.number().int().min(1).max(10_000_000).default(1),
    /** Publish immediately, or leave as a draft the supplier can review. */
    publish: z.boolean().default(false),
  })
  .strict();

export type CreateOfferDto = z.infer<typeof createOfferSchema>;

export const updateOfferSchema = z
  .object({
    unitPriceMinor: amountMinorSchema.optional(),
    availableQuantity: z.number().int().min(0).max(10_000_000).optional(),
    leadTimeDays: z.number().int().min(0).max(365).optional(),
    status: z.enum(['DRAFT', 'PUBLISHED', 'SUSPENDED', 'WITHDRAWN']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must change',
  });

export type UpdateOfferPriceDto = z.infer<typeof updateOfferSchema>;

export const searchProductsQuerySchema = z
  .object({
    /** Free text, matched against the trigram index (ADR-042). */
    q: z.string().trim().min(1).max(200).optional(),
    category: z.string().trim().min(1).max(100).optional(),
    sort: z.enum(['PRICE_ASC', 'PRICE_DESC', 'LEAD_TIME_ASC']).default('PRICE_ASC'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type SearchProductsQuery = z.infer<typeof searchProductsQuerySchema>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface OfferView {
  id: string;
  productId: string;
  supplierOrganizationId: string;
  unitPriceMinor: string;
  currency: string;
  availableQuantity: number;
  leadTimeDays: number;
  minimumQuantity: number;
  status: string;
  version: number;
  /**
   * Whether the supplier's qualification could be established (ADR-041).
   *
   * Always `UNAVAILABLE` until supplier-service exists — never `false`. A
   * `false` would say the check ran and the supplier failed it, and a UI
   * rendering "unverified" on that basis would be reporting something nobody
   * checked.
   */
  supplierQualification: 'UNAVAILABLE';
}

export interface ProductView {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  category: string;
  kind: string;
  unit: string;
  status: string;
  offers?: OfferView[];
}
