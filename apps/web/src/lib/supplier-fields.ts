/**
 * The supplier vocabulary the `/suppliers` screens render (docs/16 § ۱۶٫۶;
 * supplier-service `SUPPLIER_CAPABILITIES`, `SUPPLIER_STATUSES`,
 * `QUALIFICATION_STATES`).
 *
 * The portal does not enforce these on a response: a value it has no word for
 * renders as itself, visibly untranslated, rather than refusing the page
 * (`assets.ts` explains why). It does use them for the list filters, where
 * anything outside the vocabulary is dropped instead of being forwarded to
 * earn a 400.
 */

export const SUPPLIER_CAPABILITIES = ['GOODS_SUPPLY', 'WORKSHOP_SERVICE', 'CONTRACTING'] as const;

export type SupplierCapability = (typeof SUPPLIER_CAPABILITIES)[number];

export const SUPPLIER_CAPABILITY_LABELS: Readonly<Record<SupplierCapability, string>> = {
  GOODS_SUPPLY: 'تأمین کالا',
  WORKSHOP_SERVICE: 'خدمات تعمیرگاهی',
  CONTRACTING: 'پیمانکاری',
};

export function isSupplierCapability(value: string | undefined): value is SupplierCapability {
  return (SUPPLIER_CAPABILITIES as readonly string[]).includes(value ?? '');
}

export function supplierCapabilityLabel(capability: string): string {
  return isSupplierCapability(capability) ? SUPPLIER_CAPABILITY_LABELS[capability] : capability;
}

export const SUPPLIER_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;

export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

export const SUPPLIER_STATUS_LABELS: Readonly<Record<SupplierStatus, string>> = {
  ACTIVE: 'فعال',
  SUSPENDED: 'معلق',
};

export function isSupplierStatus(value: string | undefined): value is SupplierStatus {
  return (SUPPLIER_STATUSES as readonly string[]).includes(value ?? '');
}

export function supplierStatusLabel(status: string): string {
  return isSupplierStatus(status) ? SUPPLIER_STATUS_LABELS[status] : status;
}

export const QUALIFICATION_STATES = ['SUBMITTED', 'APPROVED', 'REJECTED'] as const;

export type QualificationState = (typeof QUALIFICATION_STATES)[number];

export const QUALIFICATION_STATE_LABELS: Readonly<Record<QualificationState, string>> = {
  SUBMITTED: 'ارسال‌شده',
  APPROVED: 'تأییدشده',
  REJECTED: 'ردشده',
};

export function isQualificationState(value: string | undefined): value is QualificationState {
  return (QUALIFICATION_STATES as readonly string[]).includes(value ?? '');
}

export function qualificationStateLabel(state: string): string {
  return isQualificationState(state) ? QUALIFICATION_STATE_LABELS[state] : state;
}
