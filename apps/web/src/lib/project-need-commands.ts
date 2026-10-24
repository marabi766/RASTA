import { normalizePersianText, toLatinDigits, toPersianDigits } from './format';
import { PERSIAN_DECIMAL_SEPARATOR } from './format/codepoints';
import {
  canonicalLines,
  parseEstimate,
  STALE_MESSAGE,
  type ParsedProjectForm,
} from './project-commands';
import { SESSION_REFUSAL_MESSAGES } from './session-refusal';

/**
 * The commands of a project's needs (EXP-004; construction-service
 * `project.controller.ts` `addNeed`, `updateNeed`, `submitNeed`, `withdrawNeed`
 * and `need.state-machine.ts`): the closed vocabulary, which command each need
 * status offers, the form fields, how a form is read, and the fixed Persian
 * sentences every documented refusal is said in. Client-safe: the forms read this
 * to remember what they send, and the server actions read it again, so the
 * remembered request and the sent request cannot differ.
 *
 * What the API does **not** have, and so this portal does not draw:
 *
 * - No `availableActions` or permission list on a need or a project. Who may write
 *   is the project roles (`canWriteProjects`), and which command a need offers is
 *   its status together with its project's (`needCommandsFrom`, pinned to the
 *   service's source by `project-need-commands.contract.spec.ts`). The service
 *   decides again on every send.
 * - An `Idempotency-Key` on adding a need alone. Editing, submitting and
 *   withdrawing carry the `expectedVersion` the page was drawn at.
 * - No `Idempotency-Replay-Deadline` on adding a need (the controller reads only
 *   the key): the service cannot refuse a resend past its own retention, so an
 *   unresolved add is never sent again by the portal (`project-need-create` is
 *   `retry: false` in `unresolved-request-policy.ts`).
 * - No way to delete a need, or to edit a submitted one: withdraw it and add a new
 *   one (the service's rule).
 *
 * Wording: new text on these screens carries no hamza and no combining hamza.
 */

export const NEED_COMMANDS = ['add', 'edit', 'submit', 'withdraw'] as const;
export type NeedCommand = (typeof NEED_COMMANDS)[number];

export function isNeedCommand(value: unknown): value is NeedCommand {
  return typeof value === 'string' && (NEED_COMMANDS as readonly string[]).includes(value);
}

export const NEED_STATUSES = ['DRAFT', 'SUBMITTED', 'WITHDRAWN'] as const;
export type NeedStatus = (typeof NEED_STATUSES)[number];

export const NEED_STATUS_LABELS: Readonly<Record<NeedStatus, string>> = {
  DRAFT: 'پیش‌نویس',
  SUBMITTED: 'ارسال‌شده',
  WITHDRAWN: 'پس‌گرفته',
};

export function needStatusLabel(status: string): string {
  return (NEED_STATUSES as readonly string[]).includes(status)
    ? NEED_STATUS_LABELS[status as NeedStatus]
    : status;
}

/** The project statuses in which its needs change (`EDITABLE_PROJECT_STATES`). */
export const NEEDS_EDITABLE_PROJECT_STATUSES: readonly string[] = ['DRAFT', 'CHANGES_REQUESTED'];

/** Whether a need may be added to a project in `projectStatus`. */
export function canAddNeed(projectStatus: string): boolean {
  return NEEDS_EDITABLE_PROJECT_STATUSES.includes(projectStatus);
}

/**
 * The commands a need offers: none unless its project is editable; then a DRAFT
 * need is edited, submitted or withdrawn, a SUBMITTED one withdrawn, a WITHDRAWN
 * one nothing. A status this portal has no word for offers nothing.
 */
export function needCommandsFrom(
  projectStatus: string,
  needStatus: string,
): readonly NeedCommand[] {
  if (!canAddNeed(projectStatus)) return [];
  if (needStatus === 'DRAFT') return ['edit', 'submit', 'withdraw'];
  if (needStatus === 'SUBMITTED') return ['withdraw'];
  return [];
}

export const NEED_COMMAND_LABELS: Readonly<Record<NeedCommand, string>> = {
  add: 'افزودن نیاز',
  edit: 'ویرایش نیاز',
  submit: 'ارسال نیاز',
  withdraw: 'پس‌گرفتن نیاز',
};

