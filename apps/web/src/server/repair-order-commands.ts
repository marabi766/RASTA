import { ID_PREFIXES, WITHOUT_CONTROL_CHARACTER, seedIdSchema } from '@rasta/contracts';
import { z } from 'zod';

import {
  IRR,
  MoneyInputError,
  PERSIAN_DECIMAL_SEPARATOR,
  PERSIAN_THOUSANDS_SEPARATOR,
  ZWNJ,
  normalizePersianText,
  parseMoneyInput,
  toLatinDigits,
} from '@/lib/format';
import {
  CANCEL_REPAIR_FIELDS,
  COMPLETE_REPAIR_FIELDS,
  DIRECT_COST_CATEGORIES,
  MAX_AMOUNT_MINOR,
  PART_SOURCES,
  RECORD_COST_FIELDS,
  RECORD_LABOUR_FIELDS,
  RECORD_PART_FIELDS,
  REPAIR_COMMANDS,
  START_REPAIR_FIELDS,
  type CancelRepairField,
  type CancelRepairFormValues,
  type CompleteRepairField,
  type CompleteRepairFormValues,
  type RecordCostField,
  type RecordCostFormValues,
  type RecordLabourField,
  type RecordLabourFormValues,
  type RecordPartField,
  type RecordPartFormValues,
  type RepairCommandName,
  type StartRepairField,
  type StartRepairFormValues,
} from '@/lib/repair-order-fields';

import {
  DISPLAY_TEXT_MESSAGE,
  MAINTENANCE_DISPLAY_TEXT,
  REQUEST_STATE_MESSAGES,
  commandAnswerSchema,
  firstIssues,
  optionalText,
  readFields,
} from './maintenance-commands';
import { BIDI_CONTROL } from './drivers';
import { signPayload, verifyPayload } from './signed-payload';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';
import type { WebSession } from './session';

/**
 * Writing to a repair order through the gateway (ADR-058 § 3, ADR-059 § 3).
 *
 * The same split as `maintenance-commands.ts`: the form's own schema says what
 * a person may type and in what words a mistake is reported;
 * maintenance-service decides what is true. Who may use the forms is
 * `canManageMaintenance` there — the six endpoints admit the same three roles
 * as the request's own commands (`repair-order.controller.ts`, pinned by the
 * contract spec).
 *
 * ## The order a command acts on
 *
 * Not a field of any form. The page signs `{request, order, command, total}`
 * for this session (`sealRepairOrderBaseline`) and the action takes the order
 * from that token alone, so a form whose hidden fields were rewritten to name
 * another order has nothing to name it with. The service is still the check on
 * whether the person may touch that order at all; this is what makes the portal
 * act on the order it drew the button beside.
 */

// ---------------------------------------------------------------------------
// What a person types
// ---------------------------------------------------------------------------

const NOT_A_NUMBER = 'عدد معتبر وارد کنید';

/**
 * A positive decimal typed as a string, in any digits and with either decimal
 * mark, handed on as a Latin-digit string — never through a `number`, because
 * the service stores it in a `NUMERIC` column and a float round-trip is the
 * drift the column type exists to prevent. `maxDecimals` and `maxIntegerDigits`
 * are the service's own bounds (`partQuantity`, `quantity(6)` in its dto.ts).
 */
function positiveQuantity(label: string, maxDecimals: number, maxIntegerDigits: number) {
  return z
    .string()
    .transform((raw) =>
      toLatinDigits(raw)
        .split(PERSIAN_DECIMAL_SEPARATOR)
        .join('.')
        .replace(new RegExp(`[\\s${PERSIAN_THOUSANDS_SEPARATOR},${ZWNJ}]`, 'g'), ''),
    )
    .pipe(
      z
        .string()
        .min(1, `${label} را وارد کنید`)
        .regex(new RegExp(`^\\d+(\\.\\d{1,${maxDecimals}})?$`), NOT_A_NUMBER)
        .refine(
          (value) => (value.split('.')[0] ?? '').length <= maxIntegerDigits,
          `${label} بیش از حد بزرگ است`,
        )
        .refine((value) => /[1-9]/.test(value), `${label} باید بیشتر از صفر باشد`),
    );
}

