import { z } from 'zod';

import { normalizePersianText, toPersianDigits } from './format';
import { SESSION_REFUSAL_MESSAGES } from './session-refusal';
import { SUPPLIER_CAPABILITIES } from './supplier-fields';

/**
 * The commands of the supplier write screens (EXP-004; supplier-service
 * `supplier.controller.ts`): the closed vocabulary, the form fields, how a form
 * is read, and the fixed Persian sentences every refusal is said in.
 * Client-safe: the forms read this to remember what they send, and the server
 * actions read it again, so the remembered request and the sent request cannot
 * differ.
 *
 * What the API does **not** have, and so this portal does not draw: no
 * `availableActions` or permission list on any supplier response (what is
 * offered is mirrored from the token's roles and the record, pinned to the
 * service's source by `supplier-commands.contract.spec.ts`), no command to edit
 * a profile, no "my supplier" lookup, and no `Idempotency-Key` on any of the six
 * endpoints — so nothing here retries a send.
 *
 * Wording: new text on these screens carries no hamza and no combining hamza.
 */

export const SUPPLIER_COMMANDS = [
  'REGISTER',
  'SUBMIT_QUALIFICATION',
  'APPROVE_QUALIFICATION',
  'REJECT_QUALIFICATION',
  'SUSPEND',
  'REINSTATE',
] as const;
export type SupplierCommand = (typeof SUPPLIER_COMMANDS)[number];

export function isSupplierCommand(value: unknown): value is SupplierCommand {
  return typeof value === 'string' && (SUPPLIER_COMMANDS as readonly string[]).includes(value);
}

export const SUPPLIER_COMMAND_LABELS: Readonly<Record<SupplierCommand, string>> = {
  REGISTER: 'ثبت پرونده تامین‌کننده',
  SUBMIT_QUALIFICATION: 'ارسال درخواست صلاحیت',
  APPROVE_QUALIFICATION: 'تایید صلاحیت',
  REJECT_QUALIFICATION: 'رد صلاحیت',
  SUSPEND: 'تعلیق تامین‌کننده',
  REINSTATE: 'رفع تعلیق',
};

/** What each command does, and as truthfully what it does not (the controller's own descriptions). */
export const SUPPLIER_COMMAND_CONSEQUENCES: Readonly<Record<SupplierCommand, string>> = {
  REGISTER:
    'پرونده برای همین سازمان ساخته می‌شود؛ سازمان از نشست شما گرفته می‌شود و فیلدی برای آن نیست. دسته‌هایی که اینجا می‌نویسید ادعای شماست، نه صلاحیت: ثبت‌نام هیچ صلاحیتی نمی‌دهد و تا وقتی اپراتور پلتفرم درخواست صلاحیت را تایید نکند، تامین‌کننده برای هیچ دسته‌ای واجد صلاحیت نیست. برای هر سازمان فقط یک پرونده می‌شود.',
  SUBMIT_QUALIFICATION:
    'درخواست برای یک دسته ارسال می‌شود و منتظر تصمیم اپراتور پلتفرم می‌ماند. اپراتور از طرف تامین‌کننده درخواست نمی‌فرستد. سند پیوست فقط با شناسه در سرویس اسناد ذخیره می‌شود؛ سامانه سند را نمی‌گشاید، نمی‌خواند و درستی آن را نمی‌سنجد. تا وقتی درخواستی منتظر تصمیم یا تاییدشده است، درخواست دوم برای همان دسته پذیرفته نمی‌شود.',
  APPROVE_QUALIFICATION:
    'تصمیم صریح یک انسان است و هیچ مسیر خودکاری برای تایید نیست. تصمیم نهایی است: تغییر آن فقط با درخواست تازه ممکن است و درخواست اول در سابقه می‌ماند. یادداشت اختیاری خصوصی است: فقط بازبینان پلتفرم آن را می‌بینند، نه تامین‌کننده، و در هیچ رویدادی منتشر نمی‌شود. اگر پیامی برای تامین‌کننده لازم است، در یادداشت ننویسید. تایید رویداد «صلاحیت‌یافته» را همان لحظه منتشر می‌کند. تایید به معنی بررسی یا درستی سند پیوست نیست.',
  REJECT_QUALIFICATION:
    'تصمیم نهایی است. دلیل رد برای تامین‌کننده منتشر می‌شود تا بتواند اقدام کند؛ یادداشت اختیاری فقط سابقه خصوصی بازبین است و هرگز منتشر نمی‌شود. تامین‌کننده می‌تواند بعد از اصلاح، درخواست تازه بفرستد.',
  SUSPEND:
    'تصمیم اپراتور پلتفرم درباره سازمانی دیگر است و خودکار هیچ تعلیقی نیست. تعلیق صلاحیت‌ها را باطل نمی‌کند، فقط نگه می‌دارد: تامین‌کننده معلق برای هیچ دسته‌ای واجد صلاحیت شمرده نمی‌شود و با رفع تعلیق دقیقا همان تایید قبلی برمی‌گردد. تعلیق تا رفع صریح آن ادامه دارد و رویداد «تعلیق» همان لحظه منتشر می‌شود.',
  REINSTATE:
    'دوره تعلیق باز با نام شما و دلیل بسته می‌شود و پاک نمی‌شود؛ پس همیشه معلوم می‌ماند چه کسی و چرا تعلیق کرد. رویداد «رفع تعلیق» همان لحظه منتشر می‌شود.',
};

