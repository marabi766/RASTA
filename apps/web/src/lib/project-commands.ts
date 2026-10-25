import { z } from 'zod';

import { firstIssuePerField } from './form-issues';
import {
  IRR,
  MoneyInputError,
  normalizePersianText,
  parseMoneyInput,
  toPersianDigits,
} from './format';
import type { ProjectStatus } from './project-fields';
import { SESSION_REFUSAL_MESSAGES } from './session-refusal';

/**
 * The commands of the project write screens (EXP-004; construction-service
 * `project.controller.ts` and `lifecycle.controller.ts`): the closed
 * vocabulary, which command each status offers, the form fields, how a form is
 * read, and the fixed Persian sentences every refusal is said in. Client-safe:
 * the forms read this to remember what they send, and the server actions read
 * it again, so the remembered request and the sent request cannot differ.
 *
 * What the API does **not** have, and so this portal does not draw:
 *
 * - No `availableActions` or permission list on any project response. Who may
 *   write is configuration (`CONSTRUCTION_PROJECT_ROLES`, docs/24 Q-69), which
 *   the portal mirrors as `WEB_PROJECT_ROLES` (`canWriteProjects`), so a command
 *   is offered to a token that holds such a role and by the project's **status**
 *   (the lifecycle table, pinned to the service's source by
 *   `project-commands.contract.spec.ts`). The service decides again on every
 *   send, and a person it refuses is told so in fixed words
 *   (`PROJECT_FORBIDDEN_MESSAGE`).
 * - No Idempotency-Key on any command except creating a project. Every other
 *   command carries the `expectedVersion` the page was drawn at; a second send
 *   is a `409`, which the page answers with a fresh read.
 * - No way to send or clear the operating area from a form: the area is a
 *   GeoJSON polygon, the portal never reads it back (`server/projects.ts`), and
 *   a form that wrote what it cannot show would collect a thing nobody can check.
 *
 * Wording: standard Persian orthography (hamza included, no U+0654); see `orthography.spec.ts`.
 */

export const PROJECT_COMMANDS = [
  'edit',
  'requestApproval',
  'cancel',
  'start',
  'complete',
  'grant',
  'reject',
] as const;
export type ProjectCommand = (typeof PROJECT_COMMANDS)[number];

export function isProjectCommand(value: unknown): value is ProjectCommand {
  return typeof value === 'string' && (PROJECT_COMMANDS as readonly string[]).includes(value);
}

/** The statuses a project is edited and sent for approval from (`EDITABLE_PROJECT_STATES`). */
export const EDITABLE_STATUSES: readonly ProjectStatus[] = ['DRAFT', 'CHANGES_REQUESTED'];

/**
 * Every status a project may be cancelled from by the lifecycle
 * (`CANCELLABLE_BY_LIFECYCLE`). A deployment may narrow this
 * (`CONSTRUCTION_CANCELLABLE_STATES`); the service refuses a cancellation its
 * deployment does not keep, and that refusal has its own words.
 */
export const CANCELLABLE_STATUSES: readonly ProjectStatus[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'CHANGES_REQUESTED',
  'APPROVED',
];

/** The project commands (not the authority's decisions) a status offers. */
export function commandsFrom(status: string): readonly ProjectCommand[] {
  const offered: ProjectCommand[] = [];
  if (EDITABLE_STATUSES.some((s) => s === status)) offered.push('edit', 'requestApproval');
  if (status === 'APPROVED') offered.push('start');
  if (status === 'IN_PROGRESS') offered.push('complete');
  if (CANCELLABLE_STATUSES.some((s) => s === status)) offered.push('cancel');
  return offered;
}

export const PROJECT_COMMAND_LABELS: Readonly<Record<ProjectCommand, string>> = {
  edit: 'ویرایش مشخصات',
  requestApproval: 'درخواست موافقت',
  cancel: 'لغو پروژه',
  start: 'شروع اجرا',
  complete: 'تکمیل پروژه',
  grant: 'موافقت',
  reject: 'رد',
};

