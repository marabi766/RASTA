import type { UnresolvedScope } from './unresolved-request';

/**
 * Which unresolved supplier write a request belongs to
 * (`server/unresolved-request.ts` keeps it, on the server, from before the send).
 *
 * One slot per supplier — every command on that supplier's record shares it,
 * because a submission, a decision and a suspension each change what the others
 * may do — and one for the registration, which has no supplier yet.
 */
export const SUPPLIER_WRITE_PURPOSE = 'supplier-write';

/** The slot of a registration, or of the commands on `supplierId`. */
export function supplierWriteScope(supplierId: string | null): UnresolvedScope {
  return {
    purpose: SUPPLIER_WRITE_PURPOSE,
    target: supplierId === null ? 'register' : `supplier:${supplierId}`,
  };
}

/** The checkbox that releases a slot: the person re-read the record and checked. */
export const RECONCILED_FIELD = 'reconciled';
export const RECONCILED_VALUE = 'yes';
/** The hidden field that names the held record the confirmation was drawn for (a signed token). */
export const RELEASE_FIELD = 'release';
/** The query parameter a refused reconciliation comes back with (`STALE`, `IN_PROGRESS`, `UNAVAILABLE`). */
export const RELEASE_PARAM = 'release';
