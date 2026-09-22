import { TZDate } from '@date-fns/tz';
import { ID_PREFIXES, seedIdSchema } from '@rasta/contracts';
import { z } from 'zod';

import { DISPLAY_TIME_ZONE, normalizePersianText, toLatinDigits } from '@/lib/format';
import {
  EMPTY_USAGE_FORM,
  USAGE_FIELDS,
  type UsageField,
  type UsageFormValues,
} from '@/lib/usage-fields';

import type { WebSession } from './session';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';

export { EMPTY_USAGE_FORM, USAGE_FIELDS };
export type { UsageField, UsageFormValues };

/**
 * Recording machine usage (ثبت کارکرد) through the gateway.
 *
 * The first thing this portal *writes*. The shape mirrors fleet-service's
 * `recordUsageSchema` — the same fields, the same bounds, the same "at least
 * one of hours or kilometres" — but this is a form parser, not a copy of the
 * service's rule book. It exists to answer a person in Persian before a
 * request is made, for the mistakes a form can see; the service remains the
 * authority, and whatever it refuses comes back onto the field through
 * `write.ts`.
 *
 * ## Time
 *
 * The form's `datetime-local` inputs carry a wall-clock time with no zone.
 * They are read as Tehran time — the zone the whole portal displays in — and
 * sent as UTC instants, which is the only form the platform stores
 * (CLAUDE.md: «UTC در پایگاه داده؛ تبدیل تقویمی فقط در UI»).
 *
 * ## Digits
 *
 * A quantity typed on a Persian keyboard arrives as `۱۲٫۵`; the service's
 * regex wants `12.5`. Digits and the decimal separator are normalised here,
 * once, so nobody is told their number is not a number.
 */

/** Reads the form's fields as strings; anything absent is the empty string. */
export function usageFormValues(form: FormData): UsageFormValues {
  const values: Record<UsageField, string> = { ...EMPTY_USAGE_FORM };
  for (const field of USAGE_FIELDS) {
    const raw = form.get(field);
    values[field] = typeof raw === 'string' ? raw : '';
  }
  return values;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const assetId = seedIdSchema(ID_PREFIXES.asset);

const DECIMAL_SEPARATORS = /[٫,]/g;

/** `۱۲٫۵` → `12.5`; whitespace gone; empty stays empty. */
function normaliseQuantity(raw: string): string {
  return toLatinDigits(raw).replace(DECIMAL_SEPARATORS, '.').replace(/\s+/g, '');
}

const QUANTITY = /^\d+(\.\d{1,2})?$/;

/**
 * An optional quantity: blank means "not recorded", never zero.
 *
 * Written as one refinement rather than a union of `''` and a number schema:
 * a failed union reports "Invalid input" for the whole thing, and the person
 * would never see which of the two rules they broke.
 */
const optionalQuantity = (maxIntegerDigits: number) =>
  z
    .string()
    .transform(normaliseQuantity)
    .superRefine((value, ctx) => {
      if (value === '') return;
      if (!QUANTITY.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'عددی نامنفی با حداکثر دو رقم اعشار وارد کنید',
        });
      } else if ((value.split('.')[0] ?? '').length > maxIntegerDigits) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `حداکثر ${maxIntegerDigits} رقم پیش از اعشار مجاز است`,
        });
      }
    })
    .transform((value) => (value === '' ? undefined : value));

/** `YYYY-MM-DDTHH:mm` (what `datetime-local` produces), read in Tehran time. */
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function localDateTimeToIso(raw: string, timeZone = DISPLAY_TIME_ZONE): string | null {
  const match = LOCAL_DATETIME.exec(toLatinDigits(raw).trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const instant = new TZDate(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? '0'),
    timeZone,
  );
  if (Number.isNaN(instant.getTime())) return null;
  // Reject a date the calendar normalised away (the 31st of a 30-day month).
  if (instant.getMonth() !== Number(month) - 1 || instant.getDate() !== Number(day)) return null;
  // A plain `Date` for the output, not `TZDate.toISOString()`: the zoned one
  // renders `2026-09-21T08:00:00.000+03:30`, and the platform's contracts use
  // `z.string().datetime()`, which accepts only the `Z` form. Same instant,
  // the spelling the service parses.
  return new Date(instant.getTime()).toISOString();
}

