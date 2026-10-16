import { toPersianDigits } from './format';

/**
 * The contract vocabulary the `/contracts` screens render (docs/16 § ۱۶٫۶;
 * contract-service `CONTRACT_STATES` / `AMENDMENT_STATES`, ADR-068).
 *
 * The portal does not enforce this on a response: a status it has no word for
 * renders as itself, visibly untranslated, rather than refusing the page
 * (`assets.ts` explains why).
 */

export const CONTRACT_STATES = ['DRAFT', 'SIGNED', 'COMPLETED', 'SETTLED', 'CANCELLED'] as const;

export type ContractStatus = (typeof CONTRACT_STATES)[number];

export const CONTRACT_STATE_LABELS: Readonly<Record<ContractStatus, string>> = {
  DRAFT: 'پیش‌نویس',
  SIGNED: 'امضاشده',
  COMPLETED: 'تکمیل‌شده',
  SETTLED: 'تسویه‌شده',
  CANCELLED: 'لغوشده',
};

export function isContractStatus(value: string | undefined): value is ContractStatus {
  return (CONTRACT_STATES as readonly string[]).includes(value ?? '');
}

export function contractStatusLabel(status: string): string {
  return isContractStatus(status) ? CONTRACT_STATE_LABELS[status] : status;
}

export const AMENDMENT_STATES = ['PROPOSED', 'EFFECTIVE'] as const;

export type AmendmentStatus = (typeof AMENDMENT_STATES)[number];

export const AMENDMENT_STATE_LABELS: Readonly<Record<AmendmentStatus, string>> = {
  PROPOSED: 'پیشنهادشده',
  EFFECTIVE: 'اجراشده',
};

export function isAmendmentStatus(value: string | undefined): value is AmendmentStatus {
  return (AMENDMENT_STATES as readonly string[]).includes(value ?? '');
}

export function amendmentStatusLabel(status: string): string {
  return isAmendmentStatus(status) ? AMENDMENT_STATE_LABELS[status] : status;
}

const BASIS_POINTS_PER_PERCENT = 100;

/** A milestone's planned share, basis points as a Persian percentage (`tender-fields.ts`'s formula). */
export function formatShareBp(shareBp: number): string {
  const whole = Math.trunc(shareBp / BASIS_POINTS_PER_PERCENT);
  const fraction = Math.abs(shareBp % BASIS_POINTS_PER_PERCENT);
  const digits = String(fraction).padStart(2, '0').replace(/0+$/, '');
  const text = digits ? `${whole}٫${digits}` : String(whole);
  return `${toPersianDigits(text)}٪`;
}