/**
 * An amount in rials, typed in any digits with any grouping, as the minor-unit
 * string the service reads (Latin digits, no larger than the ledger's bound).
 * `parseMoneyInput` is the portal's one reader of a typed amount.
 */
function rialAmount(label: string, options: { readonly allowZero: boolean }) {
  return z.string().transform((raw, ctx): string => {
    const text = raw.trim();
    if (text === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} را وارد کنید` });
      return z.NEVER;
    }
    let minor: bigint;
    try {
      minor = parseMoneyInput(text, IRR);
    } catch (cause) {
      if (cause instanceof MoneyInputError) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: cause.message });
        return z.NEVER;
      }
      throw cause;
    }
    if (minor < 0n || (minor === 0n && !options.allowZero)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: options.allowZero
          ? `${label} نمی‌تواند منفی باشد`
          : `${label} باید بیشتر از صفر باشد`,
      });
      return z.NEVER;
    }
    // The ledger's own bound (BIGINT), not the platform's 30 digits: an amount
    // past it passes the schema and then fails in the database.
    if (minor > BigInt(MAX_AMOUNT_MINOR)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} بیش از حد بزرگ است` });
      return z.NEVER;
    }
    return minor.toString();
  });
}

/** Required display text, the service's `displayText(min, max)`. */
function requiredText(label: string, min: number, max: number) {
  return z
    .string()
    .transform((raw) => normalizePersianText(raw))
    .pipe(
      z
        .string()
        .min(min, `${label} دست‌کم ${min} نویسه باشد`)
        .max(max, `${label} حداکثر ${max} نویسه است`)
        .refine(
          (value) => value === '' || MAINTENANCE_DISPLAY_TEXT.test(value),
          DISPLAY_TEXT_MESSAGE,
        ),
    );
}

const BIDI_CONTROL_MESSAGE = 'این فیلد نویسهٔ جهت‌دهی نامرئی نمی‌پذیرد';
const REFERENCE_CONTROL_MESSAGE = 'شناسه نویسهٔ نامرئی، نیم‌فاصله یا شکست خط نمی‌پذیرد';

/**
 * An optional reference, up to 128 characters, empty meaning none — the
 * service's `referenceId()`: an identifier in another system, not prose, so
 * besides the Unicode `Bidi_Control` set it refuses every other control or
 * format character, ZWNJ included, which would make two references look alike
 * that are not. The bidi refusal speaks first, in the words every other form
 * uses; the wider set is the platform's own pattern from `@rasta/contracts`,
 * the one the service applies, so the two cannot drift.
 */
function optionalReference(label: string) {
  return z
    .string()
    .trim()
    .max(128, `${label} حداکثر ۱۲۸ نویسه است`)
    .refine((value) => !BIDI_CONTROL.test(value), BIDI_CONTROL_MESSAGE)
    .refine((value) => WITHOUT_CONTROL_CHARACTER.test(value), REFERENCE_CONTROL_MESSAGE)
    .transform((value) => (value === '' ? undefined : value));
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export function startRepairFormValues(form: FormData): StartRepairFormValues {
  return readFields(form, START_REPAIR_FIELDS);
}

export const startRepairFormSchema = z
  .object({
    workSummary: optionalText('شرح کار', 1000).refine(
      (value) => value === undefined || value.length >= 2,
      'شرح کار دست‌کم ۲ نویسه باشد',
    ),
  })
  .strict();

/** What maintenance-service accepts on `POST /v1/repair-orders/{id}/start`. */
export type StartRepairBody = z.infer<typeof startRepairFormSchema>;

export type ParsedRepairForm<B, F extends string> =
  | { readonly ok: true; readonly body: B }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<F, string>> };

export function parseStartRepairForm(
  values: StartRepairFormValues,
): ParsedRepairForm<StartRepairBody, StartRepairField> {
  const parsed = startRepairFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, body: parsed.data };
  return { ok: false, fieldErrors: firstIssues(parsed.error, START_REPAIR_FIELDS) };
}

// ---------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------

export function completeRepairFormValues(form: FormData): CompleteRepairFormValues {
  return readFields(form, COMPLETE_REPAIR_FIELDS);
}

export const completeRepairFormSchema = z
  .object({ workPerformed: requiredText('شرح کار انجام‌شده', 2, 2000) })
  .strict();

