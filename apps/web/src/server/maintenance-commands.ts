import { ID_PREFIXES, seedIdSchema } from '@rasta/contracts';
import { z } from 'zod';

import { normalizePersianText } from '@/lib/format';
import {
  APPROVE_REQUEST_FIELDS,
  ASSIGN_WORKSHOP_FIELDS,
  CANCEL_REQUEST_FIELDS,
  REPORT_REQUEST_FIELDS,
  type ApproveRequestField,
  type ApproveRequestFormValues,
  type AssignWorkshopField,
  type AssignWorkshopFormValues,
  type CancelRequestField,
  type CancelRequestFormValues,
  type ReportRequestField,
  type ReportRequestFormValues,
} from '@/lib/maintenance-fields';

import { localDateToIso } from './drivers';
import { signPayload, verifyPayload } from './signed-payload';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';
import type { WebSession } from './session';

/**
 * Writing to maintenance-service through the gateway (ADR-058 § 3, ADR-059 § 3).
 *
 * Same split as `drivers.ts`: the form's own schema says what a person may
 * type and in what words a mistake is reported; maintenance-service decides
 * what is true. Every rule here that the service also has — a breakdown needs
 * a severity, planned work has none — is a courtesy that saves a round trip,
 * not the enforcement, and a rule the portal forgets is still refused there.
 */

// ---------------------------------------------------------------------------
// Who is offered the forms
// ---------------------------------------------------------------------------

/**
 * The roles `POST /v1/maintenance-requests` admits
 * (`request.controller.ts`). Wider than the roles that may act on a request
 * afterwards, on purpose: operators and drivers are the people standing at the
 * machine when it stops.
 *
 * A Route Guard as UX, exactly as `canManageDrivers` documents (`docs/16 §
 * ۱۶٫۱۱`): it hides a form nobody in that role could use, and is never the
 * check — maintenance-service refuses again, for a role that lost the right
 * between this render and the submit.
 */
const REPORTER_ROLES: readonly string[] = [
  'ORGANIZATION_ADMIN',
  'FLEET_MANAGER',
  'UNION_ADMIN',
  'OPERATOR',
  'DRIVER',
];

export function canReportMaintenance(effectiveRoles: readonly string[]): boolean {
  return effectiveRoles.some((role) => REPORTER_ROLES.includes(role));
}

// ---------------------------------------------------------------------------
// Report maintenance work
// ---------------------------------------------------------------------------

const assetId = seedIdSchema(ID_PREFIXES.asset);

const MAINTENANCE_TYPES = ['PREVENTIVE', 'CORRECTIVE'] as const;
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

/** `YYYY-MM-DD` from a `type="date"` input becomes an instant, or nothing. */
const optionalLocalDate = z.string().transform((raw, ctx) => {
  if (raw.trim() === '') return undefined;
  const iso = localDateToIso(raw);
  if (iso === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'تاریخ معتبر نیست' });
    return z.NEVER;
  }
  return iso;
});

export function reportRequestFormValues(form: FormData): ReportRequestFormValues {
  const values: Record<ReportRequestField, string> = {
    assetId: '',
    type: '',
    title: '',
    description: '',
    severity: '',
    outOfServiceAt: '',
    dueDate: '',
  };
  for (const field of REPORT_REQUEST_FIELDS) {
    const raw = form.get(field);
    values[field] = typeof raw === 'string' ? raw : '';
  }
  return values;
}

