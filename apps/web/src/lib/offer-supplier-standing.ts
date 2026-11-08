import { ownText } from '@/lib/own-key';
import type { SupplierSummary } from '@/server/suppliers';

/**
 * What a buyer comparing offers is told about the supplier behind one: its
 * name and whether it is qualified (task 305).
 *
 * The answer comes only from the supplier directory (`GET /v1/suppliers`). It
 * is fail-closed: a supplier the directory did not return, or a status this
 * portal has no word for, is `UNKNOWN` — never `QUALIFIED` by default.
 *
 * "Qualified" is the capability the marketplace sells under — an ACTIVE
 * supplier holding a current `GOODS_SUPPLY` approval, the same test an RFQ
 * invitation applies (procurement-service `supplier-standing.client.ts`).
 */

export const OFFER_SUPPLIER_CAPABILITY = 'GOODS_SUPPLY';

export type OfferSupplierState = 'QUALIFIED' | 'NOT_QUALIFIED' | 'SUSPENDED' | 'UNKNOWN';

export interface OfferSupplierStanding {
  /** The directory's display name; null when there is none to show (never an id). */
  readonly name: string | null;
  readonly state: OfferSupplierState;
}

export const OFFER_SUPPLIER_STATE_LABELS: Readonly<Record<OfferSupplierState, string>> = {
  QUALIFIED: 'واجد صلاحیت',
  NOT_QUALIFIED: 'فاقد صلاحیت',
  SUSPENDED: 'معلق',
  UNKNOWN: 'وضعیت نامشخص',
};

export const OFFER_SUPPLIER_NAME_UNKNOWN = 'نام تأمین‌کننده در دسترس نیست';

export function offerSupplierStateLabel(state: OfferSupplierState): string {
  // Fail closed: a state this portal has no word for reads as UNKNOWN, never as a prototype member.
  return ownText(OFFER_SUPPLIER_STATE_LABELS, state) ?? OFFER_SUPPLIER_STATE_LABELS.UNKNOWN;
}

/** `supplier` is undefined when the directory read failed or did not list the organization. */
export function offerSupplierStanding(
  supplierOrganizationId: string,
  supplier: SupplierSummary | undefined,
): OfferSupplierStanding {
  if (!supplier || supplier.organizationId !== supplierOrganizationId) {
    return { name: null, state: 'UNKNOWN' };
  }
  const trimmed = supplier.displayName.trim();
  // A display name that is only an identifier tells the buyer nothing a name should.
  const name =
    trimmed === '' || trimmed === supplier.organizationId || trimmed === supplier.id
      ? null
      : trimmed;
  if (supplier.status === 'SUSPENDED') return { name, state: 'SUSPENDED' };
  if (supplier.status !== 'ACTIVE') return { name, state: 'UNKNOWN' };
  return {
    name,
    state: supplier.qualifiedFor.includes(OFFER_SUPPLIER_CAPABILITY)
      ? 'QUALIFIED'
      : 'NOT_QUALIFIED',
  };
}
