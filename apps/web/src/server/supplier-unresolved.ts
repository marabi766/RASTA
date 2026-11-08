import { ReleaseScope } from './release-scope';
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

/** What a supplier page's release acts on (`settleRelease`). */
export const supplierReleaseScope = (supplierId: string | null): ReleaseScope =>
  ReleaseScope.of(supplierWriteScope(supplierId));

/** The checkbox that releases a slot: the person re-read the record and checked. */
export const RECONCILED_FIELD = 'reconciled';
export const RECONCILED_VALUE = 'yes';