/** What each command does, and as truthfully what it does not (the controllers' own descriptions). */
export const NEED_COMMAND_CONSEQUENCES: Readonly<Record<NeedCommand, string>> = {
  add: 'نیاز به صورت پیش‌نویس ثبت می‌شود و فقط تا وقتی پروژه پیش‌نویس یا نیازمند اصلاح است افزوده می‌شود. نیاز پیش‌نویس در محدوده پروژه به حساب نمی‌آید تا آن را بفرستید.',
  edit: 'فقط نیاز پیش‌نویس ویرایش می‌شود و فقط فیلدهایی که عوض کرده‌اید فرستاده می‌شود. نیاز ارسال‌شده ویرایش نمی‌شود: آن را پس بگیرید و نیاز تازه‌ای بیفزایید.',
  submit:
    'نیاز پیش‌نویس به محدوده پروژه می‌رود و دیگر ویرایش نمی‌شود. اگر استقرار حداقل نیاز ارسال‌شده را شرط کرده باشد، درخواست موافقت پروژه به آن نیاز دارد.',
  withdraw:
    'پس‌گرفتن پایانی است و نیاز پس‌گرفته دوباره باز نمی‌شود؛ حذف هم نمی‌شود و در پرونده می‌ماند. دلیل آن لازم است و در پرونده می‌ماند.',
};

// ---------------------------------------------------------------------------
// What the page says once a command is confirmed (the signed flash, `server/flash.ts`)
// ---------------------------------------------------------------------------

/** The notices a need command's redirect carries; part of the project page's one notice vocabulary. */
export type NeedNotice = 'needAdded' | 'needUpdated' | 'needSubmitted' | 'needWithdrawn';

export const NEED_NOTICES: readonly NeedNotice[] = [
  'needAdded',
  'needUpdated',
  'needSubmitted',
  'needWithdrawn',
];

export const NEED_NOTICE_TEXT: Readonly<
  Record<NeedNotice, { readonly tone: 'success'; readonly text: string }>
> = {
  needAdded: {
    tone: 'success',
    text: 'نیاز به صورت پیش‌نویس ثبت شد. پس از بازبینی آن را بفرستید تا در محدوده پروژه بیاید.',
  },
  needUpdated: { tone: 'success', text: 'نیاز ذخیره شد.' },
  needSubmitted: { tone: 'success', text: 'نیاز به محدوده پروژه فرستاده شد.' },
  needWithdrawn: { tone: 'success', text: 'نیاز پس گرفته شد و دلیل آن در پرونده ماند.' },
};

// ---------------------------------------------------------------------------
// Limits (construction-service `dto.ts`, pinned by `project-need-commands.contract.spec.ts`)
// ---------------------------------------------------------------------------

export const MIN_NEED_TITLE_LENGTH = 2;
export const MAX_NEED_TITLE_LENGTH = 200;
export const MIN_NEED_DESCRIPTION_LENGTH = 1;
export const MAX_NEED_DESCRIPTION_LENGTH = 2000;
export const MIN_NEED_UNIT_LENGTH = 1;
export const MAX_NEED_UNIT_LENGTH = 50;
export const MIN_NEED_REASON_LENGTH = 8;
export const MAX_NEED_REASON_LENGTH = 500;
/** Digits before and after the decimal point of a quantity (`quantityInput`). */
export const MAX_QUANTITY_INTEGER_DIGITS = 14;
export const MAX_QUANTITY_FRACTION_DIGITS = 4;

// ---------------------------------------------------------------------------
// The forms
// ---------------------------------------------------------------------------

export const NEED_FIELDS = ['title', 'description', 'quantity', 'unit', 'estimatedCost'] as const;
export type NeedField = (typeof NEED_FIELDS)[number];
export type NeedFormValues = Readonly<Record<NeedField, string>>;
export const EMPTY_NEED_FORM: NeedFormValues = {
  title: '',
  description: '',
  quantity: '',
  unit: '',
  estimatedCost: '',
};

