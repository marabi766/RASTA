/**
 * The vocabulary of a contractor's own bid on `/tenders/[id]` (EXP-004;
 * construction-service CON-002, ADR-065, ADR-066) — client-safe, so the forms
 * and the server share one copy. Pinned to the service's source by
 * `server/tender-bids.contract.spec.ts`.
 */

/** What a bidder may do with its organization's one bid (`BidController`). */
export const BID_COMMANDS = ['SUBMIT', 'REVISE', 'WITHDRAW'] as const;
export type BidCommand = (typeof BID_COMMANDS)[number];

export function isBidCommand(value: unknown): value is BidCommand {
  return typeof value === 'string' && (BID_COMMANDS as readonly string[]).includes(value);
}

/**
 * The commands whose unconfirmed outcome is never sent again (PR 345 review
 * 1, finding 1): a replacement or a withdrawal acts on the organization's bid
 * as it stands when the retry arrives, which another tab may have changed
 * since, so a retry could act on a bid its author never saw. Until
 * construction-service binds them to one bid state, an unknown outcome is
 * view-only. A submission stays retryable: an organization has one bid.
 */
export const UNREPEATABLE_BID_COMMANDS: readonly BidCommand[] = ['REVISE', 'WITHDRAW'];

export const BID_COMMAND_LABELS: Readonly<Record<BidCommand, string>> = {
  SUBMIT: 'ثبت پیشنهاد',
  REVISE: 'جایگزینی پیشنهاد',
  WITHDRAW: 'انصراف از پیشنهاد',
};

/** What each command does, said before it is sent. */
export const BID_COMMAND_CONSEQUENCES: Readonly<Record<BidCommand, string>> = {
  SUBMIT:
    'پیشنهاد سازمان شما برای این مناقصه ثبت می‌شود. هر سازمان یک پیشنهاد دارد و تا پایان مهلت می‌تواند آن را جایگزین کند یا پس بگیرد. محتوا در سرور مهر و موم می‌شود و پیش از گشایش برای هیچ‌کس، از جمله خود شما، خوانده نمی‌شود.',
  REVISE:
    'پیشنهاد کنونی با این پیشنهاد جایگزین می‌شود. محتوای پیشنهاد پیشین مهر و موم شده و خوانده نمی‌شود، پس پیشنهاد جایگزین را کامل بنویسید.',
  WITHDRAW:
    'پیشنهاد سازمان شما پس گرفته می‌شود. این کار بازگشت ندارد و پس از آن پیشنهاد تازه‌ای برای این مناقصه ثبت نمی‌شود.',
};

/** The confirmation after the redirect (`server/flash.ts`). */
export const BID_COMMAND_DONE: Readonly<Record<BidCommand, string>> = {
  SUBMIT: 'پیشنهاد ثبت شد. رسید آن در زیر آمده است.',
  REVISE: 'پیشنهاد جایگزین ثبت شد. رسید تازهٔ آن در زیر آمده است.',
  WITHDRAW: 'پیشنهاد پس گرفته شد.',
};

/** construction-service `BidStatus`. A status with no word here is shown as itself. */
export const BID_STATUSES = [
  'SUBMITTED',
  'WITHDRAWN',
  'OPENED',
  'QUALIFIED',
  'DISQUALIFIED',
  'AWARDED',
  'NOT_AWARDED',
] as const;

const BID_STATUS_LABELS: Readonly<Record<(typeof BID_STATUSES)[number], string>> = {
  SUBMITTED: 'ثبت‌شده',
  WITHDRAWN: 'پس‌گرفته',
  OPENED: 'گشوده‌شده',
  QUALIFIED: 'واجد شرایط',
  DISQUALIFIED: 'فاقد شرایط',
  AWARDED: 'برنده',
  NOT_AWARDED: 'برنده نشده',
};

export function bidStatusLabel(status: string): string {
  return (BID_STATUS_LABELS as Readonly<Record<string, string>>)[status] ?? status;
}

/** `bid.dto.ts`: `MAX_ANSWER_LENGTH`, `MAX_NOTE_LENGTH`, `MAX_ANSWERS`. */
export const BID_ANSWER_MAX = 2000;
export const BID_NOTE_MAX = 4000;
export const BID_ANSWERS_MAX = 50;

