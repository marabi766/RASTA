import { z } from 'zod';

import { ASSET_TYPES } from '@/lib/asset-fields';
import {
  REGISTER_ASSET_FIELDS,
  UPDATE_ASSET_FIELDS,
  type RegisterAssetField,
  type RegisterAssetFormValues,
  type UpdateAssetField,
  type UpdateAssetFormValues,
} from '@/lib/asset-form-fields';
import { normalizePersianText, toLatinDigits, toPersianDigits } from '@/lib/format';

import { BIDI_CONTROL } from './drivers';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';
import type { WebSession } from './session';

/**
 * Writing to asset-service through the gateway (ADR-058 § 3, ADR-059 § 3).
 *
 * Same split as `drivers.ts` and `maintenance-commands.ts`: the form's own
 * schema says what a person may type and in what words a mistake is reported;
 * asset-service decides what is true. A rule copied here is a courtesy that
 * saves a round trip and is never the enforcement — the service refuses again,
 * and a rule this file forgets is still refused there.
 */

// ---------------------------------------------------------------------------
// Who is offered the forms
// ---------------------------------------------------------------------------

/**
 * The roles `POST /v1/assets` and `PATCH /v1/assets/:id` admit
 * (`asset.controller.ts`): the same three for both.
 *
 * A Route Guard as UX, exactly as `canManageDrivers` documents (`docs/16 §
 * ۱۶٫۱۱`): it hides forms nobody in another role could use, and is never the
 * check — asset-service refuses again, for a role that lost the right between
 * this render and the submit.
 */
const ASSET_MANAGEMENT_ROLES: readonly string[] = [
  'ORGANIZATION_ADMIN',
  'FLEET_MANAGER',
  'UNION_ADMIN',
];

export function canManageAssets(effectiveRoles: readonly string[]): boolean {
  return effectiveRoles.some((role) => ASSET_MANAGEMENT_ROLES.includes(role));
}

// ---------------------------------------------------------------------------
// Field rules shared by both forms
// ---------------------------------------------------------------------------

/**
 * What asset-service's `displayText` accepts: Arabic and Latin script, digits,
 * combining marks, whitespace, ZWNJ and a short list of punctuation.
 *
 * Copied, not imported (A-02 forbids reaching into `services/*\/src`), and
 * pinned: `asset-commands.contract.spec.ts` reads the pattern out of the
 * service's `dto.ts` and fails the moment the two disagree on any of a corpus
 * of probe strings — the way `labels.contract.spec.ts` pins the vocabularies.
 */
export const ASSET_DISPLAY_TEXT =
  /^[\p{Script=Arabic}\p{Script=Latin}\p{Nd}\p{Mark}\s\u200c()«»'’\-.,/:+]+$/u;

const UNSUPPORTED_CHARACTERS = 'نویسهٔ غیرمجاز دارد؛ حروف فارسی و لاتین، رقم و علائم معمول مجازند';
const BIDI_CONTROL_MESSAGE = 'این فیلد نویسهٔ جهت‌دهی نامرئی نمی‌پذیرد';

/** A number inside a message the person reads: Persian digits, at the edge of the layer. */
const fa = (value: number): string => toPersianDigits(String(value));

/** A required name-like field: bounded, in the service's character set. */
const requiredDisplayText = (label: string, min: number, max: number) =>
  z
    .string()
    .transform((raw) => normalizePersianText(raw))
    .pipe(
      z
        .string()
        .min(min, min === 1 ? `${label} را وارد کنید` : `${label} دست‌کم ${fa(min)} نویسه باشد`)
        .max(max, `${label} حداکثر ${fa(max)} نویسه است`)
        .regex(ASSET_DISPLAY_TEXT, UNSUPPORTED_CHARACTERS),
    );

/** An optional name-like field: blank is absent on register, `null` on edit. */
const optionalDisplayText = (label: string, max: number) =>
  z
    .string()
    .transform((raw) => normalizePersianText(raw))
    .pipe(
      z
        .string()
        .max(max, `${label} حداکثر ${fa(max)} نویسه است`)
        .refine((value) => value === '' || ASSET_DISPLAY_TEXT.test(value), UNSUPPORTED_CHARACTERS),
    );

/**
 * A value that takes part in a uniqueness check (asset tag, serial number).
 *
 * The service canonicalises these — Persian and Arabic-Indic digits and the
 * Arabic letter variants fold to one spelling — before it measures or stores
 * them, so the portal sends what was typed and does not guess at that folding.
 * It does refuse the whole Unicode `Bidi_Control` set, as the driver
 * identifiers do: a value that renders as a different identifier than the one
 * typed is exactly the deception somebody comparing an asset tag against a
 * plate must not be exposed to.
 */
const identifierText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .refine((value) => !BIDI_CONTROL.test(value), BIDI_CONTROL_MESSAGE)
    .pipe(z.string().max(max, `${label} حداکثر ${fa(max)} نویسه است`));

/** Sent as the service bounds it; calendar is not interpreted (see PR notes). */
const MANUFACTURE_YEAR_MIN = 1300;
const MANUFACTURE_YEAR_MAX = 2100;
const MANUFACTURE_YEAR_MESSAGE = `سال ساخت باید عددی چهاررقمی بین ${fa(MANUFACTURE_YEAR_MIN)} و ${fa(MANUFACTURE_YEAR_MAX)} باشد`;

/**
 * A year, typed in either digit set. Digits are converted on the way in
 * (`toLatinDigits`) because the person types in the script they read; the
 * value sent, like every value in the API, is Latin.
 *
 * The calendar is not interpreted and nothing is converted between calendars:
 * asset-service bounds the field to 1300–2100, which admits both a Jalali and
 * a Gregorian year, and nothing in the docs says which it holds.
 */
function yearOrBlank<T>(blank: T) {
  return z.string().transform((raw, ctx) => {
    const value = toLatinDigits(raw).trim();
    if (value === '') return blank;
    const year = /^\d{4}$/.test(value) ? Number(value) : Number.NaN;
    if (!(year >= MANUFACTURE_YEAR_MIN && year <= MANUFACTURE_YEAR_MAX)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: MANUFACTURE_YEAR_MESSAGE });
      return z.NEVER;
    }
    return year;
  });
}