export const WITHDRAW_NEED_FIELDS = ['reason'] as const;
export type WithdrawNeedField = (typeof WITHDRAW_NEED_FIELDS)[number];
export type WithdrawNeedFormValues = Readonly<Record<WithdrawNeedField, string>>;
export const EMPTY_WITHDRAW_NEED_FORM: WithdrawNeedFormValues = { reason: '' };

const textOf = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/**
 * A quantity as one canonical string: Latin digits, `.` as the decimal mark, no
 * leading zeros and no trailing fractional zeros — so `7.50`, `۷٫۵` and `07.5`
 * are the same quantity and the same text (compared by value, never as floats).
 * Text that is not a decimal number is returned trimmed and otherwise as typed,
 * for the field's own message to refuse.
 */
export function canonicalQuantity(raw: string): string {
  const typed = raw.trim();
  // Only `.` and the Persian decimal mark: a comma may be a thousands separator, and `1,000` read as
  // `1.000` would be a quantity a thousand times too small.
  const latin = toLatinDigits(typed).split(PERSIAN_DECIMAL_SEPARATOR).join('.');
  const match = /^(\d+)(?:\.(\d*))?$/.exec(latin);
  if (!match) return typed;
  const whole = (match[1] ?? '').replace(/^0+(?=\d)/, '');
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/**
 * A need's text the way a form reads it back: lines normalised, the rest trimmed,
 * the quantity canonical. The edit form's baseline digests the record this way, so
 * a field the person did not touch compares equal to what the page drew.
 */
export function normalizeNeedValues(values: NeedFormValues): NeedFormValues {
  return {
    title: normalizePersianText(values.title),
    description: canonicalLines(values.description).trim(),
    quantity: canonicalQuantity(values.quantity),
    unit: normalizePersianText(values.unit),
    estimatedCost: values.estimatedCost.trim(),
  };
}

export function needFormValues(form: FormData): NeedFormValues {
  return normalizeNeedValues({
    title: textOf(form, 'title'),
    description: textOf(form, 'description'),
    quantity: textOf(form, 'quantity'),
    unit: textOf(form, 'unit'),
    estimatedCost: textOf(form, 'estimatedCost'),
  });
}

export const withdrawNeedFormValues = (form: FormData): WithdrawNeedFormValues => ({
  reason: canonicalLines(textOf(form, 'reason')).trim(),
});

// ---------------------------------------------------------------------------
// What a person types
// ---------------------------------------------------------------------------

const fa = (value: number): string => toPersianDigits(String(value));

/**
 * The message for a text of the wrong length, or null. Written here and not through Zod: the sentence
 * is this portal's own Persian one, so no parser reads a Zod message (`form-issues.ts` is the boundary
 * for the ones that do). Lengths are UTF-16 units of the canonical (LF) text, as the service counts.
 */
function lengthMessage(label: string, value: string, min: number, max: number): string | null {
  if (value.length === 0) return `${label} را بنویسید`;
  if (value.length < min) return `${label} دست‌کم ${fa(min)} نویسه باشد`;
  if (value.length > max) return `${label} حداکثر ${fa(max)} نویسه است`;
  return null;
}

export const QUANTITY_MESSAGE = `مقدار را به عدد مثبت و با دست‌بالا چهار رقم اعشار بنویسید، برای نمونه ۲۵ یا ۲${PERSIAN_DECIMAL_SEPARATOR}۵ (بدون جداکننده هزارگان)`;

/** `''` is "no quantity"; anything else is a positive decimal the service accepts. */
export function parseQuantity(
  raw: string,
): { ok: true; quantity: string | null } | { ok: false; message: string } {
  const canonical = canonicalQuantity(raw);
  if (canonical === '') return { ok: true, quantity: null };
  const match = /^(\d+)(?:\.(\d+))?$/.exec(canonical);
  if (
    !match ||
    (match[1] ?? '').length > MAX_QUANTITY_INTEGER_DIGITS ||
    (match[2] ?? '').length > MAX_QUANTITY_FRACTION_DIGITS ||
    !/[1-9]/.test(canonical)
  ) {
    return { ok: false, message: QUANTITY_MESSAGE };
  }
  return { ok: true, quantity: canonical };
}

const titleMessage = (value: string) =>
  lengthMessage('عنوان', value, MIN_NEED_TITLE_LENGTH, MAX_NEED_TITLE_LENGTH);
const descriptionMessage = (value: string) =>
  lengthMessage('شرح', value, MIN_NEED_DESCRIPTION_LENGTH, MAX_NEED_DESCRIPTION_LENGTH);
const unitMessage = (value: string) =>
  lengthMessage('واحد', value, MIN_NEED_UNIT_LENGTH, MAX_NEED_UNIT_LENGTH);

/** What adding a need sends: the optional fields are left out when empty. */
export interface AddNeedBody {
  readonly title: string;
  readonly description: string;
  readonly quantity?: string;
  readonly unit?: string;
  readonly estimatedCostMinor?: string;
}

/** What the edit form sends: only the fields that changed; `null` clears an optional one. */
export interface UpdateNeedBody {
  readonly title?: string;
  readonly description?: string;
  readonly quantity?: string | null;
  readonly unit?: string | null;
  readonly estimatedCostMinor?: string | null;
}

type FieldErrors = Partial<Record<NeedField, string>>;

/** Each optional field's message, or its value: `''` is "none" for all three. */
function optionalFields(values: NeedFormValues): {
  readonly fieldErrors: FieldErrors;
  readonly quantity: string | null;
  readonly unit: string | null;
  readonly estimatedCostMinor: string | null;
} {
  const fieldErrors: FieldErrors = {};
  const quantity = parseQuantity(values.quantity);
  if (!quantity.ok) fieldErrors.quantity = quantity.message;
  const estimate = parseEstimate(values.estimatedCost);
  if (!estimate.ok) fieldErrors.estimatedCost = estimate.message;
  const unit = values.unit === '' ? null : unitMessage(values.unit);
  if (unit !== null) fieldErrors.unit = unit;
  return {
    fieldErrors,
    quantity: quantity.ok ? quantity.quantity : null,
    unit: values.unit === '' ? null : values.unit,
    estimatedCostMinor: estimate.ok ? estimate.minor : null,
  };
}

function requiredIssues(values: NeedFormValues): FieldErrors {
  const fieldErrors: FieldErrors = {};
  const title = titleMessage(values.title);
  if (title !== null) fieldErrors.title = title;
  const description = descriptionMessage(values.description);
  if (description !== null) fieldErrors.description = description;
  return fieldErrors;
}

/** Adding a need: a title and a description; quantity, unit and estimate only when typed. */
export function parseAddNeedForm(
  values: NeedFormValues,
): ParsedProjectForm<AddNeedBody, NeedField> {
  const optional = optionalFields(values);
  const fieldErrors = { ...requiredIssues(values), ...optional.fieldErrors };
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return {
    ok: true,
    body: {
      title: values.title,
      description: values.description,
      ...(optional.quantity === null ? {} : { quantity: optional.quantity }),
      ...(optional.unit === null ? {} : { unit: optional.unit }),
      ...(optional.estimatedCostMinor === null
        ? {}
        : { estimatedCostMinor: optional.estimatedCostMinor }),
    },
  };
}

export const NEED_NOTHING_CHANGED_MESSAGE =
  'چیزی عوض نشده است؛ فیلدی را تغییر دهید و دوباره بفرستید';

/**
 * Editing a need. `unchanged` says which fields still hold the value the page was
 * drawn with (from the signed baseline, never from the form), and only the others
 * are checked and sent: a field the person did not touch is not re-validated
 * against a rule the stored value might predate. An emptied optional field is
 * `null` (cleared); an unchanged one is absent.
 */
export function parseEditNeedForm(
  values: NeedFormValues,
  unchanged: ReadonlySet<NeedField>,
): ParsedProjectForm<UpdateNeedBody, NeedField> {
  const changed = NEED_FIELDS.filter((field) => !unchanged.has(field));
  if (changed.length === 0)
    return { ok: false, fieldErrors: { title: NEED_NOTHING_CHANGED_MESSAGE } };

  const optional = optionalFields(values);
  const issues: FieldErrors = { ...requiredIssues(values), ...optional.fieldErrors };
  const fieldErrors: FieldErrors = {};
  const body: { -readonly [K in keyof UpdateNeedBody]: UpdateNeedBody[K] } = {};

  for (const field of changed) {
    const issue = issues[field];
    if (issue !== undefined) {
      fieldErrors[field] = issue;
      continue;
    }
    switch (field) {
      case 'title':
      case 'description':
        body[field] = values[field];
        break;
      case 'quantity':
        body.quantity = optional.quantity;
        break;
      case 'unit':
        body.unit = optional.unit;
        break;
      case 'estimatedCost':
        body.estimatedCostMinor = optional.estimatedCostMinor;
        break;
    }
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, body };
}

/** Submitting a need sends nothing but the version. */
export function parseSubmitNeedForm(): ParsedProjectForm<Record<string, never>, never> {
  return { ok: true, body: {} };
}

export function parseWithdrawNeedForm(
  values: WithdrawNeedFormValues,
): ParsedProjectForm<{ readonly reason: string }, WithdrawNeedField> {
  const reason = lengthMessage(
    'دلیل',
    values.reason,
    MIN_NEED_REASON_LENGTH,
    MAX_NEED_REASON_LENGTH,
  );
  if (reason !== null) return { ok: false, fieldErrors: { reason } };
  return { ok: true, body: { reason: values.reason } };
}

// ---------------------------------------------------------------------------
// What the service says, in Persian — every documented refusal, in fixed words
// ---------------------------------------------------------------------------

export { STALE_MESSAGE };

/** 409 `IDEMPOTENCY_KEY_REUSED`: the submission id was used for a different request. */
export const NEED_KEY_REUSED_MESSAGE =
  'این شناسه ارسال پیش‌تر با درخواست دیگری به کار رفته است و این بار چیزی ثبت نشد. این درباره درخواست نخست چیزی نمی‌گوید؛ نیازهای پروژه را ببینید.';

/** 422 `BUSINESS_RULE_VIOLATION` the table below does not know. */
export const NEED_BUSINESS_RULE_MESSAGE =
  'این کار با قواعد سامانه سازگار نیست و چیزی ثبت نشد. صفحه را تازه کنید و وضعیت نیاز را ببینید.';

/** 422: the need's own state does not allow this (withdrawn, already submitted, not a draft). */
export const NEED_STATE_MESSAGE =
  'وضعیت فعلی نیاز اجازه این کار را نمی‌دهد و چیزی ثبت نشد. صفحه را تازه کنید و وضعیت را ببینید.';

/** 422: the project is no longer in a state where its needs change. */
export const NEED_PROJECT_LOCKED_MESSAGE =
  'نیازهای پروژه فقط تا وقتی پروژه پیش‌نویس یا نیازمند اصلاح است تغییر می‌کند و چیزی ثبت نشد. صفحه را تازه کنید و وضعیت پروژه را ببینید.';

/**
 * The refusals of the service that carry only a sentence: each is matched whole
 * (`patterns` of `write.ts`) and never shown; the contract spec pins every
 * pattern against the sentence in the service.
 */
export const NEED_422_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/^Need \S+ was withdrawn and cannot change state$/, NEED_STATE_MESSAGE],
  [/^Need \S+ cannot move from \S+ to \S+$/, NEED_STATE_MESSAGE],
  [
    /^Need \S+ is \S+ and can no longer be edited; withdraw it and add a new one$/,
    NEED_STATE_MESSAGE,
  ],
  [
    /^Project \S+ is \S+ and can no longer be edited; only a project in .+ can change$/,
    NEED_PROJECT_LOCKED_MESSAGE,
  ],
];

