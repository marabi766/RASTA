import { TZDate } from '@date-fns/tz';
import { ID_PREFIXES, seedIdSchema } from '@rasta/contracts';
import { z } from 'zod';

import { DISPLAY_TIME_ZONE, normalizePersianText, toLatinDigits } from '@/lib/format';
import {
  CHANGE_STATUS_FIELDS,
  CREATE_DRIVER_FIELDS,
  UPDATE_DRIVER_FIELDS,
  type ChangeStatusField,
  type ChangeStatusFormValues,
  type CreateDriverField,
  type CreateDriverFormValues,
  type UpdateDriverField,
  type UpdateDriverFormValues,
} from '@/lib/driver-fields';

import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import type { WebSession } from './session';
import type { ReadResult } from './assets';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';

export { fetchDriverAssignments } from './assignments';
export type { AssignmentPage, AssignmentSummary } from './assignments';
// Re-exported so a screen needs one import for both this module's results and
// `assets.ts`'s — the shape is identical, and only one module should define it
// (same convention `maintenance.ts` follows).
export type { ReadResult };

/**
 * Reading and writing drivers through the gateway (ADR-058 § 3, ADR-059 § 3).
 *
 * Same shape as `assets.ts` and `maintenance.ts` for the reads, and
 * `usage.ts` for the writes — this module designs nothing new, it is the
 * second and third time each pattern is applied. The schemas keep only what
 * a screen renders; a 403/404/409 arrives as an outcome to render, never a
 * rule re-implemented here (`docs/16 § ۱۶٫۱۱`).
 */

// ---------------------------------------------------------------------------
// Who may write a driver or an assignment
// ---------------------------------------------------------------------------

/**
 * The roles fleet-service's own `@Roles` guard lets write a driver or an
 * assignment (`driver.controller.ts`, `assignment.controller.ts`). `DRIVER`
 * and `OPERATOR` may read but never write, including their own record.
 *
 * The screen reads this to decide which forms to render — a Route Guard as
 * UX, explicitly not as security (`docs/16 § ۱۶٫۱۱`): fleet-service applies
 * its own guard again on every write regardless of what this function said,
 * and a caller whose identity read failed sees no write form rather than one
 * that might work.
 */
const DRIVER_MANAGEMENT_ROLES: readonly string[] = [
  'ORGANIZATION_ADMIN',
  'FLEET_MANAGER',
  'UNION_ADMIN',
];

