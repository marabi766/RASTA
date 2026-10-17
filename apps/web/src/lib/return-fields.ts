/**
 * Return requests in the portal (EXP-003, RUN-005; ADR-048) — the closed
 * vocabularies, their Persian wording, and the fixed sentences every refusal
 * is said in. Client-safe: the forms and the screens read this, and so does
 * the server.
 *
 * What a return is **not**, here as in marketplace-service: a refund. No
 * status of a return moves money, the portal offers no refund and claims none
 * (Q-76 — economic-service has no refund operation for a settled order).
 */

// ---------------------------------------------------------------------------
// The request's lifecycle (marketplace-service `returns/state-machine.ts`)
// ---------------------------------------------------------------------------

/** `RETURN_STATUSES` — the commercial half; the physical states are inventory-service's. */
export const RETURN_STATUSES = ['REQUESTED', 'AUTHORIZED', 'REJECTED', 'CANCELLED'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export function isReturnStatus(value: unknown): value is ReturnStatus {
  return typeof value === 'string' && (RETURN_STATUSES as readonly string[]).includes(value);
}

const RETURN_STATUS_LABELS: Readonly<Record<ReturnStatus, string>> = {
  REQUESTED: 'درخواست‌شده، در انتظار تصمیم تأمین‌کننده',
  AUTHORIZED: 'پذیرفته‌شده، در انتظار ارسال کالا',
  REJECTED: 'ردشده',
  CANCELLED: 'لغوشده',
};

/** A status this portal does not know is shown as it arrived, never guessed (`lib/labels.ts`). */
export function returnStatusLabel(status: string): string {
  return isReturnStatus(status) ? RETURN_STATUS_LABELS[status] : status;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * What a party may ask of a return: the buyer asks (`REQUEST`) and withdraws
 * (`CANCEL`), the supplier authorizes or rejects. There is no refund command.
 */
export const RETURN_COMMANDS = ['REQUEST', 'AUTHORIZE', 'REJECT', 'CANCEL'] as const;
export type ReturnCommand = (typeof RETURN_COMMANDS)[number];

/** The commands on an existing request — they share its one slot (`lib/unresolved-return.ts`). */
export type ReturnDecisionCommand = Exclude<ReturnCommand, 'REQUEST'>;

export function isReturnCommand(value: unknown): value is ReturnCommand {
  return typeof value === 'string' && (RETURN_COMMANDS as readonly string[]).includes(value);
}

export const RETURN_COMMAND_LABELS: Readonly<Record<ReturnCommand, string>> = {
  REQUEST: 'درخواست بازگشت کالا',
  AUTHORIZE: 'پذیرفتن بازگشت',
  REJECT: 'رد درخواست بازگشت',
  CANCEL: 'لغو درخواست بازگشت',
};

/** What each command does — and, as truthfully, what it does not. */
export const RETURN_COMMAND_CONSEQUENCES: Readonly<Record<ReturnCommand, string>> = {
  REQUEST:
    'درخواست برای تأمین‌کننده فرستاده می‌شود تا آن را بپذیرد یا رد کند. این درخواست بازپرداخت نیست و وجهی جابه‌جا نمی‌کند.',
  AUTHORIZE:
    'می‌پذیرید که کالا بازگردانده شود. این تصمیم برگشت‌پذیر نیست. چیزی هنوز جابه‌جا نمی‌شود: کالا باید فرستاده، دریافت و بازرسی شود، و هیچ بازپرداختی از این صفحه انجام نمی‌شود.',
  REJECT: 'درخواست بازگشت رد می‌شود و پایان می‌یابد. این تصمیم برگشت‌پذیر نیست.',
  CANCEL:
    'درخواست بازگشت پیش از ارسال کالا پس گرفته می‌شود و پایان می‌یابد. این کار برگشت‌پذیر نیست.',
};

/** What the page says once a command is confirmed (the signed flash, `server/flash.ts`). */
export const RETURN_DONE_MESSAGES: Readonly<Record<ReturnCommand, string>> = {
  REQUEST: 'درخواست بازگشت ثبت شد و برای تأمین‌کننده فرستاده شد.',
  AUTHORIZE: 'بازگشت پذیرفته شد. کالا هنوز باید فرستاده، دریافت و بازرسی شود.',
  REJECT: 'درخواست بازگشت رد شد.',
  CANCEL: 'درخواست بازگشت لغو شد.',
};

// ---------------------------------------------------------------------------
// The request form (marketplace-service `returns/dto.ts`, `createReturnSchema`)
// ---------------------------------------------------------------------------

export const RETURN_REASON_MIN = 10;
export const RETURN_REASON_MAX = 1000;
export const MAX_RETURN_LINES = 50;
export const MAX_RETURN_QUANTITY = 1_000_000;
export const ORDER_LINE_ID_MAX = 64;

export const REASON_FIELD = 'reason';

/** The form field of one order line's quantity to return. */
export function quantityField(orderLineId: string): string {
  return `quantity.${orderLineId}`;
}

/** Which side of a request the list is about — the service's own term (`role`). */
export const RETURN_LIST_SIDES = ['BUYER', 'SUPPLIER'] as const;
export type ReturnListSide = (typeof RETURN_LIST_SIDES)[number];

export function isReturnListSide(value: unknown): value is ReturnListSide {
  return typeof value === 'string' && (RETURN_LIST_SIDES as readonly string[]).includes(value);
}

export const RETURN_LIST_SIDE_LABELS: Readonly<Record<ReturnListSide, string>> = {
  BUYER: 'درخواست‌های ما (خریدار)',
  SUPPLIER: 'درخواست‌ها از ما (تأمین‌کننده)',
};

// ---------------------------------------------------------------------------
// Refusals, in fixed words — never the service's own sentence
// ---------------------------------------------------------------------------

/**
 * Every business refusal on a return is `422 BUSINESS_RULE_VIOLATION` whose
 * only distinguishing part is its English sentence (the reason itself stays in
 * the service's log). The portal classifies the sentences it knows — pinned
 * against the service's source by `returns.contract.spec.ts` — and says each
 * in its own fixed words; it never shows the sentence.
 */
export const RETURN_REFUSAL_TEXT = {
  /** Q-132: no return window is configured, so no return can be asked for. */
  WINDOW_NOT_CONFIGURED:
    'بازگشت کالا هنوز در این سامانه باز نیست: مهلت بازگشت پیکربندی نشده است (پرسش باز Q-132). درخواستی ثبت نشد.',
  WINDOW_ELAPSED: 'مهلت بازگشت کالای این سفارش گذشته است. درخواستی ثبت نشد.',
  ORDER_NOT_COMPLETED:
    'بازگشت کالا فقط برای سفارش تکمیل‌شده ممکن است و این سفارش تکمیل‌شده نیست. درخواستی ثبت نشد.',
  QUANTITY_EXCEEDS:
    'تعداد درخواستی از یک ردیف بیش از مقداری است که هنوز می‌توان بازگرداند؛ ممکن است درخواست دیگری بخشی از آن را گرفته باشد. صفحه را تازه کنید و دوباره بسنجید. درخواستی ثبت نشد.',
  UNKNOWN_LINE: 'یکی از ردیف‌ها از ردیف‌های این سفارش نیست. صفحه را تازه کنید. درخواستی ثبت نشد.',
  /** The request is already decided or withdrawn: nothing the command means applies. */
  WRONG_STATE:
    'این درخواست بازگشت دیگر در وضعیتی نیست که این کار در آن ممکن باشد؛ ممکن است پیش‌تر تصمیمی درباره‌اش گرفته یا لغو شده باشد. صفحه را تازه کنید. چیزی ثبت نشد.',
  /** Another business rule this portal has no sentence for. */
  OTHER_RULE: 'این کار با قواعد درخواست بازگشت سازگار نیست و ثبت نشد. صفحه را تازه کنید.',
  /** A request was already filed under this submission (`CONFLICT` without `Retry-After`). */
  ALREADY_FILED:
    'با همین ارسال پیش‌تر درخواست بازگشتی ثبت شده است. فهرست بازگشت‌های این سفارش را ببینید.',
  KEY_REUSED:
    'این فرم پیش‌تر با محتوای دیگری فرستاده شده بود و ممکن است ثبت شده باشد. صفحه را تازه کنید و وضعیت را ببینید.',
  CHANGED: 'این درخواست بازگشت هم‌زمان تغییر کرد. صفحه را تازه کنید و دوباره بسنجید. چیزی ثبت نشد.',
  VALIDATION: 'اطلاعات واردشده پذیرفته نشد؛ دلیل و تعدادها را بررسی کنید. درخواستی ثبت نشد.',
  FALLBACK: 'این درخواست پذیرفته نشد و ثبت نشد. صفحه را تازه کنید و دوباره بسنجید.',
} as const;

/** Said to the buyer of an order that is not completed yet, in place of the form. */
export const RETURN_ORDER_NOT_COMPLETED_NOTE =
  'بازگشت کالا فقط برای سفارش تکمیل‌شده درخواست می‌شود؛ این سفارش هنوز تکمیل نشده است.';

// ---------------------------------------------------------------------------
// Goods coming back (inventory-service `return-shipment/dto.ts`) — read only
// ---------------------------------------------------------------------------

export const RETURN_SHIPMENT_STATUSES = [
  'IN_TRANSIT',
  'RECEIVED',
  'INSPECTED',
  'RESOLVED',
] as const;
export type ReturnShipmentStatus = (typeof RETURN_SHIPMENT_STATUSES)[number];

const RETURN_SHIPMENT_STATUS_LABELS: Readonly<Record<ReturnShipmentStatus, string>> = {
  IN_TRANSIT: 'در راه بازگشت',
  RECEIVED: 'دریافت‌شده، در انتظار بازرسی',
  INSPECTED: 'بازرسی‌شده، در انتظار تعیین تکلیف',
  RESOLVED: 'تعیین تکلیف‌شده',
};

export function returnShipmentStatusLabel(status: string): string {
  return (RETURN_SHIPMENT_STATUSES as readonly string[]).includes(status)
    ? RETURN_SHIPMENT_STATUS_LABELS[status as ReturnShipmentStatus]
    : status;
}

/** `RETURN_DISPOSITIONS` (`@rasta/contracts`): what became of received units — a record, not stock. */
export const RETURN_DISPOSITIONS = [
  'RESTOCK',
  'REPAIR',
  'REPLACE',
  'RETURN_TO_SUPPLIER',
  'SCRAP',
  'RECYCLE',
] as const;
export type ReturnDisposition = (typeof RETURN_DISPOSITIONS)[number];

const RETURN_DISPOSITION_LABELS: Readonly<Record<ReturnDisposition, string>> = {
  RESTOCK: 'بازگشت به موجودی',
  REPAIR: 'تعمیر',
  REPLACE: 'تعویض',
  RETURN_TO_SUPPLIER: 'بازگشت به تأمین‌کننده',
  SCRAP: 'اسقاط',
  RECYCLE: 'بازیافت',
};

export function returnDispositionLabel(disposition: string): string {
  return (RETURN_DISPOSITIONS as readonly string[]).includes(disposition)
    ? RETURN_DISPOSITION_LABELS[disposition as ReturnDisposition]
    : disposition;
}