/** What the page says once a command is confirmed (the signed flash, `server/flash.ts`). */
export type SupplierNotice =
  'registered' | 'submitted' | 'approved' | 'rejected' | 'suspended' | 'reinstated' | 'stale';

export const SUPPLIER_NOTICES: readonly SupplierNotice[] = [
  'registered',
  'submitted',
  'approved',
  'rejected',
  'suspended',
  'reinstated',
  'stale',
];

export const SUPPLIER_NOTICE_TEXT: Readonly<
  Record<SupplierNotice, { readonly tone: 'success' | 'warning'; readonly text: string }>
> = {
  registered: {
    tone: 'success',
    text: 'پرونده تامین‌کننده ثبت شد. هنوز برای هیچ دسته‌ای واجد صلاحیت نیست؛ درخواست صلاحیت بفرستید.',
  },
  submitted: {
    tone: 'success',
    text: 'درخواست صلاحیت ارسال شد و منتظر تصمیم اپراتور پلتفرم است.',
  },
  approved: { tone: 'success', text: 'صلاحیت تایید شد.' },
  rejected: { tone: 'success', text: 'صلاحیت رد شد و دلیل آن برای تامین‌کننده ثبت شد.' },
  suspended: { tone: 'success', text: 'تامین‌کننده تعلیق شد.' },
  reinstated: { tone: 'success', text: 'تعلیق برداشته شد.' },
  stale: {
    tone: 'warning',
    text: 'پرونده پس از باز شدن این صفحه تغییر کرده بود؛ شاید همین کار پیش‌تر انجام شده یا کسی زودتر تصمیم گرفته باشد. این بار چیزی نوشته نشد. وضعیت فعلی را در همین صفحه ببینید و اگر هنوز لازم است دوباره اقدام کنید.',
  },
};

// ---------------------------------------------------------------------------
// Limits (supplier-service `dto.ts`, pinned by `supplier-commands.contract.spec.ts`)
// ---------------------------------------------------------------------------

export const MIN_DISPLAY_NAME_LENGTH = 2;
export const MAX_DISPLAY_NAME_LENGTH = 200;
export const MAX_STATEMENT_LENGTH = 2000;
export const MAX_EVIDENCE_ITEMS = 20;
export const MAX_DOCUMENT_ID_LENGTH = 64;
export const MAX_EVIDENCE_LABEL_LENGTH = 200;
export const MAX_NOTE_LENGTH = 2000;
export const MIN_REASON_LENGTH = 8;
export const MAX_REASON_LENGTH = 500;

/** `plainText()` refuses bidirectional controls; `referenceId()` refuses every control and format character. */
const BIDI_CONTROL = /\p{Bidi_Control}/u;
const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;

// ---------------------------------------------------------------------------
// The forms
// ---------------------------------------------------------------------------