export type CompleteRepairBody = z.infer<typeof completeRepairFormSchema>;

export function parseCompleteRepairForm(
  values: CompleteRepairFormValues,
): ParsedRepairForm<CompleteRepairBody, CompleteRepairField> {
  const parsed = completeRepairFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, body: parsed.data };
  return { ok: false, fieldErrors: firstIssues(parsed.error, COMPLETE_REPAIR_FIELDS) };
}

/**
 * Said when the order's total moved between the screen and the button. The
 * action recognises it by this exact text and sends the person back to a page
 * that shows the new figure, as `APPROVAL_TOTAL_CHANGED_MESSAGE` does for the
 * approval; the service's sentence is pinned by the contract spec.
 */
export const REPAIR_TOTAL_CHANGED_MESSAGE =
  'هزینهٔ این ارجاع از زمانی که نمایش داده شد تغییر کرده است؛ مبلغ تازه را ببینید و دوباره تکمیل کنید.';

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export function cancelRepairFormValues(form: FormData): CancelRepairFormValues {
  return readFields(form, CANCEL_REPAIR_FIELDS);
}

export const cancelRepairFormSchema = z
  .object({ reason: requiredText('دلیل لغو', 3, 500) })
  .strict();

export type CancelRepairBody = z.infer<typeof cancelRepairFormSchema>;

export function parseCancelRepairForm(
  values: CancelRepairFormValues,
): ParsedRepairForm<CancelRepairBody, CancelRepairField> {
  const parsed = cancelRepairFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, body: parsed.data };
  return { ok: false, fieldErrors: firstIssues(parsed.error, CANCEL_REPAIR_FIELDS) };
}

// ---------------------------------------------------------------------------
// A part
// ---------------------------------------------------------------------------

export function recordPartFormValues(form: FormData): RecordPartFormValues {
  return readFields(form, RECORD_PART_FIELDS);
}

export const recordPartFormSchema = z
  .object({
    partName: requiredText('نام قطعه', 2, 200),
    partReference: optionalReference('شناسهٔ قطعه'),
    quantity: positiveQuantity('تعداد', 3, 9),
    unit: requiredText('واحد', 1, 32),
    unitCostMinor: rialAmount('بهای واحد', { allowZero: true }),
    source: z.enum(PART_SOURCES, { errorMap: () => ({ message: 'منبع قطعه را انتخاب کنید' }) }),
    sourceReference: optionalReference('ارجاع منبع'),
  })
  .strict();

/** What maintenance-service accepts on `POST /v1/repair-orders/{id}/parts`. */
export type RecordPartBody = z.infer<typeof recordPartFormSchema>;

export function parseRecordPartForm(
  values: RecordPartFormValues,
): ParsedRepairForm<RecordPartBody, RecordPartField> {
  const parsed = recordPartFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, body: parsed.data };
  return { ok: false, fieldErrors: firstIssues(parsed.error, RECORD_PART_FIELDS) };
}

// ---------------------------------------------------------------------------
// Labour
// ---------------------------------------------------------------------------

export function recordLabourFormValues(form: FormData): RecordLabourFormValues {
  return readFields(form, RECORD_LABOUR_FIELDS);
}

export const recordLabourFormSchema = z
  .object({
    description: requiredText('شرح کار', 2, 500),
    technician: optionalText('نام تعمیرکار', 120).refine(
      (value) => value === undefined || value.length >= 2,
      'نام تعمیرکار دست‌کم ۲ نویسه باشد',
    ),
    hours: positiveQuantity('ساعت کار', 2, 6),
    hourlyRateMinor: rialAmount('نرخ ساعتی', { allowZero: true }),
  })
  .strict();

/** What maintenance-service accepts on `POST /v1/repair-orders/{id}/labour`. */
export type RecordLabourBody = z.infer<typeof recordLabourFormSchema>;

export function parseRecordLabourForm(
  values: RecordLabourFormValues,
): ParsedRepairForm<RecordLabourBody, RecordLabourField> {
  const parsed = recordLabourFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, body: parsed.data };
  return { ok: false, fieldErrors: firstIssues(parsed.error, RECORD_LABOUR_FIELDS) };
}

