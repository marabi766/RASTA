import { fetchSuppliers, type SupplierSummary } from './suppliers';
import type { WebSession } from './session';

/**
 * The directory entries for the organizations behind a page of offers
 * (task 305) — read through the existing `GET /v1/suppliers`, the only
 * supplier-service read a buyer's session may call: the standing snapshot is
 * service-to-service, and a supplier's private record answers 404 for another
 * organization.
 *
 * The directory has no per-organization filter, so this walks it, at most
 * `MAX_DIRECTORY_PAGES` pages, and stops as soon as every wanted organization
 * was found. Whatever it did not find — a failed page, a directory longer than
 * the walk, an organization with no profile — is simply absent from the map,
 * and `offerSupplierStanding` renders an absent supplier as unknown.
 */

export const DIRECTORY_PAGE_SIZE = 200;
export const MAX_DIRECTORY_PAGES = 5;

export async function fetchOfferSuppliers(
  session: WebSession,
  organizationIds: readonly string[],
): Promise<ReadonlyMap<string, SupplierSummary>> {
  const wanted = new Set(organizationIds);
  const found = new Map<string, SupplierSummary>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_DIRECTORY_PAGES && found.size < wanted.size; page += 1) {
    // An enrichment: any failure leaves the rest unknown, it never fails the offers page.
    const result = await fetchSuppliers(session, { limit: DIRECTORY_PAGE_SIZE, cursor }).catch(
      () => null,
    );
    if (result?.kind !== 'OK') break;
    for (const supplier of result.data.items) {
      if (wanted.has(supplier.organizationId)) found.set(supplier.organizationId, supplier);
    }
    if (!result.data.hasMore || result.data.nextCursor === null) break;
    cursor = result.data.nextCursor;
  }

  return found;
}