/** What each command does, and as truthfully what it does not (the controllers' own descriptions). */
export const PROJECT_COMMAND_CONSEQUENCES: Readonly<Record<ProjectCommand, string>> = {
  edit: 'فقط تا وقتی پروژه پیش‌نویس یا نیازمند اصلاح است ویرایش می‌شود؛ پس از درخواست موافقت، آنچه موافقت می‌شود تغییر نمی‌کند. فقط فیلدهایی که عوض کرده‌اید فرستاده می‌شود. محدوده عملیات از این فرم تغییر نمی‌کند.',
  requestApproval:
    'مراحل سیاست موافقت فعال سازمان که به برآورد این پروژه می‌خورد در یک دور تازه کپی می‌شود و نخستین مرجع از شما موافقت می‌خواهد. سامانه هیچ پروژه‌ای را خودکار یا پیش‌فرض تأیید نمی‌کند: بدون سیاست فعال، درخواست پذیرفته نمی‌شود. تنظیمات استقرار می‌تواند حداقل نیازهای ارسال‌شده و وجود برآورد را شرط کند.',
  cancel:
    'لغو پایانی است و پروژه لغوشده دوباره باز نمی‌شود. دلیل لغو در پرونده می‌ماند. دور موافقت بازمانده با لغو پایان می‌یابد. پروژه‌ای که مناقصه تمام‌نشده دارد لغو نمی‌شود؛ نخست مناقصه را لغو کنید. اجرای شروع‌شده را از اینجا نمی‌شود لغو کرد.',
  start:
    'پروژه تأییدشده به حالت در حال اجرا می‌رود. تا وقتی مرز قرارداد ساخته نشده، شروع هیچ قراردادی را ثبت نمی‌کند؛ اگر استقرار شروع را به قرارداد امضاشده مشروط کرده باشد، سامانه شروع را نمی‌پذیرد.',
  complete:
    'پروژه فقط وقتی تکمیل می‌شود که آخرین گزارش پیشرفت ارسال‌شده ۱۰۰٪ باشد. اگر برای تکمیل موافقت نهایی تعریف شده باشد، همین کار دور موافقت تکمیل را باز می‌کند و پروژه با آخرین موافقت تکمیل می‌شود؛ وگرنه همین حالا تکمیل می‌شود.',
  grant:
    'تصمیم صریح مرجع است و هیچ موافقت خودکاری یا بر پایه مهلت نیست. آخرین موافقت یک دور، پروژه را تأیید می‌کند (یا برای دور تکمیل، آن را تکمیل می‌کند). شماره تصمیم و شرایط اختیاری‌اند و در پرونده می‌مانند.',
  reject:
    'رد دور را پایان می‌دهد؛ مرحله‌های بعدی کنار می‌روند و پروژه برای اصلاح به صاحبش برمی‌گردد. دلیل رد لازم است و در پرونده می‌ماند. سامانه جای مرجع تصمیم نمی‌گیرد.',
};

// ---------------------------------------------------------------------------
// What the page says once a command is confirmed (the signed flash, `server/flash.ts`)
// ---------------------------------------------------------------------------

/** What a decision made from the list's inbox signs its confirmation for: the inbox as a whole, not one step. */
export const INBOX_FLASH_SUBJECT = 'inbox';

export type ProjectNotice =
  | 'created'
  | 'updated'
  | 'approvalRequested'
  | 'started'
  | 'completionRequested'
  | 'cancelled'
  | 'granted'
  | 'rejected'
  | 'stale';

export const PROJECT_NOTICES: readonly ProjectNotice[] = [
  'created',
  'updated',
  'approvalRequested',
  'started',
  'completionRequested',
  'cancelled',
  'granted',
  'rejected',
  'stale',
];

export const PROJECT_NOTICE_TEXT: Readonly<
  Record<ProjectNotice, { readonly tone: 'success' | 'warning'; readonly text: string }>
> = {
  created: {
    tone: 'success',
    text: 'پروژه به صورت پیش‌نویس ثبت شد. پس از ویرایش، موافقت را درخواست کنید.',
  },
  updated: { tone: 'success', text: 'مشخصات پروژه ذخیره شد.' },
  approvalRequested: {
    tone: 'success',
    text: 'درخواست موافقت ثبت شد و نخستین مرجع باید تصمیم بگیرد. وضعیت دور را پایین همین صفحه ببینید.',
  },
  started: { tone: 'success', text: 'اجرای پروژه شروع شد.' },
  completionRequested: {
    tone: 'success',
    text: 'درخواست تکمیل ثبت شد. وضعیت فعلی پروژه را در همین صفحه ببینید؛ اگر موافقت تکمیل لازم باشد، پروژه با آخرین موافقت تکمیل می‌شود.',
  },
  cancelled: { tone: 'success', text: 'پروژه لغو شد.' },
  granted: { tone: 'success', text: 'موافقت شما ثبت شد.' },
  rejected: { tone: 'success', text: 'رد شما ثبت شد و دلیل آن در پرونده ماند.' },
  stale: {
    tone: 'warning',
    text: 'پرونده پس از باز شدن این صفحه تغییر کرده بود؛ شاید همین کار پیش‌تر انجام شده یا کس دیگری زودتر اقدام کرده باشد. این بار چیزی نوشته نشد. وضعیت فعلی را در همین صفحه ببینید و اگر هنوز لازم است دوباره اقدام کنید.',
  },
};