export const NEED_FORBIDDEN_MESSAGE =
  'اجازه این کار به شما داده نشده است. نقش‌های مجاز نوشتن و خواندن پروژه را تنظیمات استقرار تعیین می‌کند؛ ناظر هیچ‌گاه به پروژه تکی دسترسی ندارد.';
export const NEED_NOT_FOUND_MESSAGE = 'این پروژه یا نیاز پیدا نشد یا در سازمان فعال شما نیست.';
export const NEED_UNAVAILABLE_MESSAGE =
  'سرویس پروژه‌ها همین حالا پاسخ نمی‌دهد و چیزی ثبت نشد. کمی بعد دوباره تلاش کنید.';
export const NEED_FAILED_MESSAGE = 'انجام نشد و چیزی تغییر نکرد. می‌توانید دوباره بفرستید.';

// -- adding a need: the keyed create and its unresolved request ------------

/**
 * What the add form says when it was left open longer than the service keeps a
 * request's key: nothing was sent, and an earlier press may have added the need.
 */
export const NEED_EXPIRED_MESSAGE =
  'این فرم مدت زیادی باز مانده و دیگر فرستاده نمی‌شود، چون ممکن است فرستادن پیشین آن نیاز را ثبت کرده باشد. ' +
  'نخست فهرست نیازهای همین صفحه را بررسی کنید. اگر نیاز در فهرست نبود، صفحه را تازه کنید و دوباره ثبت کنید.';