export const reportRequestFormSchema = z
  .object({
    assetId: z
      .string()
      .trim()
      .min(1, 'شناسهٔ ماشین را وارد کنید')
      .refine((value) => assetId.safeParse(value).success, 'شناسهٔ ماشین معتبر نیست'),
    type: z.enum(MAINTENANCE_TYPES, { errorMap: () => ({ message: 'نوع کار را انتخاب کنید' }) }),
    title: z
      .string()
      .transform((raw) => normalizePersianText(raw))
      .pipe(z.string().min(2, 'عنوان دست‌کم ۲ نویسه باشد').max(200, 'عنوان حداکثر ۲۰۰ نویسه است')),
    description: z
      .string()
      .transform((raw) => normalizePersianText(raw))
      .pipe(z.string().max(2000, 'شرح حداکثر ۲۰۰۰ نویسه است'))
      .transform((value) => (value === '' ? undefined : value)),
    severity: z
      .string()
      .trim()
      .transform((value) => (value === '' ? undefined : value))
      .pipe(
        z
          .enum(SEVERITIES, { errorMap: () => ({ message: 'شدت را از فهرست انتخاب کنید' }) })
          .optional(),
      ),
    outOfServiceAt: optionalLocalDate,
    dueDate: optionalLocalDate,
  })
  .strict()
  // The service's own two rules, worded for the person at the form.
  .refine((value) => value.type !== 'CORRECTIVE' || value.severity !== undefined, {
    message: 'برای خرابی، شدت را مشخص کنید',
    path: ['severity'],
  })
  .refine((value) => value.type !== 'PREVENTIVE' || value.severity === undefined, {
    message: 'شدت فقط برای خرابی است؛ برای کار برنامه‌ای خالی بگذارید',
    path: ['severity'],
  });

/** What maintenance-service accepts on `POST /v1/maintenance-requests`. */
export type ReportRequestBody = z.infer<typeof reportRequestFormSchema>;

export type ParsedReportRequestForm =
  | { readonly ok: true; readonly request: ReportRequestBody }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<ReportRequestField, string>> };

export function parseReportRequestForm(values: ReportRequestFormValues): ParsedReportRequestForm {
  const parsed = reportRequestFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, request: parsed.data };

  const fieldErrors: Partial<Record<ReportRequestField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && isReportRequestField(field) && !fieldErrors[field]) {
      fieldErrors[field] = issue.message;
    }
  }
  return { ok: false, fieldErrors };
}

function isReportRequestField(value: string): value is ReportRequestField {
  return (REPORT_REQUEST_FIELDS as readonly string[]).includes(value);
}

/**
 * The service's sentences this portal knows how to say in Persian. One it does
 * not know is shown as it arrived (`mapProblemToFields`) — visibly foreign,
 * never hidden, because the service's sentence is the truth and a stale
 * dictionary is not.
 */
export const REPORT_REQUEST_FIELD_MAPPING: FieldMapping<ReportRequestField> = {
  paths: {
    assetId: 'assetId',
    type: 'type',
    title: 'title',
    description: 'description',
    severity: 'severity',
    outOfServiceAt: 'outOfServiceAt',
    dueDate: 'dueDate',
  },
  messages: {
    'A corrective request records a failure, so it must state a severity':
      'برای خرابی، شدت را مشخص کنید',
    'Severity describes a failure and does not apply to planned maintenance':
      'شدت فقط برای خرابی است؛ برای کار برنامه‌ای خالی بگذارید',
    'This machine already has an open request of that kind. Add to it, or close it first.':
      'این ماشین همین حالا یک درخواست باز از همین نوع دارد. به همان اضافه کنید یا نخست آن را ببندید.',
    'Maintenance cannot be reported for a future moment.': 'گزارش برای زمان آینده پذیرفته نیست',
    'The machine has been transferred to another organization; this work cannot go ahead.':
      'این ماشین به سازمان دیگری منتقل شده است و کار نمی‌تواند پیش برود.',
    'This machine is being transferred to another organization; raise the work after the transfer.':
      'این ماشین در حال انتقال به سازمان دیگری است؛ کار را پس از انتقال ثبت کنید.',
  },
};

/** Only the id is needed: the page the person lands on reads the rest. */
const reportedRequestSchema = z.object({ id: z.string().min(1) });

export type ReportedRequest = z.infer<typeof reportedRequestSchema>;