// ---------------------------------------------------------------------------
// Limits (construction-service `dto.ts`, pinned by `project-commands.contract.spec.ts`)
// ---------------------------------------------------------------------------

export const MIN_TITLE_LENGTH = 2;
export const MAX_TITLE_LENGTH = 200;
export const MIN_OPERATION_TYPE_LENGTH = 2;
export const MAX_OPERATION_TYPE_LENGTH = 100;
export const MAX_SCOPE_LENGTH = 5000;
export const MIN_LOCATION_LENGTH = 2;
export const MAX_LOCATION_LENGTH = 500;
export const MIN_REASON_LENGTH = 8;
export const MAX_REASON_LENGTH = 500;
export const MAX_DECISION_NUMBER_LENGTH = 100;
export const MAX_CONDITIONS_LENGTH = 2000;
/** The largest value a PostgreSQL BIGINT holds (`BIGINT_MAX`). */
const BIGINT_MAX = 9_223_372_036_854_775_807n;

// ---------------------------------------------------------------------------
// The forms
// ---------------------------------------------------------------------------

export const PROJECT_FIELDS = [
  'title',
  'operationType',
  'locationDescription',
  'scopeOfWork',
  'estimatedCost',
] as const;
export type ProjectField = (typeof PROJECT_FIELDS)[number];
export type ProjectFormValues = Readonly<Record<ProjectField, string>>;
export const EMPTY_PROJECT_FORM: ProjectFormValues = {
  title: '',
  operationType: '',
  locationDescription: '',
  scopeOfWork: '',
  estimatedCost: '',
};

export const CANCEL_FIELDS = ['reason', 'confirm'] as const;
export type CancelField = (typeof CANCEL_FIELDS)[number];
export type CancelFormValues = Readonly<Record<CancelField, string>>;
export const EMPTY_CANCEL_FORM: CancelFormValues = { reason: '', confirm: '' };

/** The commands with nothing to type. */
export type NoFormValues = Readonly<Record<string, never>>;

export const GRANT_FIELDS = ['decisionNumber', 'conditions'] as const;
export type GrantField = (typeof GRANT_FIELDS)[number];
export type GrantFormValues = Readonly<Record<GrantField, string>>;
export const EMPTY_GRANT_FORM: GrantFormValues = { decisionNumber: '', conditions: '' };

export const REJECT_FIELDS = ['reason'] as const;
export type RejectField = (typeof REJECT_FIELDS)[number];
export type RejectFormValues = Readonly<Record<RejectField, string>>;
export const EMPTY_REJECT_FORM: RejectFormValues = { reason: '' };

// ---------------------------------------------------------------------------
// Reading a form
// ---------------------------------------------------------------------------

const textOf = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/**
 * A multi-line text with one line ending: CRLF and a lone CR become LF. A browser
 * posts a textarea's newlines as CRLF while the API stores whatever it was given
 * (LF), so the same text would otherwise differ between the page that drew it, the
 * baseline digest, the length rule and the body sent — an untouched scope would look
 * edited, and a 5000-character one with a newline would be 5001.
 */
export function canonicalLines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/**
 * A project's text the way a form reads it back: lines normalised, the rest
 * trimmed. The edit form's baseline digests the record this way, so a field the
 * person did not touch compares equal to what the page drew.
 */
export function normalizeProjectValues(values: ProjectFormValues): ProjectFormValues {
  return {
    title: normalizePersianText(values.title),
    operationType: normalizePersianText(values.operationType),
    locationDescription: normalizePersianText(values.locationDescription),
    scopeOfWork: canonicalLines(values.scopeOfWork).trim(),
    estimatedCost: values.estimatedCost.trim(),
  };
}

