import { toPersianDigits } from '@/lib/format';

/**
 * The tender vocabulary the `/tenders` screens render (docs/16 § ۱۶٫۶;
 * construction-service `TENDER_STATES`, `PROCUREMENT_NATURES`,
 * `TENDER_VISIBILITIES`, `SCORING_METHODS`, `CANCELLATION_CODES`).
 *
 * The portal does not enforce these on a response: a value it has no word for
 * renders as itself, visibly untranslated, rather than refusing the page
 * (`assets.ts` explains why). It does use `TENDER_STATUSES` for the owner list
 * filter, where anything outside it is dropped instead of being forwarded to
 * earn a 400.
 */
export const TENDER_STATUSES = [
  'DRAFT',
  'PUBLISHED',
  'CLOSED',
  'EVALUATING',
  'EVALUATED',
  'AWARDED',
  'CANCELLED',
] as const;

export type TenderStatus = (typeof TENDER_STATUSES)[number];

export const TENDER_STATUS_LABELS: Readonly<Record<TenderStatus, string>> = {
  DRAFT: 'پیش‌نویس',
  PUBLISHED: 'منتشرشده',
  CLOSED: 'بسته‌شده',
  EVALUATING: 'در حال ارزیابی',
  EVALUATED: 'ارزیابی‌شده',
  AWARDED: 'واگذارشده',
  CANCELLED: 'لغوشده',
};

export function isTenderStatus(value: string | undefined): value is TenderStatus {
  return (TENDER_STATUSES as readonly string[]).includes(value ?? '');
}

export function tenderStatusLabel(status: string): string {
  return isTenderStatus(status) ? TENDER_STATUS_LABELS[status] : status;
}

const NATURE_LABELS: Readonly<Record<string, string>> = {
  FORMAL_TENDER: 'مناقصه',
  INQUIRY: 'استعلام',
  RFP: 'درخواست پیشنهاد',
  MARKETPLACE_DEAL: 'معامله در بازار',
};

export function tenderNatureLabel(nature: string | null): string {
  if (nature === null) return 'تعیین نشده';
  return NATURE_LABELS[nature] ?? nature;
}

const VISIBILITY_LABELS: Readonly<Record<string, string>> = {
  PUBLIC: 'عمومی',
  RESTRICTED: 'فقط دعوت‌شدگان',
};

export function tenderVisibilityLabel(visibility: string | null): string {
  if (visibility === null) return 'تعیین نشده';
  return VISIBILITY_LABELS[visibility] ?? visibility;
}

const SCORING_METHOD_LABELS: Readonly<Record<string, string>> = {
  MANUAL_SCORE: 'امتیازدهی دستی',
  PASS_FAIL: 'قبول یا رد',
};

export function scoringMethodLabel(method: string): string {
  return SCORING_METHOD_LABELS[method] ?? method;
}

/**
 * The closed reason code a cancellation carries. The prose reason is the owner's
 * own text and is shown separately; a code the portal has no word for is left
 * out rather than shown raw.
 */
const STATUS_REASON_CODE_LABELS: Readonly<Record<string, string>> = {
  OWNER_REQUEST: 'به درخواست کارفرما',
  NO_QUALIFIED_BID: 'پیشنهاد واجد شرایطی نبود',
};

export function statusReasonCodeLabel(code: string | null): string | null {
  return code === null ? null : (STATUS_REASON_CODE_LABELS[code] ?? null);
}

/**
 * The in-app path of a tender's detail page, as a sign-in should bring the
 * person back to it: the id percent-encoded as one segment, and `view` kept
 * only when it is one of the two values the page understands. Always a
 * single-slash-rooted path, so it passes `safeReturnTo`.
 */
export function tenderDetailPath(id: string, view: unknown): string {
  const base = `/tenders/${encodeURIComponent(id)}`;
  return view === 'open' || view === 'own' ? `${base}?view=${view}` : base;
}

const BASIS_POINTS_PER_PERCENT = 100;

/**
 * A criterion weight, from basis points (an integer) to a percentage:
 * `2500` → `۲۵٪`, `3350` → `۳۳٫۵٪`. Exact integer arithmetic, no float.
 */
export function formatWeightBp(weightBp: number): string {
  const whole = Math.trunc(weightBp / BASIS_POINTS_PER_PERCENT);
  const fraction = Math.abs(weightBp % BASIS_POINTS_PER_PERCENT);
  const digits = String(fraction).padStart(2, '0').replace(/0+$/, '');
  const text = digits ? `${whole}٫${digits}` : String(whole);
  return `${toPersianDigits(text)}٪`;
}