export const REGISTER_FIELDS = ['displayName', 'capabilities'] as const;
export type RegisterField = (typeof REGISTER_FIELDS)[number];
export interface RegisterFormValues {
  readonly displayName: string;
  readonly capabilities: readonly string[];
}
export const EMPTY_REGISTER_FORM: RegisterFormValues = { displayName: '', capabilities: [] };

export const SUBMIT_FIELDS = ['capability', 'statement', 'evidence'] as const;
export type SubmitField = (typeof SUBMIT_FIELDS)[number];
export interface EvidenceRowValues {
  readonly documentId: string;
  readonly label: string;
}
export interface SubmitFormValues {
  readonly capability: string;
  readonly statement: string;
  readonly evidence: readonly EvidenceRowValues[];
}
export const EMPTY_SUBMIT_FORM: SubmitFormValues = { capability: '', statement: '', evidence: [] };
/** Rows of evidence the form draws before the person adds more. */
export const INITIAL_EVIDENCE_ROWS = 3;

export const APPROVE_FIELDS = ['note'] as const;
export type ApproveField = (typeof APPROVE_FIELDS)[number];
export type ApproveFormValues = Readonly<Record<ApproveField, string>>;
export const EMPTY_APPROVE_FORM: ApproveFormValues = { note: '' };

export const REJECT_FIELDS = ['reason', 'note'] as const;
export type RejectField = (typeof REJECT_FIELDS)[number];
export type RejectFormValues = Readonly<Record<RejectField, string>>;
export const EMPTY_REJECT_FORM: RejectFormValues = { reason: '', note: '' };

export const REASON_FIELDS = ['reason'] as const;
export type ReasonField = (typeof REASON_FIELDS)[number];
export type ReasonFormValues = Readonly<Record<ReasonField, string>>;
export const EMPTY_REASON_FORM: ReasonFormValues = { reason: '' };

export const EVIDENCE_ID_PREFIX = 'evidenceDocumentId_';
export const EVIDENCE_LABEL_PREFIX = 'evidenceLabel_';

// ---------------------------------------------------------------------------
// Reading a form
// ---------------------------------------------------------------------------

const textOf = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/** A name or a label: one line, so the Persian letters and spaces are normalised. */
const lineOf = (form: FormData, name: string): string => normalizePersianText(textOf(form, name));

export function registerFormValues(form: FormData): RegisterFormValues {
  return {
    displayName: lineOf(form, 'displayName'),
    capabilities: form.getAll('capabilities').filter((v): v is string => typeof v === 'string'),
  };
}

export function submitFormValues(form: FormData): SubmitFormValues {
  const evidence: EvidenceRowValues[] = [];
  for (let index = 0; index < MAX_EVIDENCE_ITEMS; index += 1) {
    const documentId = textOf(form, `${EVIDENCE_ID_PREFIX}${index}`).trim();
    const label = lineOf(form, `${EVIDENCE_LABEL_PREFIX}${index}`);
    if (documentId === '' && label === '') continue;
    evidence.push({ documentId, label });
  }
  return {
    capability: textOf(form, 'capability'),
    statement: textOf(form, 'statement').trim(),
    evidence,
  };
}

export const approveFormValues = (form: FormData): ApproveFormValues => ({
  note: textOf(form, 'note').trim(),
});

export const rejectFormValues = (form: FormData): RejectFormValues => ({
  reason: textOf(form, 'reason').trim(),
  note: textOf(form, 'note').trim(),
});

export const reasonFormValues = (form: FormData): ReasonFormValues => ({
  reason: textOf(form, 'reason').trim(),
});

// ---------------------------------------------------------------------------
// What a person types
// ---------------------------------------------------------------------------

const fa = (value: number): string => toPersianDigits(String(value));

export const BIDI_CONTROL_MESSAGE = 'این فیلد نویسه جهت‌دهی پنهان نمی‌پذیرد';
export const CONTROL_CHARACTER_MESSAGE = 'این فیلد نویسه کنترلی یا پنهان نمی‌پذیرد';