/** An earlier add is unresolved and this post is another request. */
export const NEED_HELD_MESSAGE =
  'درخواست پیشین افزودن نیاز هنوز روشن نشده است و درخواست دیگری فرستاده نشد. ' +
  'نخست فهرست نیازهای همین صفحه را بررسی کنید؛ سپس می‌توانید آن را رها کنید و با پذیرفتن خطر تکرار، درخواست تازه بفرستید.';

/** Another dispatch of this form is in flight (another tab, a double press): nothing was sent. */
export const NEED_HELD_IN_PROGRESS_MESSAGE =
  'درخواست دیگری از این فرم هم‌اکنون در حال فرستاده شدن است (برای نمونه در زبانه دیگر)، پس چیزی فرستاده نشد. ' +
  'چند لحظه صبر کنید، صفحه را تازه کنید و وضعیت را ببینید.';

/** The store of unresolved requests could not be checked: nothing was sent. */
export const NEED_PENDING_UNCHECKED_MESSAGE =
  'اکنون نمی‌توان بررسی کرد که درخواست روشن‌نشده‌ای وجود دارد یا نه، پس چیزی فرستاده نشد و فرم افزودن نیاز نشان داده نمی‌شود. ' +
  'چند لحظه بعد صفحه را تازه کنید.';

