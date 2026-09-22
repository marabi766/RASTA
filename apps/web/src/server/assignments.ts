import { ID_PREFIXES, seedIdSchema } from '@rasta/contracts';
import { z } from 'zod';

import { normalizePersianText } from '@/lib/format';
import {
  ASSIGN_DRIVER_FIELDS,
  END_ASSIGNMENT_FIELDS,
  type AssignDriverField,
  type AssignDriverFormValues,
  type EndAssignmentField,
  type EndAssignmentFormValues,
} from '@/lib/driver-fields';

import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import type { WebSession } from './session';
import type { ReadResult } from './assets';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';
import { localDateTimeToIso } from './usage';

/**
 * Putting a driver in charge of a machine, and taking them off it, through
 * the gateway (ADR-058 § 3, ADR-059 § 3).
 *
 * Reached only from a driver's own detail page (`/drivers/[id]`) — docs/16
 * § ۱۶٫۶ names no `/assignments` route, and `assignment.controller.ts`'s own
 * comment explains why the path is `/v1/assignments` rather than nested under
 * an asset: an assignment belongs to fleet, not to the asset it names.
 *
 * fleet-service enforces exclusivity with partial unique indexes on both
 * sides — one driver, one live assignment; one machine, one live assignment —
 * so unlike `usage-records` this domain needs no `clientReference` dedupe at
 * the record level. The submission id still travels as `Idempotency-Key` for
 * the plain HTTP-retry case (docs/06 § 6.8); the database index is what makes
 * a genuine double-assignment impossible either way.
 */

const assetId = seedIdSchema(ID_PREFIXES.asset);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const assignmentSummarySchema = z.object({
  id: z.string(),
  driverId: z.string(),
  assetId: z.string(),
  active: z.boolean(),
  startedAt: z.string(),
  endedAt: z.string().nullable().default(null),
  purpose: z.string().nullable().default(null),
  endReason: z.string().nullable().default(null),
  endNotes: z.string().nullable().default(null),
});

export type AssignmentSummary = z.infer<typeof assignmentSummarySchema>;

const assignmentPageSchema = z.object({
  items: z.array(assignmentSummarySchema),
  nextCursor: z.string().nullable().default(null),
  hasMore: z.boolean().default(false),
});

export type AssignmentPage = z.infer<typeof assignmentPageSchema>;

async function read<S extends z.ZodTypeAny>(
  session: WebSession,
  path: string,
  schema: S,
): Promise<ReadResult<z.infer<S>>> {
  try {
    const response = await callGateway<unknown>({
      baseUrl: webServerEnv().API_GATEWAY_URL,
      path,
      accessToken: session.accessToken,
    });

    const parsed = schema.safeParse(response.data);
    if (!parsed.success) return { kind: 'MALFORMED', correlationId: response.correlationId };
    return { kind: 'OK', data: parsed.data };
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      if (error.status === 403) return { kind: 'FORBIDDEN' };
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

/** How many rows one page shows. The service caps it far higher; this is a screen. */
export const ASSIGNMENTS_PER_PAGE = 20;

/**
 * A driver's assignment history, newest first — via `GET
 * /v1/drivers/{id}/assignments`, the endpoint `DriverController` exposes for
 * exactly this screen. At most one entry has `active: true` (the exclusivity
 * index), which is how the detail screen tells the current assignment from
 * the history around it without a second request.
 */
export function fetchDriverAssignments(
  session: WebSession,
  driverIdValue: string,
  cursor?: string,
): Promise<ReadResult<AssignmentPage>> {
  const params = new URLSearchParams({ limit: String(ASSIGNMENTS_PER_PAGE) });
  if (cursor) params.set('cursor', cursor);
  return read(
    session,
    `/v1/drivers/${encodeURIComponent(driverIdValue)}/assignments?${params.toString()}`,
    assignmentPageSchema,
  );
}

// ---------------------------------------------------------------------------
// Assign a driver to a machine
// ---------------------------------------------------------------------------

export function assignFormValues(form: FormData): AssignDriverFormValues {
  const values: Record<AssignDriverField, string> = {
    assetId: '',
    startedAt: '',
    purpose: '',
  };
  for (const field of ASSIGN_DRIVER_FIELDS) {
    const raw = form.get(field);
    values[field] = typeof raw === 'string' ? raw : '';
  }
  return values;
}

/**
 * `localDateTimeToIso` is `usage.ts`'s, imported rather than re-derived: a
 * `datetime-local` reading with no zone means Tehran, the zone the whole
 * portal displays in, and the platform stores UTC instants (CLAUDE.md) —
 * exactly the same fact whether the form is recording usage or an assignment.
 */
const optionalLocalDateTime = z
  .string()
  .transform((raw, ctx) => {
    if (raw.trim() === '') return undefined;
    const iso = localDateTimeToIso(raw);
    if (iso === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'تاریخ یا ساعت معتبر نیست' });
      return z.NEVER;
    }
    return iso;
  })
  .optional();

export const assignFormSchema = z
  .object({
    assetId: z
      .string()
      .min(1, 'ماشین را انتخاب کنید')
      .refine((value) => assetId.safeParse(value).success, 'شناسهٔ ماشین معتبر نیست'),
    // Blank means "now" — the common case — not a value the service must
    // parse; the transform below turns that into an absent field.
    startedAt: optionalLocalDateTime,
    purpose: z
      .string()
      .transform((raw) => normalizePersianText(raw))
      .pipe(z.string().max(500, 'هدف حداکثر ۵۰۰ نویسه است'))
      .transform((value) => (value === '' ? undefined : value)),
  })
  .strict();

/** What fleet-service accepts on `POST /v1/assignments`. */
export type AssignRequest = z.infer<typeof assignFormSchema> & { readonly driverId: string };