export function reportMaintenanceRequest(
  session: WebSession,
  request: ReportRequestBody,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<ReportedRequest, ReportRequestField>> {
  return writeThroughGateway(session, {
    path: '/v1/maintenance-requests',
    body: request,
    submissionId,
    schema: reportedRequestSchema,
    mapping: REPORT_REQUEST_FIELD_MAPPING,
    fetchImpl,
  });
}

// ---------------------------------------------------------------------------
// Commands on a request: refer to a workshop, approve the cost, cancel
// ---------------------------------------------------------------------------

/**
 * The roles `assign`, `approve` and `cancel` admit (`request.controller.ts`):
 * the ones that can commit the organization to a cost. Narrower than the
 * reporters on purpose — an operator may raise a fault and may not refer it on,
 * approve what it cost, or abandon it.
 *
 * A Route Guard as UX, like `canReportMaintenance`: it hides three forms nobody
 * in another role could use, and maintenance-service refuses again.
 */
const MANAGER_ROLES: readonly string[] = ['ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN'];

export function canManageMaintenance(effectiveRoles: readonly string[]): boolean {
  return effectiveRoles.some((role) => MANAGER_ROLES.includes(role));
}

/**
 * The service's own `displayText` character class, which it applies to every
 * free-text field of these three commands. A copy, because the portal may not
 * import a service (A-02); `maintenance-commands.contract.spec.ts` fails the
 * moment the two disagree. Letters of the Arabic and Latin scripts, digits of
 * any script, combining marks, spaces, ZWNJ and a short list of punctuation.
 */
export const MAINTENANCE_DISPLAY_TEXT =
  /^[\p{Script=Arabic}\p{Script=Latin}\p{Nd}\p{Mark}\s\u200c()«»'’\-.,/:+]+$/u;

const DISPLAY_TEXT_MESSAGE = 'فقط حروف فارسی و لاتین، عدد و نشانه‌های ساده مجاز است';

const organizationId = seedIdSchema(ID_PREFIXES.organization);
const requestId = seedIdSchema(ID_PREFIXES.maintenanceRequest);

/** The request a command is about, from the form; nothing else about it is trusted. */
export function commandRequestId(form: FormData): string | null {
  const raw = form.get('requestId');
  return typeof raw === 'string' && requestId.safeParse(raw.trim()).success ? raw.trim() : null;
}

/** Text that may be left empty, which then says nothing at all. */
function optionalText(label: string, max: number) {
  return z
    .string()
    .transform((raw) => normalizePersianText(raw))
    .pipe(
      z
        .string()
        .max(max, `${label} حداکثر ${max} نویسه است`)
        .refine(
          (value) => value === '' || MAINTENANCE_DISPLAY_TEXT.test(value),
          DISPLAY_TEXT_MESSAGE,
        ),
    )
    .transform((value) => (value === '' ? undefined : value));
}

function readFields<F extends string>(form: FormData, fields: readonly F[]): Record<F, string> {
  const values = {} as Record<F, string>;
  for (const field of fields) {
    const raw = form.get(field);
    values[field] = typeof raw === 'string' ? raw : '';
  }
  return values;
}

function firstIssues<F extends string>(
  error: z.ZodError,
  fields: readonly F[],
): Partial<Record<F, string>> {
  const fieldErrors: Partial<Record<F, string>> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && (fields as readonly string[]).includes(field)) {
      const key = field as F;
      if (!fieldErrors[key]) fieldErrors[key] = issue.message;
    }
  }
  return fieldErrors;
}

// ---- Refer to a workshop ---------------------------------------------------

export function assignWorkshopFormValues(form: FormData): AssignWorkshopFormValues {
  return readFields(form, ASSIGN_WORKSHOP_FIELDS);
}

export const assignWorkshopFormSchema = z
  .object({
    workshopOrganizationId: z
      .string()
      .trim()
      .min(1, 'شناسهٔ سازمان تعمیرگاه را وارد کنید')
      .refine((value) => organizationId.safeParse(value).success, 'شناسهٔ سازمان معتبر نیست'),
    workshopName: optionalText('نام تعمیرگاه', 200).refine(
      (value) => value === undefined || value.length >= 2,
      'نام تعمیرگاه دست‌کم ۲ نویسه باشد',
    ),
    workSummary: optionalText('شرح کار', 1000).refine(
      (value) => value === undefined || value.length >= 2,
      'شرح کار دست‌کم ۲ نویسه باشد',
    ),
  })
  .strict();