const blankTo =
  <T>(blank: T) =>
  (value: string) =>
    value === '' ? blank : value;

/** The sentences asset-service emits for these two writes, in Persian. */
const SERVICE_MESSAGES: Readonly<Record<string, string>> = {
  'Contains unsupported characters': UNSUPPORTED_CHARACTERS,
  // Says nothing about who holds the serial number or tag, and neither may
  // this: a check that named the holder would be an enumeration oracle.
  'Asset already exists': 'ماشینی با این شمارهٔ سریال یا شمارهٔ دارایی پیش‌تر ثبت شده است',
};

const responseSchema = z.object({ id: z.string().min(1) });

export type WrittenAsset = z.infer<typeof responseSchema>;

function firstIssuePerField<F extends string>(
  error: z.ZodError,
  isField: (value: string) => value is F,
): Partial<Record<F, string>> {
  const fieldErrors: Partial<Record<F, string>> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && isField(field) && fieldErrors[field] === undefined) {
      fieldErrors[field] = issue.message;
    }
  }
  return fieldErrors;
}

function readFields<F extends string>(form: FormData, fields: readonly F[]): Record<F, string> {
  const values = {} as Record<F, string>;
  for (const field of fields) {
    const raw = form.get(field);
    values[field] = typeof raw === 'string' ? raw : '';
  }
  return values;
}

// ---------------------------------------------------------------------------
// Register a machine
// ---------------------------------------------------------------------------

export function registerAssetFormValues(form: FormData): RegisterAssetFormValues {
  return readFields(form, REGISTER_ASSET_FIELDS);
}

/**
 * A blank optional is left out rather than sent empty: on register there is
 * nothing already stored for it to mean "clear".
 *
 * `siteName` and `addressLine` travel as one `location` object, and only when
 * at least one is given — the service's `location` is optional as a whole.
 */
export const registerAssetFormSchema = z
  .object({
    name: requiredDisplayText('نام', 2, 200),
    type: z.enum(ASSET_TYPES, { errorMap: () => ({ message: 'نوع ماشین را انتخاب کنید' }) }),
    assetTag: identifierText('شمارهٔ دارایی', 64).transform(blankTo(undefined)),
    manufacturer: optionalDisplayText('سازنده', 120).transform(blankTo(undefined)),
    model: optionalDisplayText('مدل', 120).transform(blankTo(undefined)),
    serialNumber: identifierText('شمارهٔ سریال', 120)
      .refine((value) => value === '' || value.length >= 3, 'شمارهٔ سریال دست‌کم ۳ نویسه باشد')
      .transform(blankTo(undefined)),
    manufactureYear: yearOrBlank<undefined>(undefined),
    siteName: optionalDisplayText('محل', 200).transform(blankTo(undefined)),
    addressLine: z
      .string()
      .transform((raw) => normalizePersianText(raw))
      .pipe(z.string().max(500, 'نشانی حداکثر ۵۰۰ نویسه است'))
      .transform(blankTo(undefined)),
  })
  .strict()
  .transform(({ siteName, addressLine, ...rest }) => ({
    ...rest,
    ...(siteName !== undefined || addressLine !== undefined
      ? { location: { siteName, addressLine } }
      : {}),
  }));