export function projectFormValues(form: FormData): ProjectFormValues {
  return normalizeProjectValues({
    title: textOf(form, 'title'),
    operationType: textOf(form, 'operationType'),
    locationDescription: textOf(form, 'locationDescription'),
    scopeOfWork: textOf(form, 'scopeOfWork'),
    estimatedCost: textOf(form, 'estimatedCost'),
  });
}

export const cancelFormValues = (form: FormData): CancelFormValues => ({
  reason: canonicalLines(textOf(form, 'reason')).trim(),
  confirm: textOf(form, 'confirm'),
});

export const grantFormValues = (form: FormData): GrantFormValues => ({
  decisionNumber: textOf(form, 'decisionNumber').trim(),
  conditions: canonicalLines(textOf(form, 'conditions')).trim(),
});

export const rejectFormValues = (form: FormData): RejectFormValues => ({
  reason: canonicalLines(textOf(form, 'reason')).trim(),
});

export const noFormValues = (): NoFormValues => ({});

// ---------------------------------------------------------------------------
// What a person types
// ---------------------------------------------------------------------------

const fa = (value: number): string => toPersianDigits(String(value));

function text(label: string, min: number, max: number) {
  return z
    .string()
    .min(1, `${label} را بنویسید`)
    .min(min, `${label} دست‌کم ${fa(min)} نویسه باشد`)
    .max(max, `${label} حداکثر ${fa(max)} نویسه است`);
}

/** The estimate as construction-service takes it: whole rial minor units, `0` to the BIGINT bound. */
export const ESTIMATE_MESSAGE = 'برآورد را به ریال و با ارقام درست بنویسید، بدون اعشار';
export const ESTIMATE_TOO_LARGE_MESSAGE = 'این برآورد از بزرگ‌ترین مقدار قابل ثبت بیشتر است';

/** `''` is "no estimate"; anything else is whole rials as a string of digits. */
export function parseEstimate(
  raw: string,
): { ok: true; minor: string | null } | { ok: false; message: string } {
  if (raw.trim() === '') return { ok: true, minor: null };
  try {
    const value = parseMoneyInput(raw, IRR);
    if (value < 0n) return { ok: false, message: ESTIMATE_MESSAGE };
    if (value > BIGINT_MAX) return { ok: false, message: ESTIMATE_TOO_LARGE_MESSAGE };
    return { ok: true, minor: value.toString() };
  } catch (error) {
    if (error instanceof MoneyInputError) return { ok: false, message: ESTIMATE_MESSAGE };
    throw error;
  }
}

const projectFormSchema = z.object({
  title: text('عنوان', MIN_TITLE_LENGTH, MAX_TITLE_LENGTH),
  operationType: text('نوع عملیات', MIN_OPERATION_TYPE_LENGTH, MAX_OPERATION_TYPE_LENGTH),
  locationDescription: text('محل', MIN_LOCATION_LENGTH, MAX_LOCATION_LENGTH),
  scopeOfWork: text('شرح کار', 1, MAX_SCOPE_LENGTH),
});

export interface ProjectBody {
  readonly title: string;
  readonly operationType: string;
  readonly locationDescription: string;
  readonly scopeOfWork: string;
  readonly estimatedCostMinor?: string;
}

export type ParsedProjectForm<B, F extends string> =
  | { readonly ok: true; readonly body: B }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<F, string>> };

/** Creating a project: every field a person types, the estimate left out when empty. */
export function parseCreateForm(
  values: ProjectFormValues,
): ParsedProjectForm<ProjectBody, ProjectField> {
  const parsed = projectFormSchema.safeParse(values);
  const estimate = parseEstimate(values.estimatedCost);
  if (!parsed.success || !estimate.ok) {
    return {
      ok: false,
      fieldErrors: {
        ...(parsed.success ? {} : firstIssuePerField(parsed.error, PROJECT_FIELDS)),
        ...(estimate.ok ? {} : { estimatedCost: estimate.message }),
      },
    };
  }
  return {
    ok: true,
    body: {
      ...parsed.data,
      ...(estimate.minor === null ? {} : { estimatedCostMinor: estimate.minor }),
    },
  };
}

/** What the edit form sends: only the fields that changed; `null` clears the estimate. */
export interface UpdateBody {
  readonly title?: string;
  readonly operationType?: string;
  readonly locationDescription?: string;
  readonly scopeOfWork?: string;
  readonly estimatedCostMinor?: string | null;
}