/** Free text as supplier-service's `plainText()` takes it: trimmed, no bidi control. */
function prose(label: string, min: number, max: number) {
  return z
    .string()
    .transform((raw) => raw.trim())
    .pipe(
      z
        .string()
        .min(1, `${label} را بنویسید`)
        .min(min, `${label} دست‌کم ${fa(min)} نویسه باشد`)
        .max(max, `${label} حداکثر ${fa(max)} نویسه است`)
        .refine((value) => !BIDI_CONTROL.test(value), BIDI_CONTROL_MESSAGE),
    );
}

/** Optional prose: empty means "not sent". */
function optionalProse(label: string, max: number) {
  return z
    .string()
    .transform((raw) => raw.trim())
    .pipe(
      z
        .string()
        .max(max, `${label} حداکثر ${fa(max)} نویسه است`)
        .refine((value) => !BIDI_CONTROL.test(value), BIDI_CONTROL_MESSAGE),
    )
    .transform((value) => (value === '' ? undefined : value));
}

const capabilityEnum = z.enum(SUPPLIER_CAPABILITIES, {
  errorMap: () => ({ message: 'یکی از دسته‌های فهرست را انتخاب کنید' }),
});

export const registerFormSchema = z
  .object({
    displayName: prose('نام', MIN_DISPLAY_NAME_LENGTH, MAX_DISPLAY_NAME_LENGTH),
    capabilities: z
      .array(capabilityEnum)
      .min(1, 'دست‌کم یک دسته را انتخاب کنید')
      .max(SUPPLIER_CAPABILITIES.length)
      .refine((value) => new Set(value).size === value.length, 'هر دسته را فقط یک بار بنویسید'),
  })
  .strict();

export type RegisterBody = z.output<typeof registerFormSchema>;

const evidenceRowSchema = z
  .object({
    documentId: z
      .string()
      .min(1, 'شناسه سند را بنویسید')
      .max(MAX_DOCUMENT_ID_LENGTH, `شناسه سند حداکثر ${fa(MAX_DOCUMENT_ID_LENGTH)} نویسه است`)
      .refine((value) => !CONTROL_CHARACTER.test(value), CONTROL_CHARACTER_MESSAGE),
    label: optionalProse('برچسب سند', MAX_EVIDENCE_LABEL_LENGTH),
  })
  .strict()
  .transform(({ documentId, label }) =>
    label === undefined ? { documentId } : { documentId, label },
  );

export const submitFormSchema = z
  .object({
    capability: capabilityEnum,
    statement: optionalProse('توضیح', MAX_STATEMENT_LENGTH),
    evidence: z
      .array(evidenceRowSchema)
      .max(MAX_EVIDENCE_ITEMS, `حداکثر ${fa(MAX_EVIDENCE_ITEMS)} سند پیوست می‌شود`),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.evidence.map((item) => item.documentId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence'],
        message: 'هر سند را فقط یک بار پیوست کنید',
      });
    }
  })
  .transform(({ capability, statement, evidence }) => ({
    capability,
    ...(statement === undefined ? {} : { statement }),
    evidence,
  }));

export type SubmitBody = z.output<typeof submitFormSchema>;

export const approveFormSchema = z
  .object({ note: optionalProse('یادداشت', MAX_NOTE_LENGTH) })
  .strict()
  .transform(({ note }) => (note === undefined ? {} : { note }));
export type ApproveBody = z.output<typeof approveFormSchema>;

export const rejectFormSchema = z
  .object({
    reason: prose('دلیل رد', MIN_REASON_LENGTH, MAX_REASON_LENGTH),
    note: optionalProse('یادداشت', MAX_NOTE_LENGTH),
  })
  .strict()
  .transform(({ reason, note }) => (note === undefined ? { reason } : { reason, note }));
export type RejectBody = z.output<typeof rejectFormSchema>;

export const suspendFormSchema = z
  .object({ reason: prose('دلیل تعلیق', MIN_REASON_LENGTH, MAX_REASON_LENGTH) })
  .strict();
export type SuspendBody = z.output<typeof suspendFormSchema>;

export const reinstateFormSchema = z
  .object({ reason: prose('دلیل رفع تعلیق', MIN_REASON_LENGTH, MAX_REASON_LENGTH) })
  .strict();
export type ReinstateBody = z.output<typeof reinstateFormSchema>;

