import type { UnresolvedScope } from './unresolved-request';

/**
 * Which unresolved supplier write a request belongs to
 * (`server/unresolved-request.ts` keeps it).
 *
 * One slot per supplier — every command on that supplier's record shares it,
 * because a submission, a decision and a suspension each change what the others
 * may do — and one for the registration, which has no supplier yet. supplier-service
 * has no idempotency ledger, so no key can be sent again: the slot is released
 * only by the person saying they re-read the record (`reconcileSupplierWrite`).
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