export const NOTHING_CHANGED_MESSAGE = 'چیزی عوض نشده است؛ فیلدی را تغییر دهید و دوباره بفرستید';

/**
 * Editing a project. `unchanged` says which fields still hold the value the
 * page was drawn with (from the signed baseline, never from the form), and only
 * the others are checked and sent: a field the person did not touch is not
 * re-validated against a rule the stored value might predate.
 */
export function parseEditForm(
  values: ProjectFormValues,
  unchanged: ReadonlySet<ProjectField>,
): ParsedProjectForm<UpdateBody, ProjectField> {
  const changed = PROJECT_FIELDS.filter((field) => !unchanged.has(field));
  if (changed.length === 0) {
    return { ok: false, fieldErrors: { title: NOTHING_CHANGED_MESSAGE } };
  }

  const fieldErrors: Partial<Record<ProjectField, string>> = {};
  const body: { -readonly [K in keyof UpdateBody]: UpdateBody[K] } = {};

  const parsed = projectFormSchema.safeParse(values);
  const issues = parsed.success ? {} : firstIssuePerField(parsed.error, PROJECT_FIELDS);
  for (const field of changed) {
    if (field === 'estimatedCost') continue;
    const issue = issues[field];
    if (issue !== undefined) fieldErrors[field] = issue;
    else body[field] = values[field];
  }

  if (changed.includes('estimatedCost')) {
    const estimate = parseEstimate(values.estimatedCost);
    if (!estimate.ok) fieldErrors.estimatedCost = estimate.message;
    else body.estimatedCostMinor = estimate.minor;
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, body };
}

const reasonSchema = z.object({ reason: text('دلیل', MIN_REASON_LENGTH, MAX_REASON_LENGTH) });

export const CANCEL_UNCONFIRMED_MESSAGE = 'برای لغو باید تأیید کنید که پایانی بودن آن را می‌دانید';

export function parseCancelForm(
  values: CancelFormValues,
): ParsedProjectForm<{ readonly reason: string }, CancelField> {
  const reason = reasonSchema.safeParse({ reason: values.reason });
  const fieldErrors: Partial<Record<CancelField, string>> = reason.success
    ? {}
    : firstIssuePerField(reason.error, ['reason']);
  if (values.confirm !== 'yes') fieldErrors.confirm = CANCEL_UNCONFIRMED_MESSAGE;
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, body: { reason: values.reason } };
}

/** The commands with nothing to type send nothing but the version. */
export function parseNoForm(): ParsedProjectForm<Record<string, never>, never> {
  return { ok: true, body: {} };
}

export function parseGrantForm(
  values: GrantFormValues,
): ParsedProjectForm<
  { readonly decisionNumber?: string; readonly conditions?: string },
  GrantField
> {
  const parsed = z
    .object({
      decisionNumber: z
        .string()
        .max(
          MAX_DECISION_NUMBER_LENGTH,
          `شماره تصمیم حداکثر ${fa(MAX_DECISION_NUMBER_LENGTH)} نویسه است`,
        ),
      conditions: z
        .string()
        .max(MAX_CONDITIONS_LENGTH, `شرایط حداکثر ${fa(MAX_CONDITIONS_LENGTH)} نویسه است`),
    })
    .safeParse(values);
  if (!parsed.success)
    return { ok: false, fieldErrors: firstIssuePerField(parsed.error, GRANT_FIELDS) };
  return {
    ok: true,
    body: {
      ...(parsed.data.decisionNumber === '' ? {} : { decisionNumber: parsed.data.decisionNumber }),
      ...(parsed.data.conditions === '' ? {} : { conditions: parsed.data.conditions }),
    },
  };
}

export function parseRejectForm(
  values: RejectFormValues,
): ParsedProjectForm<{ readonly reason: string }, RejectField> {
  const reason = z
    .object({ reason: text('دلیل رد', MIN_REASON_LENGTH, MAX_REASON_LENGTH) })
    .safeParse({ reason: values.reason });
  if (!reason.success) {
    return { ok: false, fieldErrors: firstIssuePerField(reason.error, ['reason']) };
  }
  return { ok: true, body: { reason: values.reason } };
}

// ---------------------------------------------------------------------------
// What the service says, in Persian — every documented refusal, in fixed words
// ---------------------------------------------------------------------------