export function canManageDrivers(effectiveRoles: readonly string[]): boolean {
  return effectiveRoles.some((role) => DRIVER_MANAGEMENT_ROLES.includes(role));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const driverSummarySchema = z.object({
  id: z.string(),
  userId: z.string(),
  employeeNo: z.string().nullable().default(null),
  licenceNumber: z.string().nullable().default(null),
  licenceClass: z.string().nullable().default(null),
  licenceValidTo: z.string().nullable().default(null),
  status: z.string(),
});

export type DriverSummary = z.infer<typeof driverSummarySchema>;

const driverPageSchema = z.object({
  items: z.array(driverSummarySchema),
  nextCursor: z.string().nullable().default(null),
  hasMore: z.boolean().default(false),
});

export type DriverPage = z.infer<typeof driverPageSchema>;

const driverDetailSchema = driverSummarySchema.extend({
  statusReason: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type DriverDetail = z.infer<typeof driverDetailSchema>;

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

export interface DriverListQuery {
  readonly status?: string;
  readonly q?: string;
  readonly cursor?: string;
}

/** How many rows one page shows. The service caps it far higher; this is a screen. */
export const DRIVERS_PER_PAGE = 20;

export function fetchDrivers(
  session: WebSession,
  query: DriverListQuery = {},
): Promise<ReadResult<DriverPage>> {
  const params = new URLSearchParams({ limit: String(DRIVERS_PER_PAGE) });
  // Only what the caller actually set — an empty filter is a filter nobody
  // asked for.
  if (query.status) params.set('status', query.status);
  if (query.q) params.set('q', query.q);
  if (query.cursor) params.set('cursor', query.cursor);

  return read(session, `/v1/drivers?${params.toString()}`, driverPageSchema);
}

export function fetchDriver(
  session: WebSession,
  driverId: string,
): Promise<ReadResult<DriverDetail>> {
  // The id goes in a path segment, so it is encoded rather than interpolated:
  // an id containing a slash would otherwise address a different endpoint.
  return read(session, `/v1/drivers/${encodeURIComponent(driverId)}`, driverDetailSchema);
}

// ---------------------------------------------------------------------------
// Shared: dates and free text
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` (what `type="date"` produces), read as Tehran midnight. */
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A licence expiry has no meaningful time of day. Reading it as Tehran
 * midnight rather than UTC midnight keeps it on the calendar day a Persian
 * reader actually picked — UTC midnight is already the previous evening in
 * Tehran, which would silently move the date back by one.
 */
function localDateToIso(raw: string, timeZone = DISPLAY_TIME_ZONE): string | null {
  const match = LOCAL_DATE.exec(toLatinDigits(raw).trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const instant = new TZDate(Number(year), Number(month) - 1, Number(day), 0, 0, 0, timeZone);
  if (Number.isNaN(instant.getTime())) return null;
  if (instant.getMonth() !== Number(month) - 1 || instant.getDate() !== Number(day)) return null;
  return new Date(instant.getTime()).toISOString();
}

/**
 * The inverse of {@link localDateToIso}: the calendar day an instant falls on
 * in `timeZone`, as `YYYY-MM-DD` — what `type="date"` expects as a starting
 * value.
 *
 * Slicing the ISO string's first ten characters instead would read the *UTC*
 * calendar day, which for a Tehran evening instant is the day before the one
 * `localDateToIso` was given. A licence expiry saved as `2027-01-01` round
 * trips through the edit form as `2026-12-31T20:30:00.000Z` on the wire, and
 * a naive slice would then pre-fill the form with `2026-12-31` — one day
 * earlier than what was actually stored, moving the date back again on the
 * next save that touches any other field (docs/16 § 16.3).
 */
export function localDateFromIso(iso: string, timeZone = DISPLAY_TIME_ZONE): string {
  const local = new TZDate(new Date(iso), timeZone);
  const year = String(local.getFullYear()).padStart(4, '0');
  const month = String(local.getMonth() + 1).padStart(2, '0');
  const day = String(local.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const optionalLocalDate = z
  .string()
  .transform((raw, ctx) => {
    if (raw.trim() === '') return undefined;
    const iso = localDateToIso(raw);
    if (iso === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'تاریخ معتبر نیست' });
      return z.NEVER;
    }
    return iso;
  })
  .optional();

/**
 * A licence expiry, but where blank must reach the service as `null` rather
 * than being omitted — this is the *edit* form, always pre-filled with the
 * driver's current values, so a blank field the person did not touch is a
 * blank field that was already null. Omitting it would leave the service
 * unable to tell "unchanged and blank" from "unchanged and set".
 */
const nullableLocalDate = z.string().transform((raw, ctx) => {
  if (raw.trim() === '') return null;
  const iso = localDateToIso(raw);
  if (iso === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'تاریخ معتبر نیست' });
    return z.NEVER;
  }
  return iso;
});

/**
 * Bidi control characters — the whole Unicode `Bidi_Control` set: ALM, LRM
 * and RLM, the embeddings and overrides, the isolates — refused in short
 * free-text identifiers.
 *
 * The Unicode property rather than a list (Codex post-merge review of #106):
 * the hand-written list this replaces had eleven of the twelve and missed
 * U+061C ARABIC LETTER MARK — in a Persian-first portal, the one most likely
 * to arrive by paste. `\p{Bidi_Control}` is the Unicode Character Database's
 * own definition, so it cannot fall behind a new version of it, and it holds
 * no invisible character in source for a reviewer to miss.
 *
 * fleet-service accepts these unchanged today — it checks only length and
 * trim (`dto.ts`) — and a value carrying one can be rendered to look like a
 * different identifier than what was actually typed: exactly the deception a
 * fleet manager comparing an employee number or a licence class against a
 * paper record must not be exposed to. The portal is one of several clients
 * that can write these fields, so refusing here narrows the surface rather
 * than closing it — the service-side check is a separate fix.
 */
export const BIDI_CONTROL = /\p{Bidi_Control}/u;
const BIDI_CONTROL_MESSAGE = 'این فیلد نویسهٔ جهت‌دهی نامرئی نمی‌پذیرد';

const nullableShortText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .refine((value) => !BIDI_CONTROL.test(value), BIDI_CONTROL_MESSAGE)
    .transform((value) => (value === '' ? null : value))
    .pipe(z.string().max(max, message).nullable());

const nullableNotes = z
  .string()
  .transform((raw) => normalizePersianText(raw))
  .pipe(z.string().max(1000, 'یادداشت حداکثر ۱۰۰۰ نویسه است'))
  .transform((value) => (value === '' ? null : value));

// ---------------------------------------------------------------------------
// Register a driver
// ---------------------------------------------------------------------------

const userId = seedIdSchema(ID_PREFIXES.user);

export function createDriverFormValues(form: FormData): CreateDriverFormValues {
  const values: Record<CreateDriverField, string> = {
    userId: '',
    employeeNo: '',
    licenceNumber: '',
    licenceClass: '',
    licenceValidTo: '',
    notes: '',
  };
  for (const field of CREATE_DRIVER_FIELDS) {
    const raw = form.get(field);
    values[field] = typeof raw === 'string' ? raw : '';
  }
  return values;
}

export const createDriverFormSchema = z
  .object({
    userId: z
      .string()
      .min(1, 'شناسهٔ کاربر را وارد کنید')
      .refine((value) => userId.safeParse(value).success, 'شناسهٔ کاربر معتبر نیست'),
    employeeNo: z
      .string()
      .trim()
      .refine((value) => !BIDI_CONTROL.test(value), BIDI_CONTROL_MESSAGE)
      .pipe(z.string().max(64, 'شمارهٔ پرسنلی حداکثر ۶۴ نویسه است'))
      .transform((value) => (value === '' ? undefined : value)),
    licenceNumber: z
      .string()
      .trim()
      .refine((value) => !BIDI_CONTROL.test(value), BIDI_CONTROL_MESSAGE)
      .pipe(z.string().max(64, 'شمارهٔ گواهینامه حداکثر ۶۴ نویسه است'))
      .transform((value) => (value === '' ? undefined : value)),
    licenceClass: z
      .string()
      .trim()
      .refine((value) => !BIDI_CONTROL.test(value), BIDI_CONTROL_MESSAGE)
      .pipe(z.string().max(32, 'پایهٔ گواهینامه حداکثر ۳۲ نویسه است'))
      .transform((value) => (value === '' ? undefined : value)),
    licenceValidTo: optionalLocalDate,
    notes: z
      .string()
      .transform((raw) => normalizePersianText(raw))
      .pipe(z.string().max(1000, 'یادداشت حداکثر ۱۰۰۰ نویسه است'))
      .transform((value) => (value === '' ? undefined : value)),
  })
  .strict();

/** What fleet-service accepts on `POST /v1/drivers`. */
export type CreateDriverRequest = z.infer<typeof createDriverFormSchema>;

export type ParsedCreateDriverForm =
  | { readonly ok: true; readonly request: CreateDriverRequest }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<CreateDriverField, string>> };

export function parseCreateDriverForm(values: CreateDriverFormValues): ParsedCreateDriverForm {
  const parsed = createDriverFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, request: parsed.data };

  const fieldErrors: Partial<Record<CreateDriverField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (
      typeof field === 'string' &&
      isCreateDriverField(field) &&
      fieldErrors[field] === undefined
    ) {
      fieldErrors[field] = issue.message;
    }
  }
  return { ok: false, fieldErrors };
}

function isCreateDriverField(value: string): value is CreateDriverField {
  return (CREATE_DRIVER_FIELDS as readonly string[]).includes(value);
}

export const CREATE_DRIVER_FIELD_MAPPING: FieldMapping<CreateDriverField> = {
  paths: {
    userId: 'userId',
    employeeNo: 'employeeNo',
    licenceNumber: 'licenceNumber',
    licenceClass: 'licenceClass',
    licenceValidTo: 'licenceValidTo',
    notes: 'notes',
  },
  messages: {
    'Driver already exists': 'این کاربر پیش‌تر در این سازمان به‌عنوان راننده ثبت شده است',
  },
};

export function createDriver(
  session: WebSession,
  request: CreateDriverRequest,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<DriverDetail, CreateDriverField>> {
  return writeThroughGateway(session, {
    path: '/v1/drivers',
    body: request,
    submissionId,
    schema: driverDetailSchema,
    mapping: CREATE_DRIVER_FIELD_MAPPING,
    fetchImpl,
  });
}

// ---------------------------------------------------------------------------
// Edit a driver
// ---------------------------------------------------------------------------

export function updateDriverFormValues(form: FormData): UpdateDriverFormValues {
  const values: Record<UpdateDriverField, string> = {
    employeeNo: '',
    licenceNumber: '',
    licenceClass: '',
    licenceValidTo: '',
    notes: '',
  };
  for (const field of UPDATE_DRIVER_FIELDS) {
    const raw = form.get(field);
    values[field] = typeof raw === 'string' ? raw : '';
  }
  return values;
}

/**
 * Every field, always present, always either a value or `null` — never
 * omitted. This form always shows the driver's current record, so "the
 * person left this blank" and "this was already blank" are the same signal:
 * send `null`. fleet-service's own semantics (`dto.field !== undefined`)
 * reserve *omission* for "an API caller did not mean to touch this field",
 * which a form that always renders every field can never honestly claim.
 */
export const updateDriverFormSchema = z
  .object({
    employeeNo: nullableShortText(64, 'شمارهٔ پرسنلی حداکثر ۶۴ نویسه است'),
    licenceNumber: nullableShortText(64, 'شمارهٔ گواهینامه حداکثر ۶۴ نویسه است'),
    licenceClass: nullableShortText(32, 'پایهٔ گواهینامه حداکثر ۳۲ نویسه است'),
    licenceValidTo: nullableLocalDate,
    notes: nullableNotes,
  })
  .strict();

/** What fleet-service accepts on `PATCH /v1/drivers/{id}`. */
export type UpdateDriverRequest = z.infer<typeof updateDriverFormSchema>;

export type ParsedUpdateDriverForm =
  | { readonly ok: true; readonly request: UpdateDriverRequest }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<UpdateDriverField, string>> };

export function parseUpdateDriverForm(values: UpdateDriverFormValues): ParsedUpdateDriverForm {
  const parsed = updateDriverFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, request: parsed.data };

  const fieldErrors: Partial<Record<UpdateDriverField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (
      typeof field === 'string' &&
      isUpdateDriverField(field) &&
      fieldErrors[field] === undefined
    ) {
      fieldErrors[field] = issue.message;
    }
  }
  return { ok: false, fieldErrors };
}

function isUpdateDriverField(value: string): value is UpdateDriverField {
  return (UPDATE_DRIVER_FIELDS as readonly string[]).includes(value);
}

export const UPDATE_DRIVER_FIELD_MAPPING: FieldMapping<UpdateDriverField> = {
  paths: {
    employeeNo: 'employeeNo',
    licenceNumber: 'licenceNumber',
    licenceClass: 'licenceClass',
    licenceValidTo: 'licenceValidTo',
    notes: 'notes',
  },
  messages: {
    'Driver was modified by another request; reload and retry':
      'این رکورد را درخواستی دیگر تغییر داد؛ صفحه را تازه کنید و دوباره تلاش کنید',
    'A deactivated driver is a historical record and cannot be edited':
      'راننده‌ای که از رده خارج شده سابقه‌ای تاریخی است و ویرایش نمی‌شود',
  },
};

export function updateDriver(
  session: WebSession,
  driverId: string,
  request: UpdateDriverRequest,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<DriverDetail, UpdateDriverField>> {
  return writeThroughGateway(session, {
    path: `/v1/drivers/${encodeURIComponent(driverId)}`,
    method: 'PATCH',
    body: request,
    submissionId,
    schema: driverDetailSchema,
    mapping: UPDATE_DRIVER_FIELD_MAPPING,
    fetchImpl,
  });
}

// ---------------------------------------------------------------------------
// Change status
// ---------------------------------------------------------------------------

const DRIVER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;

export function changeStatusFormValues(form: FormData): ChangeStatusFormValues {
  const values: Record<ChangeStatusField, string> = { status: '', reason: '' };
  for (const field of CHANGE_STATUS_FIELDS) {
    const raw = form.get(field);
    values[field] = typeof raw === 'string' ? raw : '';
  }
  return values;
}

export const changeStatusFormSchema = z
  .object({
    status: z.enum(DRIVER_STATUSES, { errorMap: () => ({ message: 'وضعیت را انتخاب کنید' }) }),
    // Required, not optional. A driver barred from work without a recorded
    // reason is a decision nobody can review later (AGENTS.md S-06).
    reason: z
      .string()
      .transform((raw) => normalizePersianText(raw))
      .pipe(z.string().min(3, 'دلیل را بنویسید').max(500, 'دلیل حداکثر ۵۰۰ نویسه است')),
  })
  .strict();

/** What fleet-service accepts on `POST /v1/drivers/{id}/status`. */
export type ChangeStatusRequest = z.infer<typeof changeStatusFormSchema>;

export type ParsedChangeStatusForm =
  | { readonly ok: true; readonly request: ChangeStatusRequest }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<ChangeStatusField, string>> };

export function parseChangeStatusForm(values: ChangeStatusFormValues): ParsedChangeStatusForm {
  const parsed = changeStatusFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, request: parsed.data };

  const fieldErrors: Partial<Record<ChangeStatusField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (
      typeof field === 'string' &&
      isChangeStatusField(field) &&
      fieldErrors[field] === undefined
    ) {
      fieldErrors[field] = issue.message;
    }
  }
  return { ok: false, fieldErrors };
}

function isChangeStatusField(value: string): value is ChangeStatusField {
  return (CHANGE_STATUS_FIELDS as readonly string[]).includes(value);
}

/**
 * `invalidStateTransition`'s message is templated per pair of states
 * (`A driver cannot move from ${from} to ${to}`), so most of its variants
 * cannot be pre-translated exactly — shown as they arrive, which is honest
 * rather than a guess. The two fixed sentences are worth translating because
 * every caller sees exactly them.
 */
export const CHANGE_STATUS_FIELD_MAPPING: FieldMapping<ChangeStatusField> = {
  paths: { status: 'status', reason: 'reason' },
  messages: {
    'Driver was modified by another request; reload and retry':
      'این رکورد را درخواستی دیگر تغییر داد؛ صفحه را تازه کنید و دوباره تلاش کنید',
    'A deactivated driver is terminal; register a new driver record instead':
      'راننده‌ای که از رده خارج شده نهایی است؛ به‌جای آن رانندهٔ تازه ثبت کنید',
  },
};

export function changeDriverStatus(
  session: WebSession,
  driverId: string,
  request: ChangeStatusRequest,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<DriverDetail, ChangeStatusField>> {
  return writeThroughGateway(session, {
    path: `/v1/drivers/${encodeURIComponent(driverId)}/status`,
    body: request,
    submissionId,
    schema: driverDetailSchema,
    mapping: CHANGE_STATUS_FIELD_MAPPING,
    fetchImpl,
  });
}
