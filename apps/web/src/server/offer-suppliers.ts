import { organizationIdSchema } from '@rasta/contracts';

import { fetchSuppliers, type SupplierSummary } from './suppliers';
import type { WebSession } from './session';

/**
 * The directory entries for the organizations behind a page of offers
 * (task 305) — read through the existing `GET /v1/suppliers`, the only
 * supplier-service read a buyer's session may call: the standing snapshot is
 * service-to-service, and a supplier's private record answers 404 for another
 * organization.
 *
 * Asks the directory for exactly these organizations (FU-019: repeated
 * `organizationId`, at most {@link DIRECTORY_BATCH_SIZE} per call) instead of
 * walking it. Whatever it did not get — an id that is not a canonical
 * organization id (never sent: one would 400 its whole batch), a failed batch,
 * a batch whose pages did not end within the bound, an organization with no
 * profile — is simply absent from the map, and `offerSupplierStanding` renders
 * an absent supplier as unknown.
 */

/** The service's own per-call maximum (`supplier-service` dto.ts). */
export const DIRECTORY_BATCH_SIZE = 200;
/**
 * Pages followed within one batch. An organization has at most one profile, so
 * a batch fits one page of {@link DIRECTORY_BATCH_SIZE}; the second page is
 * only a margin, and a batch still "more" after it leaves the rest unknown.
 */
export const MAX_PAGES_PER_BATCH = 2;
/** Batches per page render: offers come one marketplace page at a time. */
export const MAX_BATCHES = 5;

export async function fetchOfferSuppliers(
  session: WebSession,
  organizationIds: readonly string[],
): Promise<ReadonlyMap<string, SupplierSummary>> {
  const wanted = [
    ...new Set(organizationIds.filter((id) => organizationIdSchema.safeParse(id).success)),
  ];
  const batches: string[][] = [];
  for (let i = 0; i < wanted.length && batches.length < MAX_BATCHES; i += DIRECTORY_BATCH_SIZE) {
    batches.push(wanted.slice(i, i + DIRECTORY_BATCH_SIZE));
  }

  const found = new Map<string, SupplierSummary>();
  const results = await Promise.all(batches.map((batch) => readBatch(session, batch)));
  for (const entries of results) {
    for (const supplier of entries) found.set(supplier.organizationId, supplier);
  }
  return found;
}

async function readBatch(
  session: WebSession,
  batch: readonly string[],
): Promise<SupplierSummary[]> {
  const asked = new Set(batch);
  const entries: SupplierSummary[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES_PER_BATCH; page += 1) {
    // An enrichment: any failure leaves the rest unknown, it never fails the offers page.
    const result = await fetchSuppliers(session, {
      limit: DIRECTORY_BATCH_SIZE,
      organizationIds: batch,
      cursor,
    }).catch(() => null);
    if (result?.kind !== 'OK') break;
    // Only what was asked for: an entry for another organization is not trusted.
    for (const supplier of result.data.items) {
      if (asked.has(supplier.organizationId)) entries.push(supplier);
    }
    if (!result.data.hasMore || result.data.nextCursor === null) break;
    cursor = result.data.nextCursor;
  }

  return entries;
}