/** 409 `OPTIMISTIC_LOCK_FAILED`: the record moved after the page was drawn, or this very command already ran. */
export const STALE_MESSAGE =
  'پرونده پس از باز شدن این صفحه تغییر کرده است؛ شاید همین کار پیش‌تر انجام شده باشد. این بار چیزی نوشته نشد. صفحه را تازه کنید.';

/** 409 `IDEMPOTENCY_KEY_REUSED`: the submission id was used for a different request. */
export const KEY_REUSED_MESSAGE =
  'این شناسه ارسال پیش‌تر با درخواست دیگری به کار رفته است و این بار چیزی ثبت نشد. این درباره درخواست نخست چیزی نمی‌گوید؛ فهرست پروژه‌ها را ببینید.';

export const BUSINESS_RULE_MESSAGE =
  'این کار با قواعد سامانه سازگار نیست و چیزی ثبت نشد. صفحه را تازه کنید و وضعیت را ببینید.';
export const STATE_MESSAGE =
  'وضعیت فعلی پروژه اجازه این کار را نمی‌دهد و چیزی ثبت نشد. صفحه را تازه کنید و وضعیت را ببینید.';
export const INVALID_INPUT_MESSAGE = 'مقدار واردشده با قواعد سامانه نمی‌خواند؛ آن را اصلاح کنید.';
export const OPERATION_TYPE_NOT_ALLOWED_MESSAGE =
  'نوع عملیات باید یکی از مقادیری باشد که برای این استقرار تعریف شده است.';

/**
 * The reason a request for approval was refused because no approval path
 * exists. The system is closed (docs/24 Q-02, Q-70): nothing is approved by
 * default, and this is said as a state, not as a failure.
 */
export const NO_POLICY_MESSAGE =
  'برای این سازمان سیاست موافقت فعالی برای اجرای پروژه نیست. سامانه بدون سیاست هیچ پروژه‌ای را تأیید نمی‌کند؛ نخست باید یک سیاست موافقت نوشته و فعال شود.';
export const NO_APPLICABLE_STEP_MESSAGE =
  'سیاست موافقت فعال، برای برآورد این پروژه هیچ مرحله‌ای ندارد و سامانه بی مرحله چیزی را تأیید نمی‌کند. برآورد را بررسی کنید یا سیاست را تغییر دهید.';

/**
 * The refusals of the service that carry only a sentence: each is matched whole
 * (`patterns` of `write.ts`) and never shown; the contract spec pins every
 * pattern against the sentence in the service.
 */
export const PROJECT_422_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [
    /^There is no active approval policy for project\.execution in this organization\. The platform never approves by default; a policy setter must activate one first\.$/,
    NO_POLICY_MESSAGE,
  ],
  [
    /^The active approval policy for project\.execution has no step for this project's estimate\. The platform never approves by default\.$/,
    NO_APPLICABLE_STEP_MESSAGE,
  ],
  [
    /^A project needs an estimate before it may request approval \(CONSTRUCTION_APPROVAL_REQUIRES_ESTIMATE\)$/,
    'برای درخواست موافقت، پروژه باید برآورد داشته باشد. برآورد را در ویرایش مشخصات بنویسید.',
  ],
  [
    /^A project needs at least \d+ submitted need\(s\) before it may request approval \(CONSTRUCTION_APPROVAL_MIN_SUBMITTED_NEEDS\)$/,
    'برای درخواست موافقت، پروژه باید دست‌کم شمار لازم نیاز ارسال‌شده داشته باشد. نیازها را ثبت و ارسال کنید.',
  ],
  [
    /^Project \S+ has a tender that is not finished; cancel the tender first$/,
    'این پروژه مناقصه تمام‌نشده دارد. نخست مناقصه را لغو کنید، سپس پروژه را لغو کنید.',
  ],
  [
    /^Project \S+ cannot be cancelled while \S+ in this deployment$/,
    'در این استقرار، پروژه در وضعیت فعلی خود لغو نمی‌شود.',
  ],
  [
    /^This deployment starts a project only under a signed contract, and the contract boundary does not exist yet \(CONSTRUCTION_START_REQUIRES_CONTRACT, CON-003\)$/,
    'این استقرار شروع پروژه را به قرارداد امضاشده مشروط کرده و مرز قرارداد هنوز ساخته نشده است؛ پس شروع پذیرفته نمی‌شود.',
  ],
  [
    /^A project completes only when its latest submitted progress report says 100%$/,
    'پروژه فقط وقتی تکمیل می‌شود که آخرین گزارش پیشرفت ارسال‌شده ۱۰۰٪ باشد. گزارش پیشرفت را بفرستید و دوباره تلاش کنید.',
  ],
  [
    /^A completion approval round is already open for this project$/,
    'دور موافقت تکمیل پیش‌تر باز شده و منتظر تصمیم مرجع است.',
  ],
  [/^Project \S+ is \S+ and cannot change state$/, STATE_MESSAGE],
  [/^Project \S+ cannot move from \S+ to \S+$/, STATE_MESSAGE],
  [
    /^Project \S+ is \S+ and can no longer be edited; only a project in .+ can change$/,
    STATE_MESSAGE,
  ],
  [
    /^Project \S+ is \S+; this approval can no longer be decided$/,
    'پروژه دیگر در وضعیتی نیست که این موافقت تصمیم‌پذیر باشد. صفحه را تازه کنید.',
  ],
  [
    /^Approval \S+ has not been requested yet: an earlier step is still undecided$/,
    'نوبت این مرحله نرسیده است: یک مرحله پیش از آن هنوز تصمیم نگرفته است.',
  ],
  [
    /^Approval \S+ is \S+ and cannot be decided again$/,
    'درباره این مرحله پیش‌تر تصمیم گرفته شده است و دوباره تصمیم‌پذیر نیست. صفحه را تازه کنید.',
  ],
  [
    /^The project no longer reports 100% progress; its completion cannot be granted$/,
    'پروژه دیگر ۱۰۰٪ پیشرفت گزارش نمی‌کند و تکمیل آن موافقت‌پذیر نیست. می‌توانید رد کنید.',
  ],
];