// ---------------------------------------------------------------------------
// Any other cost
// ---------------------------------------------------------------------------

export function recordCostFormValues(form: FormData): RecordCostFormValues {
  return readFields(form, RECORD_COST_FIELDS);
}

export const recordCostFormSchema = z
  .object({
    category: z.enum(DIRECT_COST_CATEGORIES, {
      errorMap: () => ({ message: 'نوع هزینه را از فهرست انتخاب کنید' }),
    }),
    amountMinor: rialAmount('مبلغ', { allowZero: false }),
    description: requiredText('شرح هزینه', 2, 500),
  })
  .strict();

/** What maintenance-service accepts on `POST /v1/repair-orders/{id}/costs`. */
export type RecordCostBody = z.infer<typeof recordCostFormSchema>;

export function parseRecordCostForm(
  values: RecordCostFormValues,
): ParsedRepairForm<RecordCostBody, RecordCostField> {
  const parsed = recordCostFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, body: parsed.data };
  return { ok: false, fieldErrors: firstIssues(parsed.error, RECORD_COST_FIELDS) };
}

// ---------------------------------------------------------------------------
// What the service says, in Persian
// ---------------------------------------------------------------------------

/**
 * The sentences about a repair order this portal says in Persian, beside the
 * request-level ones it shares (`REQUEST_STATE_MESSAGES`). A sentence it does
 * not know falls to `REPAIR_STATE_FALLBACKS` by platform code, and one with no
 * fallback is shown as it arrived (`mapProblemToFields`).
 */
const REPAIR_MESSAGES: Readonly<Record<string, string>> = {
  ...REQUEST_STATE_MESSAGES,
  'Contains unsupported characters': DISPLAY_TEXT_MESSAGE,
  'This repair order is already IN_PROGRESS':
    'این ارجاع همین حالا آغاز شده است. صفحه را تازه کنید.',
  'This repair order is already COMPLETED':
    'این ارجاع همین حالا تکمیل شده و نهایی است؛ دیگر تغییر نمی‌کند.',
  'This repair order is already CANCELLED':
    'این ارجاع همین حالا لغو شده است. اگر کار هنوز لازم است، آن را به تعمیرگاه دیگری ارجاع دهید.',
  'A repair order cannot move from OPEN to COMPLETED':
    'تعمیر هنوز آغاز نشده است؛ نخست آن را آغاز کنید.',
  'A completed repair order is final; its cost has already been reported':
    'این ارجاع تکمیل شده و نهایی است؛ هزینهٔ آن گزارش شده و دیگر تغییر نمی‌کند.',
  'A cancelled repair order is final; refer the request to another workshop':
    'این ارجاع لغو شده است؛ کار را به تعمیرگاه دیگری ارجاع دهید.',
  'This repair order was started or cancelled by another request':
    'همین حالا کس دیگری این ارجاع را آغاز یا لغو کرد. صفحه را تازه کنید.',
  'This repair order was completed or cancelled by another request':
    'همین حالا کس دیگری این ارجاع را تکمیل یا لغو کرد. صفحه را تازه کنید.',
  'This repair order was changed by another request':
    'همین حالا کس دیگری این ارجاع را تغییر داد. صفحه را تازه کنید.',
  'This request was changed by another request':
    'همین حالا کس دیگری این درخواست را تغییر داد. صفحه را تازه کنید.',
  'A repair cannot start before it was referred.': 'تعمیر نمی‌تواند پیش از ارجاع آغاز شده باشد.',
  'A repair cannot finish before it started.': 'تعمیر نمی‌تواند پیش از آغاز آن پایان یافته باشد.',
  'Cost cannot be added to a completed repair order.':
    'این ارجاع تکمیل شده است و دیگر هزینه‌ای به آن افزوده نمی‌شود.',
  'Cost cannot be added to a cancelled repair order.':
    'این ارجاع لغو شده است و دیگر هزینه‌ای به آن افزوده نمی‌شود.',
  'That quantity cannot be priced.':
    'با این تعداد نمی‌توان بها را حساب کرد؛ تعداد یا بهای واحد را کوچک‌تر کنید.',
  'Those hours cannot be priced.':
    'با این ساعت نمی‌توان بها را حساب کرد؛ ساعت یا نرخ را کوچک‌تر کنید.',
  'A cost must be in the same currency as the repair order.':
    'واحد پول هزینه باید با واحد پول ارجاع یکی باشد.',
  'That amount is larger than the maximum this system can hold.':
    'این مبلغ از بیشینهٔ مبلغی که سامانه نگه می‌دارد بزرگ‌تر است.',
  'That line is larger than the maximum this system can hold; reduce the quantity or the price.':
    'جمع این ردیف از بیشینهٔ مبلغ سامانه بزرگ‌تر می‌شود؛ تعداد یا بها را کمتر کنید.',
  'The total would be larger than the maximum this system can hold; nothing was recorded.':
    'با این ردیف، جمع هزینه از بیشینهٔ مبلغ سامانه بزرگ‌تر می‌شود؛ چیزی ثبت نشد.',
  'Amount is larger than the maximum this system can hold (9223372036854775807)':
    'این مبلغ از بیشینهٔ مبلغ سامانه بزرگ‌تر است.',
  'Quantity must be greater than zero': 'تعداد باید بیشتر از صفر باشد',
  'Labour hours must be greater than zero': 'ساعت کار باید بیشتر از صفر باشد',
  'A cost of zero records nothing; omit the line instead': 'مبلغ باید بیشتر از صفر باشد',
  'The cost has changed since it was shown to you; review it again before completing.':
    REPAIR_TOTAL_CHANGED_MESSAGE,
};

