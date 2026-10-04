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
import { signPayload, verifyPayload } from './signed-payload';
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

/**
 * `model`, exactly as asset-service takes it: trimmed text of 1 to 120
 * characters that refuses the Unicode `Bidi_Control` set and nothing else
 * (`dto.ts`: `plainText().min(1).max(120)`, where `manufacturer` and `name`
 * use `displayText`). Holding it to the display-text class refused models the
 * service stores happily, and normalising its letters rewrote a value the
 * person did not ask to change. `asset-commands.contract.spec.ts` pins the
 * service's rule, so the day it changes this copy fails a test rather than a
 * person.
 *
 * Blank is blank: absent on register, `null` on edit.
 */
const MODEL_MAX = 120;
const modelText = z
  .string()
  .transform((raw) => raw.trim())
  .pipe(
    z
      .string()
      .max(MODEL_MAX, `مدل حداکثر ${fa(MODEL_MAX)} نویسه است`)
      .refine((value) => !BIDI_CONTROL.test(value), BIDI_CONTROL_MESSAGE),
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

export function firstIssuePerField<F extends string>(
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

export function readFields<F extends string>(
  form: FormData,
  fields: readonly F[],
): Record<F, string> {
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
    model: modelText.transform(blankTo(undefined)),
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
 * What each editable field must satisfy **when it is being changed**.
 *
 * Only a changed field is parsed and sent (below). That is the point, twice
 * over: an edit that names a field it did not change restores that field's old
 * value over whatever somebody else saved since — the lost-update the review of
 * #158 found — and a field the person never touched cannot block the save
 * because the stored value predates a rule this portal now applies. A blanked
 * field is sent as `null`, which on the service is "clear" (`name` cannot be
 * cleared, only changed).
 */
const UPDATE_FIELD_SCHEMAS = {
  name: requiredDisplayText('نام', 2, 200),
  assetTag: identifierText('شمارهٔ دارایی', 64).transform(blankTo(null)),
  manufacturer: optionalDisplayText('سازنده', 120).transform(blankTo(null)),
  model: modelText.transform(blankTo(null)),
  manufactureYear: yearOrBlank<null>(null),
} as const satisfies Record<UpdateAssetField, z.ZodTypeAny>;

/** What asset-service accepts on `PATCH /v1/assets/{id}`, less the version. */
export type UpdateAssetRequest = {
  readonly [F in UpdateAssetField]?: z.output<(typeof UPDATE_FIELD_SCHEMAS)[F]>;
};

/**
 * The fields whose submitted text differs from the text the form was rendered
 * with. Compared as text, before any normalisation, because the form is
 * rendered from the stored value and an untouched input comes back byte for
 * byte; a field is changed when the person changed it.
 */
export function changedUpdateFields(
  submitted: UpdateAssetFormValues,
  rendered: UpdateAssetFormValues,
): UpdateAssetField[] {
  return UPDATE_ASSET_FIELDS.filter((field) => submitted[field] !== rendered[field]);
}

export type ParsedUpdateAssetForm =
  | { readonly ok: true; readonly request: UpdateAssetRequest }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<UpdateAssetField, string>> };

function isUpdateAssetField(value: string): value is UpdateAssetField {
  return (UPDATE_ASSET_FIELDS as readonly string[]).includes(value);
}

export function parseUpdateAssetForm(
  values: UpdateAssetFormValues,
  changed: readonly UpdateAssetField[],
): ParsedUpdateAssetForm {
  const shape: Record<string, z.ZodTypeAny> = {};
  const input: Record<string, string> = {};
  for (const field of changed) {
    shape[field] = UPDATE_FIELD_SCHEMAS[field];
    input[field] = values[field];
  }

  const parsed = z.object(shape).strict().safeParse(input);
  if (parsed.success) return { ok: true, request: parsed.data as UpdateAssetRequest };
  return { ok: false, fieldErrors: firstIssuePerField(parsed.error, isUpdateAssetField) };
}

/**
 * Said when asset-service answers an edit's version with a 409: somebody saved
 * this machine after the form was drawn. The action recognises the service's
 * sentence (`OPTIMISTIC_LOCK_FAILED`, which the platform's error body carries as
 * text and no rule code a client may read) and sends the person back to a fresh
 * read; `asset-commands.contract.spec.ts` pins the sentence to its source.
 */
export const ASSET_EDIT_CONFLICT_MESSAGE =
  'همین ماشین پس از باز شدن این فرم تغییر کرده است؛ ویرایش شما ذخیره نشد.';

export const UPDATE_ASSET_FIELD_MAPPING: FieldMapping<UpdateAssetField> = {
  paths: {
    name: 'name',
    assetTag: 'assetTag',
    manufacturer: 'manufacturer',
    model: 'model',
    manufactureYear: 'manufactureYear',
  },
  messages: {
    ...SERVICE_MESSAGES,
    'Asset was modified by another request; reload and retry': ASSET_EDIT_CONFLICT_MESSAGE,
  },
};

export function updateAsset(
  session: WebSession,
  assetId: string,
  request: UpdateAssetRequest,
  expectedVersion: number,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenAsset, UpdateAssetField>> {
  return writeThroughGateway(session, {
    // The id goes in a path segment, so it is encoded rather than interpolated:
    // an id containing a slash would otherwise address a different endpoint.
    path: `/v1/assets/${encodeURIComponent(assetId)}`,
    method: 'PATCH',
    // The version the form was drawn from: asset-service applies the edit to
    // that version only and answers 409 otherwise, so a stale form cannot
    // restore what somebody else changed.
    body: { ...request, expectedVersion },
    submissionId,
    schema: responseSchema,
    mapping: UPDATE_ASSET_FIELD_MAPPING,
    fetchImpl,
  });
}

// ---------------------------------------------------------------------------
// What the edit form was drawn from
// ---------------------------------------------------------------------------

const BASELINE_PURPOSE = 'asset-edit-baseline';

/** A form left open all working day is still a form; one left open overnight is not. */
const BASELINE_TTL_SECONDS = 12 * 60 * 60;

const baselineSchema = z.object({
  assetId: z.string().min(1).max(200),
  version: z.number().int().min(1),
  values: z
    .object({
      name: z.string().max(1000),
      assetTag: z.string().max(1000),
      manufacturer: z.string().max(1000),
      model: z.string().max(1000),
      manufactureYear: z.string().max(10),
    })
    .strict(),
});

export interface AssetEditBaseline {
  readonly version: number;
  readonly values: UpdateAssetFormValues;
}

/**
 * The values and version the edit form was drawn from, signed for this session
 * and this machine and carried in a hidden field.
 *
 * The action diffs against **this**, not against anything the browser says it
 * saw: a form field the person can edit is a form field a script can edit, and
 * a diff against a claimed baseline would let a claim decide what is "unchanged"
 * and so what is sent. Signed, the only thing the browser controls is what the
 * person typed.
 */
export function sealAssetBaseline(
  session: WebSession,
  assetId: string,
  version: number,
  values: UpdateAssetFormValues,
): string {
  return signPayload(session, BASELINE_PURPOSE, { assetId, version, values }, BASELINE_TTL_SECONDS);
}

/** The baseline, if `token` is one this session was given for `assetId`; otherwise `null`. */
export function openAssetBaseline(
  session: WebSession,
  token: unknown,
  assetId: string,
): AssetEditBaseline | null {
  const payload = verifyPayload(session, BASELINE_PURPOSE, token, baselineSchema);
  if (!payload || payload.assetId !== assetId) return null;
  return { version: payload.version, values: payload.values };
}