export const PROJECT_VALIDATION_DETAIL_CODES: Readonly<Record<string, string>> = {
  NOT_ALLOWED: OPERATION_TYPE_NOT_ALLOWED_MESSAGE,
};

/** What a form says for a refusal it did not send: forbidden, absent, unavailable. */
export const PROJECT_FORBIDDEN_MESSAGE =
  'اجازه این کار به شما داده نشده است. نقش‌های مجاز نوشتن و خواندن پروژه را تنظیمات استقرار تعیین می‌کند؛ ناظر هیچ‌گاه به پروژه تکی دسترسی ندارد. اگر موافقت یا رد می‌کنید، فقط مرجعی که مرحله به نام اوست تصمیم می‌گیرد.';
export const PROJECT_NOT_FOUND_MESSAGE = 'این پروژه یا مرحله پیدا نشد یا در سازمان فعال شما نیست.';
export const PROJECT_UNAVAILABLE_MESSAGE =
  'سرویس پروژه‌ها همین حالا پاسخ نمی‌دهد و چیزی ثبت نشد. کمی بعد دوباره تلاش کنید.';
export const PROJECT_FAILED_MESSAGE = 'انجام نشد و چیزی تغییر نکرد. می‌توانید دوباره بفرستید.';

/**
 * What a form says when the write was refused before it could act, by the
 * status the gateway answered: `401` (the token ran out), `503` (the service,
 * the gateway or a service it asks is down — nothing was written), anything else.
 */
/**
 * What the create form says when it was left open longer than the service keeps
 * a request's key: nothing was sent, and an earlier press may have made the project.
 */
export const CREATE_EXPIRED_MESSAGE =
  'این فرم مدت زیادی باز مانده و دیگر فرستاده نمی‌شود، چون ممکن است فرستادن پیشین آن پروژه را ساخته باشد. ' +
  'نخست فهرست پروژه‌ها را بررسی کنید. اگر پروژه در فهرست نبود، صفحه را تازه کنید و دوباره ثبت کنید.';

/** An unresolved create exists and this post carries other values than it did. */
export const HELD_CHANGED_MESSAGE =
  'درخواست پیشین این فرم هنوز روشن نشده است و با مقدارهای دیگری فرستاده می‌شد. نمی‌توان آن را با مقدارهای تازه فرستاد: ' +
  'همان مقدارها را دوباره بفرستید، یا پس از بررسی فهرست کامل پروژه‌ها، با پذیرفتن خطر تکرار، درخواست تازه بفرستید.';

/** Another dispatch of this scope is in flight (another tab, a double press): nothing was sent. */
export const HELD_IN_PROGRESS_MESSAGE =
  'درخواست دیگری از این فرم هم‌اکنون در حال فرستاده شدن است (برای نمونه در زبانه دیگر)، پس چیزی فرستاده نشد. ' +
  'چند لحظه صبر کنید، صفحه را تازه کنید و وضعیت را ببینید.';

