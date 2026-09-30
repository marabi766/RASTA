import { ID_PREFIXES, seedIdSchema } from '@rasta/contracts';
import { z } from 'zod';

import { normalizePersianText } from '@/lib/format';
import {
  REPORT_REQUEST_FIELDS,
  type ReportRequestField,
  type ReportRequestFormValues,
} from '@/lib/maintenance-fields';

import { localDateToIso } from './drivers';
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
