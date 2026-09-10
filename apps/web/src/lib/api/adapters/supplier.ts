import { z } from 'zod';
import type { AdapterDescriptor } from '../adapter';
import type { GatewayClient } from '../client';

/**
 * The supplier directory — Phase 1, and only Phase 1.
 *
 * `supplier-service` Phase 1 is merged on `main` (profiles, qualification,
 * suspension, directory). Phase 2 — performance scoring — has not started, and
 * `COM-005` is still `IN_PROGRESS` with no story points. So this is `BETA`: the
 * endpoints below are real and live, and the domain around them is not
 * finished.
 *
 * ## What this directory deliberately cannot tell you
 *
 * There is **no score, no star rating and no `sort=RATING`** — not hidden, not
 * disabled, absent. The service has no scoring engine and its own contract
 * says why: no search index is deployed and no performance score exists (Q-12).
 *
 * `qualifiedFor` is also narrower than it looks and the difference matters. A
 * *claimed* capability is a supplier saying what it does. A *qualified* one is
 * an approval recorded by a named operator at a stated time — and even that
 * "does not assert that any evidence document was fetched, opened, scanned or
 * found authentic, current or legally valid", because this service does not
 * read documents. The UI says both things.
 *
 * The directory read is cross-tenant by design: a buyer in one organization
 * finding a workshop in another is the whole point (docs/04 § 4.10). The public
 * projection carries catalogue-safe fields only — no evidence document ids, no
 * decision notes, no actor identifiers, no suspension reasons.
 *
 * Shapes read from `services/supplier-service/src/supplier/views.ts` and `dto.ts`.
 */

export const SUPPLIER_ADAPTER = {
  id: 'supplier.directory',
  service: 'supplier-service',
  routes: ['GET /v1/suppliers'],
} as const satisfies AdapterDescriptor;

export const SUPPLIER_CAPABILITIES = ['GOODS_SUPPLY', 'WORKSHOP_SERVICE', 'CONTRACTING'] as const;
export type SupplierCapability = (typeof SUPPLIER_CAPABILITIES)[number];

export const CAPABILITY_LABELS: Record<string, string> = {
  GOODS_SUPPLY: 'تأمین کالا',
  WORKSHOP_SERVICE: 'خدمات تعمیرگاهی',
  CONTRACTING: 'پیمانکاری',
};

export const SUPPLIER_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;

export const SUPPLIER_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'فعال',
  SUSPENDED: 'تعلیق‌شده',
};

/**
 * The public projection.
 *
 * Its field list is asserted key-by-key in the service's own `views.spec.ts`,
 * so a new column cannot reach the directory by being picked up in a spread.
 * This schema mirrors that list exactly.
 */
export const supplierDirectorySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  displayName: z.string(),
  status: z.string(),
  /** What the supplier says it does. Claiming is not qualification. */
  capabilities: z.array(z.string()),
  /** Approved and not suspended, right now. */
  qualifiedFor: z.array(z.string()),
  registeredAt: z.string(),
});

export type SupplierDirectoryEntry = z.infer<typeof supplierDirectorySchema>;

export interface SupplierQuery {
  readonly capability?: SupplierCapability;
  readonly qualifiedFor?: SupplierCapability;
  readonly status?: (typeof SUPPLIER_STATUSES)[number];
}

export async function searchSuppliers(
  client: GatewayClient,
  query: SupplierQuery = {},
  signal?: AbortSignal,
): Promise<SupplierDirectoryEntry[]> {
  const result = await client.request({
    path: '/v1/suppliers',
    schema: z.object({
      items: z.array(supplierDirectorySchema),
      nextCursor: z.string().nullable(),
      hasMore: z.boolean(),
    }),
    signal,
    query: {
      capability: query.capability,
      qualifiedFor: query.qualifiedFor,
      // `qualifiedFor` already implies ACTIVE; the service answers 400 if both
      // are sent with `status=SUSPENDED`, rather than letting one filter
      // silently overwrite the other.
      status: query.qualifiedFor ? undefined : query.status,
      limit: 50,
    },
  });

  return result.data.items;
}