/** What maintenance-service accepts on `POST /v1/maintenance-requests/{id}/assign`. */
export type AssignWorkshopBody = z.infer<typeof assignWorkshopFormSchema>;

export type ParsedAssignWorkshopForm =
  | { readonly ok: true; readonly body: AssignWorkshopBody }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<AssignWorkshopField, string>> };

export function parseAssignWorkshopForm(
  values: AssignWorkshopFormValues,
): ParsedAssignWorkshopForm {
  const parsed = assignWorkshopFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, body: parsed.data };
  return { ok: false, fieldErrors: firstIssues(parsed.error, ASSIGN_WORKSHOP_FIELDS) };
}

/**
 * Sentences shared by the commands that move a request: a race with someone
 * else's change, and a machine that changed hands. A sentence the portal does
 * not know is shown as it arrived (`mapProblemToFields`).
 */
const REQUEST_STATE_MESSAGES: Readonly<Record<string, string>> = {
  'This maintenance request is already APPROVED':
    'این درخواست همین حالا تأیید شده و نهایی است؛ دیگر تغییر نمی‌کند.',
  'This maintenance request is already CANCELLED':
    'این درخواست همین حالا لغو شده و نهایی است؛ درخواست تازه‌ای ثبت کنید.',
  'An approved maintenance request is final; it authorises settlement and cannot be reopened':
    'این درخواست تأیید شده و نهایی است؛ دیگر تغییر نمی‌کند.',
  'A cancelled maintenance request is final; raise a new one':
    'این درخواست لغو شده و نهایی است؛ درخواست تازه‌ای ثبت کنید.',
  'This request was already approved or cancelled by another request':
    'همین حالا کس دیگری این درخواست را تأیید یا لغو کرد. صفحه را تازه کنید.',
  'The machine has been transferred to another organization; this work cannot go ahead.':
    'این ماشین به سازمان دیگری منتقل شده است و کار نمی‌تواند پیش برود.',
  'This machine is being transferred to another organization; raise the work after the transfer.':
    'این ماشین در حال انتقال به سازمان دیگری است؛ کار را پس از انتقال انجام دهید.',
};

/**
 * What is said for a refusal whose sentence the portal does not know — a state
 * the service words one more way, or a rule added after this was written —
 * keyed by the platform error code, which is the part of the body a client may
 * rely on. The sentence itself is not shown: the service's English is the truth
 * but not a thing this screen's reader can act on, and the correlation id on the
 * failure banner is how it is found.
 */
const REQUEST_STATE_FALLBACKS: Readonly<Record<string, string>> = {
  INVALID_STATE_TRANSITION:
    'وضعیت فعلی درخواست اجازهٔ این کار را نمی‌دهد. صفحه را تازه کنید و وضعیت را ببینید.',
  BUSINESS_RULE_VIOLATION: 'این کار با قواعد این درخواست سازگار نیست. صفحه را تازه کنید.',
};

export const ASSIGN_WORKSHOP_FIELD_MAPPING: FieldMapping<AssignWorkshopField> = {
  paths: {
    workshopOrganizationId: 'workshopOrganizationId',
    workshopName: 'workshopName',
    workSummary: 'workSummary',
  },
  messages: {
    ...REQUEST_STATE_MESSAGES,
    'Contains unsupported characters': DISPLAY_TEXT_MESSAGE,
    'This request is already with a workshop. Cancel that referral before making another.':
      'این درخواست همین حالا نزد یک تعمیرگاه است. برای ارجاع به جای دیگر، نخست آن ارجاع را لغو کنید.',
    'That workshop may not take on this work.': 'این تعمیرگاه نمی‌تواند این کار را بپذیرد.',
  },
  byCode: REQUEST_STATE_FALLBACKS,
};