/** The needs could not be read, so no add form is drawn: an add is sent only after the needs could be checked. */
export const NEED_LIST_UNREAD_MESSAGE =
  'نیازهای پروژه خوانده نشد، پس فرم افزودن نیاز نشان داده نمی‌شود. کمی بعد صفحه را تازه کنید.';

/** This login already holds the most unresolved requests allowed. */
export const NEED_PENDING_CAPACITY_MESSAGE =
  'شمار درخواست‌های روشن‌نشده این نشست به سقف رسیده است و چیزی فرستاده نشد. ' +
  'نخست درخواست‌های روشن‌نشده را بررسی و رها کنید.';

/** The release form was drawn for a request that has since changed. */
export const NEED_RELEASE_STALE_MESSAGE =
  'درخواست روشن‌نشده از زمان باز شدن این صفحه تغییر کرده است و چیزی تغییر نکرد. صفحه را تازه کنید و دوباره بررسی کنید.';

/** The first request is still being processed by the service (`409 CONFLICT` with `Retry-After`). */
export const NEED_STILL_PROCESSING_MESSAGE =
  'درخواست پیشین هنوز در سرویس در حال پردازش است و ممکن است ثبت شود. همین فرم دوباره فرستاده نمی‌شود؛ ' +
  'کمی بعد فهرست نیازهای همین صفحه را بررسی کنید.';

/** The reservation of this need create is held, not resendable: what the page says beside the list. */
export const NEED_UNRESOLVED_TEXT =
  'افزودن نیازی که پیشتر فرستادید هنوز روشن نشده است؛ ممکن است ثبت شده باشد. نیازهای همین صفحه را بررسی کنید، ' +
  'از جمله پس‌گرفته‌ها، و فرم افزودن تا روشن شدن این درخواست نشان داده نمی‌شود. ' +
  'این درخواست دوباره فرستاده نمی‌شود، چون سرویس برای آن مهلتی نمی‌پذیرد و نمی‌تواند فرستادن دیرهنگام را رد کند.';

export function needFailureText(status: number): string {
  if (status === 401) return SESSION_REFUSAL_MESSAGES.NO_SESSION;
  if (status === 503) return NEED_UNAVAILABLE_MESSAGE;
  return NEED_FAILED_MESSAGE;
}