export type ParsedAssignForm =
  | { readonly ok: true; readonly request: AssignRequest }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<AssignDriverField, string>> };

/**
 * `driverIdValue` is trusted, not form content: it is bound to the server
 * action from the page's own route param, the same way `submissionId`
 * reaches `parseUsageForm` — a value the form did not collect and a person
 * could not have edited.
 */
export function parseAssignForm(
  values: AssignDriverFormValues,
  driverIdValue: string,
): ParsedAssignForm {
  const parsed = assignFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, request: { ...parsed.data, driverId: driverIdValue } };

  const fieldErrors: Partial<Record<AssignDriverField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && isAssignField(field) && fieldErrors[field] === undefined) {
      fieldErrors[field] = issue.message;
    }
  }
  return { ok: false, fieldErrors };
}

function isAssignField(value: string): value is AssignDriverField {
  return (ASSIGN_DRIVER_FIELDS as readonly string[]).includes(value);
}

/**
 * Where an assignment-creation detail lands, and how its sentence reads in
 * Persian. Two of assignment.service.ts's rules — `A ${status} driver…` and
 * `A machine in state ${status}…` — are templated with a live value, so they
 * cannot be pre-translated exactly; shown as they arrive, per this module's
 * general policy of never guessing at a sentence the service did not send.
 */
export const ASSIGN_FIELD_MAPPING: FieldMapping<AssignDriverField> = {
  paths: { assetId: 'assetId', startedAt: 'startedAt', purpose: 'purpose' },
  messages: {
    'This driver already holds an active assignment. End it before starting another.':
      'این راننده هم‌اکنون یک تخصیص فعال دارد. پیش از تخصیص تازه، آن را پایان دهید',
    'This machine is already assigned to a driver. End that assignment first.':
      'این ماشین هم‌اکنون به راننده‌ای دیگر تخصیص دارد. ابتدا آن تخصیص را پایان دهید',
    'This machine has been withdrawn from dispatch and cannot be assigned.':
      'این ماشین از اعزام خارج شده و قابل تخصیص نیست',
    'This machine is in maintenance and cannot be assigned.':
      'این ماشین در حال تعمیر است و قابل تخصیص نیست',
    'An assignment cannot start in the future; scheduling is not modelled.':
      'تخصیص نمی‌تواند در آینده آغاز شود',
  },
};

export function createAssignment(
  session: WebSession,
  request: AssignRequest,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<AssignmentSummary, AssignDriverField>> {
  return writeThroughGateway(session, {
    path: '/v1/assignments',
    body: request,
    submissionId,
    schema: assignmentSummarySchema,
    mapping: ASSIGN_FIELD_MAPPING,
    fetchImpl,
  });
}

// ---------------------------------------------------------------------------
// End an assignment
// ---------------------------------------------------------------------------

export function endAssignmentFormValues(form: FormData): EndAssignmentFormValues {
  const values: Record<EndAssignmentField, string> = { reason: 'COMPLETED', notes: '' };
  for (const field of END_ASSIGNMENT_FIELDS) {
    const raw = form.get(field);
    values[field] = typeof raw === 'string' ? raw : field === 'reason' ? 'COMPLETED' : '';
  }
  return values;
}

const ASSIGNMENT_END_REASONS = [
  'COMPLETED',
  'CANCELLED',
  'DRIVER_UNAVAILABLE',
  'ASSET_UNAVAILABLE',
  'REASSIGNED',
] as const;

export const endAssignmentFormSchema = z
  .object({
    reason: z.enum(ASSIGNMENT_END_REASONS).catch('COMPLETED' as const),
    notes: z
      .string()
      .transform((raw) => normalizePersianText(raw))
      .pipe(z.string().max(500, 'یادداشت حداکثر ۵۰۰ نویسه است'))
      .transform((value) => (value === '' ? undefined : value)),
  })
  .strict();

export type EndAssignmentRequest = z.infer<typeof endAssignmentFormSchema>;

export type ParsedEndAssignmentForm =
  | { readonly ok: true; readonly request: EndAssignmentRequest }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<EndAssignmentField, string>> };

export function parseEndAssignmentForm(values: EndAssignmentFormValues): ParsedEndAssignmentForm {
  const parsed = endAssignmentFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, request: parsed.data };

  const fieldErrors: Partial<Record<EndAssignmentField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (
      typeof field === 'string' &&
      isEndAssignmentField(field) &&
      fieldErrors[field] === undefined
    ) {
      fieldErrors[field] = issue.message;
    }
  }
  return { ok: false, fieldErrors };
}

function isEndAssignmentField(value: string): value is EndAssignmentField {
  return (END_ASSIGNMENT_FIELDS as readonly string[]).includes(value);
}

export const END_ASSIGNMENT_FIELD_MAPPING: FieldMapping<EndAssignmentField> = {
  paths: { reason: 'reason', notes: 'notes' },
  messages: {
    'This assignment has already ended': 'این تخصیص پیش‌تر پایان یافته است',
    'This assignment was ended by another request':
      'این تخصیص هم‌اکنون توسط درخواست دیگری پایان یافت',
    'An assignment cannot end before it started.': 'پایان تخصیص نمی‌تواند پیش از آغاز آن باشد',
  },
};

export function endAssignment(
  session: WebSession,
  assignmentId: string,
  request: EndAssignmentRequest,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<AssignmentSummary, EndAssignmentField>> {
  return writeThroughGateway(session, {
    path: `/v1/assignments/${encodeURIComponent(assignmentId)}/end`,
    body: request,
    submissionId,
    schema: assignmentSummarySchema,
    mapping: END_ASSIGNMENT_FIELD_MAPPING,
    fetchImpl,
  });
}