/** What a caller needs of the created referral: only that it exists. */
const commandAnswerSchema = z.object({ id: z.string().min(1) });

export function assignWorkshop(
  session: WebSession,
  id: string,
  body: AssignWorkshopBody,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<z.infer<typeof commandAnswerSchema>, AssignWorkshopField>> {
  return writeThroughGateway(session, {
    path: `/v1/maintenance-requests/${encodeURIComponent(id)}/assign`,
    body,
    submissionId,
    schema: commandAnswerSchema,
    mapping: ASSIGN_WORKSHOP_FIELD_MAPPING,
    fetchImpl,
  });
}

// ---- Approve the cost ------------------------------------------------------

export function approveRequestFormValues(form: FormData): ApproveRequestFormValues {
  return readFields(form, APPROVE_REQUEST_FIELDS);
}

export const approveRequestFormSchema = z
  .object({
    // Required here and, since this change, by the service too: an approval
    // that does not say what it approves is not the control docs/17 makes
    // mandatory. The action fills it from the signed approval baseline, never
    // from the browser (`openApprovalBaseline`).
    expectedTotalCostMinor: z
      .string()
      .trim()
      .regex(/^\d{1,30}$/, 'مبلغ نمایش‌داده‌شده معتبر نیست؛ صفحه را تازه کنید'),
    notes: optionalText('یادداشت', 1000),
  })
  .strict();

/** What maintenance-service accepts on `POST /v1/maintenance-requests/{id}/approve`. */
export type ApproveRequestBody = z.infer<typeof approveRequestFormSchema>;

export type ParsedApproveRequestForm =
  | { readonly ok: true; readonly body: ApproveRequestBody }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<ApproveRequestField, string>> };

export function parseApproveRequestForm(
  values: ApproveRequestFormValues,
): ParsedApproveRequestForm {
  const parsed = approveRequestFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, body: parsed.data };
  return { ok: false, fieldErrors: firstIssues(parsed.error, APPROVE_REQUEST_FIELDS) };
}

/**
 * Said when the total moved between the screen and the button. The action
 * recognises it by this exact text and sends the person back to a page that
 * shows the new figure; the service's sentence is matched in
 * `APPROVE_REQUEST_FIELD_MAPPING` and pinned by the contract spec, because the
 * platform's error body carries no rule code a client may read.
 */
export const APPROVAL_TOTAL_CHANGED_MESSAGE =
  'هزینه از زمانی که نمایش داده شد تغییر کرده است؛ مبلغ تازه را ببینید و دوباره تأیید کنید.';

export const APPROVE_REQUEST_FIELD_MAPPING: FieldMapping<ApproveRequestField> = {
  paths: { expectedTotalCostMinor: 'expectedTotalCostMinor', notes: 'notes' },
  messages: {
    ...REQUEST_STATE_MESSAGES,
    'Contains unsupported characters': DISPLAY_TEXT_MESSAGE,
    'The cost has changed since it was shown to you; review it again before approving.':
      APPROVAL_TOTAL_CHANGED_MESSAGE,
  },
  byCode: REQUEST_STATE_FALLBACKS,
};