/** The form's fields. A criterion's answer is drawn per row; its code rides beside it. */
export const PRICE_FIELD = 'priceMinor';
export const NOTE_FIELD = 'note';
export const answerField = (row: number): string => `answer.${row}`;
export const criterionField = (row: number): string => `criterion.${row}`;

/**
 * Every closed reason a refused bid names (`BID_REFUSALS`, in `details[].code`
 * under the `bid` area), with the fixed sentence a person reads. The
 * service's English is never shown. The deadline and the qualification are
 * the backend's to judge — the window on the database clock after the tender
 * lock, the standing asked of supplier-service at that moment — and the page
 * only says what it decided.
 */
export const BID_REFUSAL_TEXT: Readonly<Record<string, string>> = {
  BID_WINDOW_NOT_OPEN:
    'بازهٔ پذیرش پیشنهاد این مناقصه هنوز آغاز نشده است؛ چیزی ثبت نشد. از زمان آغاز بازه دوباره تلاش کنید.',
  BID_WINDOW_CLOSED:
    'مهلت پذیرش پیشنهاد این مناقصه گذشته است؛ چیزی ثبت نشد. پس از مهلت پیشنهادی ثبت، جایگزین یا پس گرفته نمی‌شود.',
  BIDDER_NOT_ELIGIBLE:
    'سرویس تأمین‌کنندگان سازمان شما را اکنون واجد صلاحیت پیمانکاری (CONTRACTING) نمی‌داند — صلاحیتی تأییدنشده یا تعلیق — پس پیشنهاد پذیرفته نشد و چیزی ثبت نشد.',
  OWN_TENDER: 'سازمان شما برگزارکنندهٔ این مناقصه است و برای آن پیشنهاد نمی‌دهد.',
  UNKNOWN_CRITERION:
    'پاسخی به معیاری داده شده که این مناقصه ندارد؛ چیزی ثبت نشد. صفحه را تازه کنید و دوباره بنویسید.',
  BID_TOO_LARGE:
    'این پیشنهاد از بیشترین اندازهٔ پذیرفتنی بزرگ‌تر است؛ چیزی ثبت نشد. پاسخ‌ها یا یادداشت را کوتاه‌تر کنید.',
  BID_NOT_SUBMITTED:
    'این پیشنهاد دیگر در وضعیت «ثبت‌شده» نیست و جایگزین یا پس گرفته نمی‌شود. صفحه را تازه کنید.',
  BID_REVISION_LIMIT:
    'این پیشنهاد به بیشترین شمار نسخه‌های مجاز رسیده است و دیگر جایگزین نمی‌شود؛ چیزی ثبت نشد.',
  TENDER_RECEIPT_LIMIT:
    'زنجیرهٔ رسیدهای این مناقصه پر شده است و پیشنهاد تازه یا جایگزینی پذیرفته نمی‌شود؛ چیزی ثبت نشد.',
  TENDER_BID_LIMIT:
    'این مناقصه به بیشترین شمار پیشنهادهایی که می‌پذیرد رسیده است؛ پیشنهاد ثبت نشد.',
};

/** A refusal said by its platform code, when it names no closed reason. */
export const BID_CODE_TEXT: Readonly<Record<string, string>> = {
  ALREADY_EXISTS:
    'سازمان شما پیش‌تر برای این مناقصه پیشنهاد داده است و پیشنهاد دوم ثبت نشد. صفحه را تازه کنید؛ پیشنهاد موجود را می‌توانید تا پایان مهلت جایگزین کنید.',
  OPTIMISTIC_LOCK_FAILED:
    'پیشنهاد از وقتی این صفحه باز شد تغییر کرده است و چیزی ثبت نشد. صفحه را تازه کنید.',
  IDEMPOTENCY_KEY_REUSED:
    'این شناسهٔ ارسال پیش‌تر با درخواست دیگری به کار رفته است و چیزی ثبت نشد. صفحه را تازه کنید.',
  VALIDATION_FAILED: 'بخشی از پیشنهاد پذیرفتنی نیست؛ چیزی ثبت نشد. فرم را بررسی کنید.',
};

/** For anything the two tables above do not cover; the service's own sentence is never shown. */
export const BID_REFUSAL_FALLBACK =
  'این درخواست پذیرفته نشد و چیزی ثبت نشد. صفحه را تازه کنید و دوباره بررسی کنید.';