export type ParsedSupplierForm<B, F extends string> =
  | { readonly ok: true; readonly body: B }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<F, string>> };

function parseWith<B, F extends string>(
  schema: z.ZodType<B, z.ZodTypeDef, unknown>,
  input: unknown,
  fields: readonly F[],
): ParsedSupplierForm<B, F> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, body: parsed.data };
  const fieldErrors: Partial<Record<F, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && (fields as readonly string[]).includes(field)) {
      fieldErrors[field as F] ??= issue.message;
    }
  }
  return { ok: false, fieldErrors };
}

export const parseRegisterForm = (values: RegisterFormValues) =>
  parseWith<RegisterBody, RegisterField>(
    registerFormSchema,
    { displayName: values.displayName, capabilities: [...values.capabilities] },
    REGISTER_FIELDS,
  );

export const parseSubmitForm = (values: SubmitFormValues) =>
  parseWith<SubmitBody, SubmitField>(
    submitFormSchema,
    {
      capability: values.capability,
      statement: values.statement,
      evidence: values.evidence.map((row) => ({ ...row })),
    },
    SUBMIT_FIELDS,
  );

export const parseApproveForm = (values: ApproveFormValues) =>
  parseWith<ApproveBody, ApproveField>(approveFormSchema, values, APPROVE_FIELDS);
export const parseRejectForm = (values: RejectFormValues) =>
  parseWith<RejectBody, RejectField>(rejectFormSchema, values, REJECT_FIELDS);
export const parseSuspendForm = (values: ReasonFormValues) =>
  parseWith<SuspendBody, ReasonField>(suspendFormSchema, values, REASON_FIELDS);
export const parseReinstateForm = (values: ReasonFormValues) =>
  parseWith<ReinstateBody, ReasonField>(reinstateFormSchema, values, REASON_FIELDS);

// ---------------------------------------------------------------------------
// What the service says, in Persian — every documented refusal, in fixed words
// ---------------------------------------------------------------------------

/** 409 on registration: this organization already has a profile. */
export const ALREADY_REGISTERED_MESSAGE =
  'این سازمان پیش از این پرونده تامین‌کننده دارد و ثبت دوباره پذیرفته نمی‌شود. آن را در فهرست تامین‌کنندگان پیدا کنید؛ ردیف سازمان شما نشان دارد.';

/**
 * The closed `details[].code` supplier-service answers with `409
 * OPTIMISTIC_LOCK_FAILED` when a suspend or reinstate names an episode that is
 * not the supplier's newest / open one any more (its `suspension.service.ts`).
 */
export const SUSPENSION_EPISODE_CHANGED = 'SUSPENSION_EPISODE_CHANGED';

/** 422 (and the 409 above): a rule of the qualification or suspension state refuses the command. */
export const STALE_MESSAGE =
  'وضعیت پرونده با این فرم نمی‌خواند: درخواست پیش‌تر تصمیم گرفته شده، درخواست دیگری برای همین دسته هست، یا وضعیت تعلیق عوض شده است. صفحه را تازه کنید.';

/** Another send on this supplier's record is in flight right now (another tab, a double press): nothing was sent. */
export const HELD_IN_PROGRESS_MESSAGE =
  'درخواست دیگری روی همین پرونده هم‌اکنون در حال فرستاده شدن است (برای نمونه در زبانه دیگر)، پس چیزی فرستاده نشد. ' +
  'چند لحظه صبر کنید، صفحه را تازه کنید و وضعیت را ببینید.';

/** The store of unresolved requests could not be checked: nothing was sent. */
export const PENDING_UNCHECKED_MESSAGE =
  'اکنون نمی‌توان بررسی کرد که درخواست روشن‌نشده‌ای روی این پرونده هست یا نه، پس چیزی فرستاده نشد و فرمی نشان داده نمی‌شود. ' +
  'چند لحظه بعد صفحه را تازه کنید.';

/** This login holds the most unresolved requests allowed. */
export const PENDING_CAPACITY_MESSAGE =
  'شمار درخواست‌های روشن‌نشده این نشست به سقف رسیده است و چیزی فرستاده نشد. ' +
  'نخست درخواست‌های روشن‌نشده را بررسی و رها کنید.';