export function approveRequest(
  session: WebSession,
  id: string,
  body: ApproveRequestBody,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<z.infer<typeof commandAnswerSchema>, ApproveRequestField>> {
  return writeThroughGateway(session, {
    path: `/v1/maintenance-requests/${encodeURIComponent(id)}/approve`,
    body,
    submissionId,
    schema: commandAnswerSchema,
    mapping: APPROVE_REQUEST_FIELD_MAPPING,
    fetchImpl,
  });
}

// ---- What the approval was drawn from --------------------------------------

const APPROVAL_BASELINE_PURPOSE = 'maintenance-approval-baseline';

/**
 * A page left open while a decision is made is still a page; one left open
 * overnight is not. The service compares the total again on every approval, so
 * this bounds how stale a *confirmation* can be, not how stale a figure can be.
 */
const APPROVAL_BASELINE_TTL_SECONDS = 4 * 60 * 60;

const approvalBaselineSchema = z.object({
  requestId: z.string().min(1).max(200),
  totalCostMinor: z.string().regex(/^\d{1,30}$/),
});

export interface ApprovalBaseline {
  readonly requestId: string;
  readonly totalCostMinor: string;
}

/**
 * The request and the total the approval button was drawn beside, signed for
 * this session and carried in a hidden field.
 *
 * The approval confirms **this** request at **this** amount, so both are taken
 * from here and neither from the form: a hidden `requestId` and a hidden total
 * are fields a script can rewrite, and a form that could name request B with
 * B's own total would confirm an amount its manager never saw. Signed, the only
 * thing the browser controls is whether to press the button (and the note).
 *
 * maintenance-service exposes no version for a request, so there is none to
 * bind; the status guard and the total comparison it applies on every approval
 * are what cover a request that changed after this page was drawn.
 */
export function sealApprovalBaseline(
  session: WebSession,
  requestId: string,
  totalCostMinor: string,
): string {
  return signPayload(
    session,
    APPROVAL_BASELINE_PURPOSE,
    { requestId, totalCostMinor },
    APPROVAL_BASELINE_TTL_SECONDS,
  );
}

/**
 * The baseline, if `token` is one this session was given for `requestId`;
 * otherwise `null` — one answer for forged, somebody else's, expired, and for
 * another request.
 */
export function openApprovalBaseline(
  session: WebSession,
  token: unknown,
  requestId: string,
): ApprovalBaseline | null {
  const payload = verifyPayload(session, APPROVAL_BASELINE_PURPOSE, token, approvalBaselineSchema);
  if (!payload || payload.requestId !== requestId) return null;
  return { requestId: payload.requestId, totalCostMinor: payload.totalCostMinor };
}

// ---- Cancel ----------------------------------------------------------------

export function cancelRequestFormValues(form: FormData): CancelRequestFormValues {
  return readFields(form, CANCEL_REQUEST_FIELDS);
}

export const cancelRequestFormSchema = z
  .object({
    reason: z
      .string()
      .transform((raw) => normalizePersianText(raw))
      .pipe(
        z
          .string()
          .min(3, 'دلیل لغو دست‌کم ۳ نویسه باشد')
          .max(500, 'دلیل لغو حداکثر ۵۰۰ نویسه است')
          .refine((value) => MAINTENANCE_DISPLAY_TEXT.test(value), DISPLAY_TEXT_MESSAGE),
      ),
  })
  .strict();

/** What maintenance-service accepts on `POST /v1/maintenance-requests/{id}/cancel`. */
export type CancelRequestBody = z.infer<typeof cancelRequestFormSchema>;

export type ParsedCancelRequestForm =
  | { readonly ok: true; readonly body: CancelRequestBody }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<CancelRequestField, string>> };

export function parseCancelRequestForm(values: CancelRequestFormValues): ParsedCancelRequestForm {
  const parsed = cancelRequestFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, body: parsed.data };
  return { ok: false, fieldErrors: firstIssues(parsed.error, CANCEL_REQUEST_FIELDS) };
}

export const CANCEL_REQUEST_FIELD_MAPPING: FieldMapping<CancelRequestField> = {
  paths: { reason: 'reason' },
  messages: {
    ...REQUEST_STATE_MESSAGES,
    'Contains unsupported characters': DISPLAY_TEXT_MESSAGE,
  },
  byCode: REQUEST_STATE_FALLBACKS,
};

export function cancelRequest(
  session: WebSession,
  id: string,
  body: CancelRequestBody,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<z.infer<typeof commandAnswerSchema>, CancelRequestField>> {
  return writeThroughGateway(session, {
    path: `/v1/maintenance-requests/${encodeURIComponent(id)}/cancel`,
    body,
    submissionId,
    schema: commandAnswerSchema,
    mapping: CANCEL_REQUEST_FIELD_MAPPING,
    fetchImpl,
  });
}