/** What asset-service accepts on `POST /v1/assets`. */
export type RegisterAssetRequest = z.infer<typeof registerAssetFormSchema>;

export type ParsedRegisterAssetForm =
  | { readonly ok: true; readonly request: RegisterAssetRequest }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<RegisterAssetField, string>> };

function isRegisterAssetField(value: string): value is RegisterAssetField {
  return (REGISTER_ASSET_FIELDS as readonly string[]).includes(value);
}

export function parseRegisterAssetForm(values: RegisterAssetFormValues): ParsedRegisterAssetForm {
  const parsed = registerAssetFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, request: parsed.data };
  return { ok: false, fieldErrors: firstIssuePerField(parsed.error, isRegisterAssetField) };
}

export const REGISTER_ASSET_FIELD_MAPPING: FieldMapping<RegisterAssetField> = {
  paths: {
    name: 'name',
    type: 'type',
    assetTag: 'assetTag',
    manufacturer: 'manufacturer',
    model: 'model',
    serialNumber: 'serialNumber',
    manufactureYear: 'manufactureYear',
    'location.siteName': 'siteName',
    'location.addressLine': 'addressLine',
  },
  messages: SERVICE_MESSAGES,
};

export function registerAsset(
  session: WebSession,
  request: RegisterAssetRequest,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenAsset, RegisterAssetField>> {
  return writeThroughGateway(session, {
    path: '/v1/assets',
    body: request,
    submissionId,
    schema: responseSchema,
    mapping: REGISTER_ASSET_FIELD_MAPPING,
    fetchImpl,
  });
}

// ---------------------------------------------------------------------------
// Edit a machine
// ---------------------------------------------------------------------------

export function updateAssetFormValues(form: FormData): UpdateAssetFormValues {
  return readFields(form, UPDATE_ASSET_FIELDS);
}

/**
 * Every field, always present, always a value or `null` — never omitted. This
 * form always shows the machine's current record, so "left blank" and "was
 * already blank" are the same signal, and asset-service reserves *omission*
 * for "an API caller did not mean to touch this field" (`dto.field !==
 * undefined`), which a form that renders every field can never honestly
 * claim. `name` is the exception: it cannot be cleared, only changed.
 */
export const updateAssetFormSchema = z
  .object({
    name: requiredDisplayText('نام', 2, 200),
    assetTag: identifierText('شمارهٔ دارایی', 64).transform(blankTo(null)),
    manufacturer: optionalDisplayText('سازنده', 120).transform(blankTo(null)),
    model: optionalDisplayText('مدل', 120).transform(blankTo(null)),
    manufactureYear: yearOrBlank<null>(null),
  })
  .strict();

/** What asset-service accepts on `PATCH /v1/assets/{id}`. */
export type UpdateAssetRequest = z.infer<typeof updateAssetFormSchema>;

export type ParsedUpdateAssetForm =
  | { readonly ok: true; readonly request: UpdateAssetRequest }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<UpdateAssetField, string>> };

function isUpdateAssetField(value: string): value is UpdateAssetField {
  return (UPDATE_ASSET_FIELDS as readonly string[]).includes(value);
}

export function parseUpdateAssetForm(values: UpdateAssetFormValues): ParsedUpdateAssetForm {
  const parsed = updateAssetFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, request: parsed.data };
  return { ok: false, fieldErrors: firstIssuePerField(parsed.error, isUpdateAssetField) };
}

export const UPDATE_ASSET_FIELD_MAPPING: FieldMapping<UpdateAssetField> = {
  paths: {
    name: 'name',
    assetTag: 'assetTag',
    manufacturer: 'manufacturer',
    model: 'model',
    manufactureYear: 'manufactureYear',
  },
  messages: SERVICE_MESSAGES,
};

export function updateAsset(
  session: WebSession,
  assetId: string,
  request: UpdateAssetRequest,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenAsset, UpdateAssetField>> {
  return writeThroughGateway(session, {
    // The id goes in a path segment, so it is encoded rather than interpolated:
    // an id containing a slash would otherwise address a different endpoint.
    path: `/v1/assets/${encodeURIComponent(assetId)}`,
    method: 'PATCH',
    body: request,
    submissionId,
    schema: responseSchema,
    mapping: UPDATE_ASSET_FIELD_MAPPING,
    fetchImpl,
  });
}