/** The confirmation form was drawn for a request that has since changed. */
export const RELEASE_STALE_MESSAGE =
  'درخواست روشن‌نشده از زمان باز شدن این صفحه تغییر کرده است و چیزی تغییر نکرد. صفحه را تازه کنید و دوباره بررسی کنید.';

export const BUSINESS_RULE_MESSAGE =
  'این کار با قواعد سامانه سازگار نیست. صفحه را تازه کنید و وضعیت را ببینید.';

export const INVALID_INPUT_MESSAGE = 'مقدار واردشده با قواعد سامانه نمی‌خواند؛ آن را اصلاح کنید.';

/**
 * The refusals of the service that carry only a sentence: the three 422 rules and
 * the three lost races. Each is matched whole (`patterns` of `write.ts`) and never
 * shown; the contract spec pins every pattern against the sentence in the service.
 */
export const SUPPLIER_422_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/^A qualification for \S+ is already awaiting a decision$/, STALE_MESSAGE],
  [/^This supplier is already qualified for \S+$/, STALE_MESSAGE],
  [/^A qualification for \S+ already exists for this supplier$/, STALE_MESSAGE],
  [
    /^Qualification \S+ was already (approved|rejected) and cannot be decided again$/,
    STALE_MESSAGE,
  ],
  [/^Qualification \S+ cannot move from \S+ to \S+$/, STALE_MESSAGE],
  [/^Qualification \S+ was decided by somebody else first$/, STALE_MESSAGE],
  [/^Supplier \S+ is already suspended$/, STALE_MESSAGE],
  [/^Supplier \S+ is not suspended$/, STALE_MESSAGE],
  [/^Supplier \S+ was suspended by somebody else first$/, STALE_MESSAGE],
  [/^Supplier \S+ was reinstated by somebody else first$/, STALE_MESSAGE],
];

export const SUPPLIER_VALIDATION_MESSAGES: Readonly<Record<string, string>> = {
  'Contains unsupported characters': CONTROL_CHARACTER_MESSAGE,
  'A capability may be claimed only once': 'هر دسته را فقط یک بار بنویسید',
  'The same document may be attached only once': 'هر سند را فقط یک بار پیوست کنید',
};

/** What a form says for a refusal it did not send: forbidden, absent, unavailable. */
export const SUPPLIER_FORBIDDEN_MESSAGE =
  'اجازه این کار به شما داده نشده است. سازمان تامین‌کننده درباره صلاحیت، تعلیق یا رفع تعلیق خودش تصمیم نمی‌گیرد و اپراتور پلتفرم از طرف تامین‌کننده درخواست نمی‌فرستد.';
export const SUPPLIER_NOT_FOUND_MESSAGE =
  'این تامین‌کننده یا درخواست پیدا نشد یا در سازمان فعال شما نیست.';
/**
 * The reviewer note's promise, on both decision forms — and now a true one:
 * supplier-service returns the note to platform reviewers outside the supplier's
 * organization only, never to the supplier, and publishes it on no event (Codex
 * review of PR 366, finding 1).
 */
export const REVIEWER_NOTE_HINT =
  'اختیاری؛ فقط بازبینان پلتفرم آن را می‌بینند، نه تامین‌کننده، و در هیچ رویدادی منتشر نمی‌شود.';

export const SUPPLIER_FAILED_MESSAGE = 'انجام نشد و چیزی تغییر نکرد. می‌توانید دوباره بفرستید.';

/**
 * What a form says when the write was **proven** refused before it could act —
 * a `4xx` carrying one of the platform's documented error codes
 * (`provenUnwritten` in `server/supplier-commands.ts`): `401` (the token ran
 * out) in the session's own words, anything else (`429`, `413`, …) as "nothing
 * changed". A `5xx`, a reset connection or a timeout never reaches this: it may
 * have committed, so it is `UNCONFIRMED` (Codex review of PR 366, finding 3).
 */
export function supplierFailureText(status: number): string {
  if (status === 401) return SESSION_REFUSAL_MESSAGES.NO_SESSION;
  return SUPPLIER_FAILED_MESSAGE;
}