const localDateTime = z
  .string()
  .min(1, 'تاریخ و ساعت را وارد کنید')
  .transform((raw, ctx) => {
    const iso = localDateTimeToIso(raw);
    if (iso === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'تاریخ یا ساعت معتبر نیست' });
      return z.NEVER;
    }
    return iso;
  });

export const usageFormSchema = z
  .object({
    assetId: z
      .string()
      .min(1, 'ماشین را انتخاب کنید')
      .refine((value) => assetId.safeParse(value).success, 'شناسهٔ ماشین معتبر نیست'),
    periodStart: localDateTime,
    periodEnd: localDateTime,
    hours: optionalQuantity(8),
    kilometres: optionalQuantity(10),
    hourMeter: optionalQuantity(10),
    odometer: optionalQuantity(10),
    notes: z
      .string()
      .transform((raw) => normalizePersianText(raw))
      .pipe(z.string().max(1000, 'یادداشت حداکثر ۱۰۰۰ نویسه است'))
      .transform((value) => (value === '' ? undefined : value)),
  })
  .superRefine((values, ctx) => {
    if (values.hours === undefined && values.kilometres === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hours'],
        message: 'دست‌کم یکی از ساعت کارکرد یا کیلومتر را وارد کنید',
      });
    }
    if (new Date(values.periodEnd) <= new Date(values.periodStart)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['periodEnd'],
        message: 'پایان بازه باید پس از شروع آن باشد',
      });
    }
  });

/** What fleet-service accepts on `POST /v1/usage-records`. */
export type UsageRequest = z.infer<typeof usageFormSchema> & {
  readonly source: 'MANUAL';
  readonly clientReference: string;
};

export type ParsedUsageForm =
  | { readonly ok: true; readonly request: UsageRequest }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<UsageField, string>> };

export function parseUsageForm(values: UsageFormValues, submissionId: string): ParsedUsageForm {
  const parsed = usageFormSchema.safeParse(values);
  if (parsed.success) {
    return {
      ok: true,
      request: { ...parsed.data, source: 'MANUAL', clientReference: submissionId },
    };
  }

  const fieldErrors: Partial<Record<UsageField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && isUsageField(field) && fieldErrors[field] === undefined) {
      fieldErrors[field] = issue.message;
    }
  }
  return { ok: false, fieldErrors };
}

function isUsageField(value: string): value is UsageField {
  return (USAGE_FIELDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

/** What the screen shows after a successful record. Everything else is dropped. */
const usageRecordSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  hours: z.string().nullable().default(null),
  kilometres: z.string().nullable().default(null),
});

export type UsageRecord = z.infer<typeof usageRecordSchema>;

/**
 * Where a service detail lands, and how its sentence reads in Persian.
 *
 * The keys on the left are fleet-service's request-body paths; the messages
 * are the ones its schema and service emit today. A sentence not listed here
 * is shown as it arrived rather than replaced by a guess.
 */
export const USAGE_FIELD_MAPPING: FieldMapping<UsageField> = {
  paths: {
    assetId: 'assetId',
    periodStart: 'periodStart',
    periodEnd: 'periodEnd',
    hours: 'hours',
    kilometres: 'kilometres',
    hourMeter: 'hourMeter',
    odometer: 'odometer',
    notes: 'notes',
  },
  messages: {
    'Record at least one of hours or kilometres':
      'دست‌کم یکی از ساعت کارکرد یا کیلومتر را وارد کنید',
    'periodEnd must be after periodStart': 'پایان بازه باید پس از شروع آن باشد',
    'Expected a non-negative number with at most two decimals':
      'عددی نامنفی با حداکثر دو رقم اعشار وارد کنید',
    'Usage cannot be recorded for a period in the future.': 'بازهٔ کارکرد نمی‌تواند در آینده باشد',
    'Only a registered driver may record usage for a machine':
      'برای ثبت کارکرد باید به‌عنوان راننده ثبت شده باشید',
  },
};

export function recordUsage(
  session: WebSession,
  request: UsageRequest,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<UsageRecord, UsageField>> {
  return writeThroughGateway(session, {
    path: '/v1/usage-records',
    body: request,
    submissionId: request.clientReference,
    schema: usageRecordSchema,
    mapping: USAGE_FIELD_MAPPING,
    fetchImpl,
  });
}