/** What is said for a refusal whose sentence the portal does not know, by platform code. */
const REPAIR_STATE_FALLBACKS: Readonly<Record<string, string>> = {
  INVALID_STATE_TRANSITION:
    'وضعیت فعلی این ارجاع اجازهٔ این کار را نمی‌دهد. صفحه را تازه کنید و وضعیت را ببینید.',
  BUSINESS_RULE_VIOLATION: 'این کار با قواعد این ارجاع سازگار نیست. صفحه را تازه کنید.',
};

function mappingOf<F extends string>(paths: Record<string, F>): FieldMapping<F> {
  return { paths, messages: REPAIR_MESSAGES, byCode: REPAIR_STATE_FALLBACKS };
}

export const START_REPAIR_FIELD_MAPPING = mappingOf<StartRepairField>({
  workSummary: 'workSummary',
});
export const COMPLETE_REPAIR_FIELD_MAPPING = mappingOf<CompleteRepairField>({
  workPerformed: 'workPerformed',
});
export const CANCEL_REPAIR_FIELD_MAPPING = mappingOf<CancelRepairField>({ reason: 'reason' });
export const RECORD_PART_FIELD_MAPPING = mappingOf<RecordPartField>({
  partName: 'partName',
  partReference: 'partReference',
  quantity: 'quantity',
  unit: 'unit',
  unitCostMinor: 'unitCostMinor',
  source: 'source',
  sourceReference: 'sourceReference',
});
export const RECORD_LABOUR_FIELD_MAPPING = mappingOf<RecordLabourField>({
  description: 'description',
  technician: 'technician',
  hours: 'hours',
  hourlyRateMinor: 'hourlyRateMinor',
});
export const RECORD_COST_FIELD_MAPPING = mappingOf<RecordCostField>({
  category: 'category',
  amountMinor: 'amountMinor',
  description: 'description',
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

type Answer = z.infer<typeof commandAnswerSchema>;

function post<F extends string, B>(
  session: WebSession,
  orderId: string,
  action: string,
  body: B,
  submissionId: string,
  mapping: FieldMapping<F>,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<Answer, F>> {
  return writeThroughGateway(session, {
    // The id goes in a path segment, so it is encoded rather than interpolated.
    path: `/v1/repair-orders/${encodeURIComponent(orderId)}/${action}`,
    body,
    submissionId,
    schema: commandAnswerSchema,
    mapping,
    fetchImpl,
  });
}

export const startRepair = (
  session: WebSession,
  orderId: string,
  body: StartRepairBody,
  submissionId: string,
  fetchImpl?: typeof fetch,
) => post(session, orderId, 'start', body, submissionId, START_REPAIR_FIELD_MAPPING, fetchImpl);

/** `expectedTotalCostMinor` is the order total the page showed; the service refuses if it moved. */
export const completeRepair = (
  session: WebSession,
  orderId: string,
  body: CompleteRepairBody & { readonly expectedTotalCostMinor: string },
  submissionId: string,
  fetchImpl?: typeof fetch,
) =>
  post(session, orderId, 'complete', body, submissionId, COMPLETE_REPAIR_FIELD_MAPPING, fetchImpl);

export const cancelRepair = (
  session: WebSession,
  orderId: string,
  body: CancelRepairBody,
  submissionId: string,
  fetchImpl?: typeof fetch,
) => post(session, orderId, 'cancel', body, submissionId, CANCEL_REPAIR_FIELD_MAPPING, fetchImpl);

export const recordPart = (
  session: WebSession,
  orderId: string,
  body: RecordPartBody,
  submissionId: string,
  fetchImpl?: typeof fetch,
) => post(session, orderId, 'parts', body, submissionId, RECORD_PART_FIELD_MAPPING, fetchImpl);

export const recordLabour = (
  session: WebSession,
  orderId: string,
  body: RecordLabourBody,
  submissionId: string,
  fetchImpl?: typeof fetch,
) => post(session, orderId, 'labour', body, submissionId, RECORD_LABOUR_FIELD_MAPPING, fetchImpl);

export const recordCost = (
  session: WebSession,
  orderId: string,
  body: RecordCostBody,
  submissionId: string,
  fetchImpl?: typeof fetch,
) => post(session, orderId, 'costs', body, submissionId, RECORD_COST_FIELD_MAPPING, fetchImpl);

// ---------------------------------------------------------------------------
// What a command was drawn from
// ---------------------------------------------------------------------------

const REPAIR_ORDER_BASELINE_PURPOSE = 'repair-order-baseline';

/**
 * As long as the approval's (`maintenance-commands.ts`): a page left open while
 * a workshop is phoned is still a page; one left overnight is not. Only the
 * completion's total is compared again by the service on every send, so this
 * bounds how stale a *confirmation* can be, not how stale a figure can be.
 */
const REPAIR_ORDER_BASELINE_TTL_SECONDS = 4 * 60 * 60;

const repairOrderBaselineSchema = z.object({
  requestId: z.string().min(1).max(200),
  repairOrderId: z.string().min(1).max(200),
  command: z.enum(REPAIR_COMMANDS),
  totalCostMinor: z.string().regex(/^\d{1,30}$/),
});

export interface RepairOrderBaseline {
  readonly requestId: string;
  readonly repairOrderId: string;
  readonly command: RepairCommandName;
  /** The order's total as the page showed it. */
  readonly totalCostMinor: string;
}

/**
 * The order a command is for, the request it was drawn under, the command, and
 * the order's total as the page showed it, signed for this session.
 *
 * Bound to the **command** as well as the order, so the token minted beside
 * "cancel this referral" cannot be posted to the form that completes it; and
 * the **total** is carried only for the completion, which sends it back so the
 * service can refuse a bill that moved. The browser's only say is whether to
 * press the button, and what it types into the form's own fields.
 */
export function sealRepairOrderBaseline(
  session: WebSession,
  baseline: RepairOrderBaseline,
): string {
  return signPayload(
    session,
    REPAIR_ORDER_BASELINE_PURPOSE,
    { ...baseline },
    REPAIR_ORDER_BASELINE_TTL_SECONDS,
  );
}

/**
 * The baseline, if `token` is one this session was given for `command` under
 * `requestId`; otherwise `null` — one answer for forged, somebody else's,
 * expired, minted for another command, and for another request.
 */
export function openRepairOrderBaseline(
  session: WebSession,
  token: unknown,
  requestId: string,
  command: RepairCommandName,
): RepairOrderBaseline | null {
  const payload = verifyPayload(
    session,
    REPAIR_ORDER_BASELINE_PURPOSE,
    token,
    repairOrderBaselineSchema,
  );
  if (!payload || payload.requestId !== requestId || payload.command !== command) return null;
  return payload;
}

const repairOrderIdSchema = seedIdSchema(ID_PREFIXES.repairOrder);

/** Only an order the service named in a shape that can be one is offered forms. */
export function isRepairOrderId(value: string): boolean {
  return repairOrderIdSchema.safeParse(value).success;
}