/** The store of unresolved requests could not be checked: nothing was sent. */
export const PENDING_UNCHECKED_MESSAGE =
  'اکنون نمی‌توان بررسی کرد که درخواست روشن‌نشده‌ای وجود دارد یا نه، پس چیزی فرستاده نشد و فرم ثبت نشان داده نمی‌شود. ' +
  'چند لحظه بعد صفحه را تازه کنید.';

/** This login holds the most unresolved requests allowed. */
export const PENDING_CAPACITY_MESSAGE =
  'شمار درخواست‌های روشن‌نشده این نشست به سقف رسیده است و چیزی فرستاده نشد. ' +
  'نخست درخواست‌های روشن‌نشده را بررسی و رها کنید.';

/** The release form was drawn for a request that has since changed. */
export const RELEASE_STALE_MESSAGE =
  'درخواست روشن‌نشده از زمان باز شدن این صفحه تغییر کرده است و چیزی تغییر نکرد. صفحه را تازه کنید و دوباره بررسی کنید.';

/** An unresolved create exists and this post is a different request. */
export const HELD_OTHER_MESSAGE =
  'درخواست پیشینی هنوز روشن نشده است و درخواست دیگری فرستاده نشد. صفحه را تازه کنید؛ ' +
  'نخست همان درخواست را بفرستید یا پس از بررسی فهرست کامل پروژه‌ها، با پذیرفتن خطر تکرار، درخواست تازه بفرستید.';

/**
 * Whether a refusal status proves the command was not applied. Only a 4xx does:
 * the gateway or the service answered before doing anything. A 5xx may follow a
 * commit — construction-service commits, then reads the record again to answer,
 * and that read can fail, as can the gateway while relaying the answer — so no
 * 5xx (503 included: the portal cannot tell the gateway's from the service's) is
 * "nothing changed". Those are unconfirmed.
 */
export function isProvenRefusalStatus(status: number): boolean {
  return status >= 400 && status < 500;
}

export function projectFailureText(status: number): string {
  if (status === 401) return SESSION_REFUSAL_MESSAGES.NO_SESSION;
  if (status === 503) return PROJECT_UNAVAILABLE_MESSAGE;
  return PROJECT_FAILED_MESSAGE;
}

// ---------------------------------------------------------------------------
// The approval policy, as the page states it
// ---------------------------------------------------------------------------

export const POLICY_CLOSED_TITLE = 'سیاست موافقت فعالی نیست؛ سامانه بسته است';
export const POLICY_CLOSED_TEXT =
  'برای اجرای پروژه‌های این سازمان سیاست موافقت فعالی برقرار نیست و سامانه به‌جای هیچ مرجعی تصمیم نمی‌گیرد. تا وقتی سیاستی نوشته و فعال نشود، هیچ پروژه‌ای به مرحله تأیید نمی‌رسد و درخواست موافقت پذیرفته نمی‌شود. سیاست را مرجع تعیین‌کننده سازمان می‌نویسد و مدیر پلتفرم فعال می‌کند.';
export const POLICY_UNKNOWN_TEXT =
  'وضعیت سیاست موافقت خوانده نشد، پس نمی‌توانیم بگوییم سامانه باز است یا بسته. درخواست موافقت همچنان فرستاده می‌شود و سرویس خودش تصمیم می‌گیرد.';

// ---------------------------------------------------------------------------
// Approvals as a table of words
// ---------------------------------------------------------------------------

export const WORKFLOW_LABELS: Readonly<Record<string, string>> = {
  'project.execution': 'اجرای پروژه',
  'project.completion': 'تکمیل پروژه',
};

export const APPROVAL_STATUS_LABELS: Readonly<Record<string, string>> = {
  QUEUED: 'در صف',
  PENDING: 'منتظر تصمیم',
  GRANTED: 'موافقت شد',
  REJECTED: 'رد شد',
  SUPERSEDED: 'کنار رفت',
};

export function approvalStatusLabel(status: string): string {
  return APPROVAL_STATUS_LABELS[status] ?? status;
}

export function workflowLabel(key: string): string {
  return WORKFLOW_LABELS[key] ?? key;
}

/** Project workflows only: a tender step is decided on its tender's screen. */
export const isProjectWorkflow = (key: string): boolean => key in WORKFLOW_LABELS;
