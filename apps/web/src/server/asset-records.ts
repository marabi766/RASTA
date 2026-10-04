import { z } from 'zod';

import {
  POLICY_COVERAGES,
  RECORD_INSPECTION_FIELDS,
  RECORD_POLICY_FIELDS,
  type RecordInspectionField,
  type RecordInspectionFormValues,
  type RecordPolicyField,
  type RecordPolicyFormValues,
  type ValidityWindow,
} from '@/lib/asset-record-fields';
import { INSPECTION_RESULTS } from '@/lib/asset-fields';
import {
  IRR,
  MoneyInputError,
  normalizePersianText,
  parseMoneyInput,
  toPersianDigits,
} from '@/lib/format';
import { MAX_AMOUNT_MINOR } from '@/lib/repair-order-fields';

import { ASSET_DISPLAY_TEXT, firstIssuePerField, readFields } from './asset-commands';
import { readFromGateway, type ReadResult } from './assets';
import { BIDI_CONTROL, localDateToIso } from './drivers';
import { webServerEnv } from './env';
import { signPayload, verifyPayload } from './signed-payload';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';
import type { WebSession } from './session';

/**
 * Insurance policies and technical inspections of a machine, through the
 * gateway (EXP-002, slice 6; ADR-058 § 3, ADR-059 § 3).
 *
 * Same split as `asset-lifecycle-commands.ts`: the form's own schema says what a
 * person may type and in what words a mistake is reported; asset-service decides
 * what is true. A rule copied here saves a round trip and is never the
 * enforcement — the service refuses again, and a rule this file forgets is still
 * refused there. `asset-records.contract.spec.ts` pins every copy to its source.
 *
 * ## Dates
 *
 * A date is typed as a calendar day (`type="date"`) and sent as **Tehran
 * midnight** of that day (`localDateToIso`, the driver-licence precedent): it
 * round-trips into the form and onto the page as the day that was typed and
 * never moves by one. The consequence a reader must know — recorded as a
 * question to the PM, not decided here — is that a "valid to" instant is the
 * **start** of the typed day, so a policy stops counting as in force when that
 * day begins. That errs towards "not covered", the safe side of a dispatch gate.
 *
 * ## Replay
 *
 * Both writes are sent with the bound submission id as `Idempotency-Key`, and
 * asset-service stores the answer under it: a second send of the same form is
 * the first one's response and records nothing, and the same key with a changed
 * body is refused (`IDEMPOTENCY_KEY_REUSED`). A request that came back
 * unconfirmed is therefore safe to send again from the same form.
 */

// ---------------------------------------------------------------------------
// Who is offered the forms
// ---------------------------------------------------------------------------

/**
 * The roles `POST /v1/assets/:id/insurance-policies` and `…/inspections` admit
 * (`asset.controller.ts`): the same three, pinned by the contract spec.
 *
 * A Route Guard as UX, exactly as `canManageAssets` documents: it hides forms
 * nobody in another role could use, and is never the check.
 */
const RECORD_ROLES: readonly string[] = ['ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN'];

export const canRecordAssetCompliance = (effectiveRoles: readonly string[]): boolean =>
  effectiveRoles.some((role) => RECORD_ROLES.includes(role));

// ---------------------------------------------------------------------------
// Which asset a form is for
// ---------------------------------------------------------------------------

const RECORD_BASELINE_PURPOSE = 'asset-record-baseline';

/** The two records a machine's page takes. */
export const ASSET_RECORD_KINDS = ['policy', 'inspection'] as const;
export type AssetRecordKind = (typeof ASSET_RECORD_KINDS)[number];

const recordBaselineSchema = z.object({
  assetId: z.string().min(1).max(200),
  record: z.enum(ASSET_RECORD_KINDS),
});

export type AssetRecordBaseline = z.infer<typeof recordBaselineSchema>;

/**
 * The asset a record form was drawn for, and which of the two forms it is,
 * signed for this session.
 *
 * The forms bind the action to the page's asset with `action.bind(null,
 * assetId)` in a client component, and a value bound there is one the browser
 * sends back: nothing about it is signed. This token is what makes "a post can
 * only address the page's own asset" true — the runner refuses a bound id that
 * is not the one signed here — the same binding the lifecycle baseline gives
 * its commands. Unlike that one it carries no version or status: a record is
 * not made against what the page showed of the machine, so nothing in it can go
 * stale, and it lives as long as the session that could post it (the CSRF token
 * it is keyed over ends with the login anyway). A form left open while a paper
 * policy is copied out is not refused for being slow.
 *
 * asset-service still decides on every send, and answers another
 * organization's machine as a missing one.
 */
export function sealAssetRecordBaseline(
  session: WebSession,
  baseline: AssetRecordBaseline,
): string {
  return signPayload(
    session,
    RECORD_BASELINE_PURPOSE,
    { ...baseline },
    webServerEnv().WEB_SESSION_MAX_AGE_SECONDS,
  );
}

/**
 * The baseline, if `token` is one this session was given for `record`;
 * otherwise `null` — one answer for forged, somebody else's, expired, minted for
 * the other form, and from an earlier login.
 */
export function openAssetRecordBaseline(
  session: WebSession,
  token: unknown,
  record: AssetRecordKind,
): AssetRecordBaseline | null {
  const payload = verifyPayload(session, RECORD_BASELINE_PURPOSE, token, recordBaselineSchema);
  if (!payload || payload.record !== record) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const policySchema = z.object({
  id: z.string(),
  policyNumber: z.string(),
  insurerName: z.string(),
  coverage: z.string(),
  /** Minor units as a string — a rial amount does not survive a JSON number. */
  premiumMinor: z.string().nullable().default(null),
  insuredValueMinor: z.string().nullable().default(null),
  validFrom: z.string(),
  validTo: z.string(),
  status: z.string(),
  daysUntilExpiry: z.number().int(),
});

export type InsurancePolicySummary = z.infer<typeof policySchema>;

const inspectionSchema = z.object({
  id: z.string(),
  certificateNo: z.string(),
  centerName: z.string().nullable().default(null),
  inspectedAt: z.string(),
  validTo: z.string(),
  result: z.string(),
  notes: z.string().nullable().default(null),
  daysUntilExpiry: z.number().int(),
});

export type InspectionSummary = z.infer<typeof inspectionSchema>;

export function fetchInsurancePolicies(
  session: WebSession,
  assetId: string,
): Promise<ReadResult<InsurancePolicySummary[]>> {
  // The id goes in a path segment, so it is encoded rather than interpolated.
  return readFromGateway(
    session,
    `/v1/assets/${encodeURIComponent(assetId)}/insurance-policies`,
    z.array(policySchema),
  );
}

export function fetchInspections(
  session: WebSession,
  assetId: string,
): Promise<ReadResult<InspectionSummary[]>> {
  return readFromGateway(
    session,
    `/v1/assets/${encodeURIComponent(assetId)}/inspections`,
    z.array(inspectionSchema),
  );
}

/**
 * Where a record's validity stands at `now`: not begun, open, or closed.
 *
 * `now` is the clock of the server that draws the page — passed in, so a test
 * pins it and a client component, whose clock is the visitor's, never has one.
 * The window is half-open, `[from, to)`, the way the service reads it (a policy
 * whose `validTo` is not after now is expired); an instant that cannot be read
 * is `EXPIRED`, never `CURRENT`: a record whose dates are unknown must not look
 * valid.
 */
export function validityWindowOf(from: string, to: string, now: Date): ValidityWindow {
  const start = Date.parse(from);
  const end = Date.parse(to);
  const at = now.getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || Number.isNaN(at)) return 'EXPIRED';
  if (at >= end) return 'EXPIRED';
  if (at < start) return 'FUTURE';
  return 'CURRENT';
}

// ---------------------------------------------------------------------------
// What a person types
// ---------------------------------------------------------------------------

const fa = (value: number): string => toPersianDigits(String(value));

const UNSUPPORTED_CHARACTERS = 'نویسهٔ غیرمجاز دارد؛ حروف فارسی و لاتین، رقم و علائم معمول مجازند';
const BIDI_CONTROL_MESSAGE = 'این فیلد نویسهٔ جهت‌دهی نامرئی نمی‌پذیرد';
const DATE_MESSAGE = 'تاریخ معتبر نیست';

/** The service's `displayText(min, max)`: name-like text in its character set. */
const displayText = (label: string, min: number, max: number) =>
  z
    .string()
    .transform((raw) => normalizePersianText(raw))
    .pipe(
      z
        .string()
        .min(1, `${label} را وارد کنید`)
        .min(min, `${label} دست‌کم ${fa(min)} نویسه باشد`)
        .max(max, `${label} حداکثر ${fa(max)} نویسه است`)
        .regex(ASSET_DISPLAY_TEXT, UNSUPPORTED_CHARACTERS),
    );

/** An optional `displayText`: blank is left out of the body. */
const optionalDisplayText = (label: string, min: number, max: number) =>
  z
    .string()
    .transform((raw) => normalizePersianText(raw))
    .pipe(
      z
        .string()
        .max(max, `${label} حداکثر ${fa(max)} نویسه است`)
        .refine(
          (value) => value === '' || value.length >= min,
          `${label} دست‌کم ${fa(min)} نویسه باشد`,
        )
        .refine((value) => value === '' || ASSET_DISPLAY_TEXT.test(value), UNSUPPORTED_CHARACTERS),
    )
    .transform((value) => (value === '' ? undefined : value));

/**
 * A number printed on a document — a policy number, a certificate number:
 * trimmed text of `min` to `max` characters, **as typed**. The service folds
 * digit and letter variants itself before it measures and stores a policy
 * number, so the portal sends what was typed; it does refuse the invisible
 * direction-control characters, which would let a value read as another number
 * than the one typed.
 */
const documentNumber = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} را وارد کنید`)
    .min(min, `${label} دست‌کم ${fa(min)} نویسه باشد`)
    .max(max, `${label} حداکثر ${fa(max)} نویسه است`)
    .refine((value) => !BIDI_CONTROL.test(value), BIDI_CONTROL_MESSAGE);

/** A calendar day, as the Tehran-midnight instant the service takes. */
const requiredDate = (label: string) =>
  z.string().transform((raw, ctx): string => {
    if (raw.trim() === '') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} را وارد کنید` });
      return z.NEVER;
    }
    const iso = localDateToIso(raw);
    if (iso === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: DATE_MESSAGE });
      return z.NEVER;
    }
    return iso;
  });

/** An optional amount in rials: blank is left out; otherwise the minor-unit string the service reads. */
const optionalRials = (label: string) =>
  z.string().transform((raw, ctx): string | undefined => {
    const text = raw.trim();
    if (text === '') return undefined;
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
    if (minor < 0n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} نمی‌تواند منفی باشد` });
      return z.NEVER;
    }
    if (minor > BigInt(MAX_AMOUNT_MINOR)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} بیش از حد بزرگ است` });
      return z.NEVER;
    }
    return minor.toString();
  });

/**
 * The lengths the service bounds each text by (`createPolicySchema`,
 * `createInspectionSchema`, `dto.ts`) — pinned by the contract spec, which reads
 * them out of the service's source.
 */
export const RECORD_BOUNDS = {
  policyNumber: { min: 3, max: 64 },
  insurerName: { min: 2, max: 200 },
  certificateNo: { min: 3, max: 64 },
  centerName: { min: 2, max: 200 },
  notes: { max: 1000 },
} as const;

export const END_NOT_AFTER_START_MESSAGE = 'تاریخ پایان باید پس از تاریخ شروع باشد';

export function recordPolicyFormValues(form: FormData): RecordPolicyFormValues {
  return readFields(form, RECORD_POLICY_FIELDS);
}

export function recordInspectionFormValues(form: FormData): RecordInspectionFormValues {
  return readFields(form, RECORD_INSPECTION_FIELDS);
}

export const recordPolicyFormSchema = z
  .object({
    policyNumber: documentNumber(
      'شمارهٔ بیمه‌نامه',
      RECORD_BOUNDS.policyNumber.min,
      RECORD_BOUNDS.policyNumber.max,
    ),
    insurerName: displayText(
      'نام شرکت بیمه',
      RECORD_BOUNDS.insurerName.min,
      RECORD_BOUNDS.insurerName.max,
    ),
    coverage: z.enum(POLICY_COVERAGES, {
      errorMap: () => ({ message: 'نوع پوشش را از فهرست انتخاب کنید' }),
    }),
    premium: optionalRials('حق بیمه'),
    insuredValue: optionalRials('سرمایهٔ بیمه'),
    validFrom: requiredDate('تاریخ شروع'),
    validTo: requiredDate('تاریخ پایان'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Date.parse(value.validTo) <= Date.parse(value.validFrom)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validTo'],
        message: END_NOT_AFTER_START_MESSAGE,
      });
    }
  })
  // The service's names: the amounts are minor units and say so.
  .transform(({ premium, insuredValue, ...rest }) => ({
    ...rest,
    ...(premium !== undefined ? { premiumMinor: premium } : {}),
    ...(insuredValue !== undefined ? { insuredValueMinor: insuredValue } : {}),
  }));

/** What asset-service accepts on `POST /v1/assets/{id}/insurance-policies`. */
export type RecordPolicyBody = z.output<typeof recordPolicyFormSchema>;

export const recordInspectionFormSchema = z
  .object({
    certificateNo: documentNumber(
      'شمارهٔ گواهی',
      RECORD_BOUNDS.certificateNo.min,
      RECORD_BOUNDS.certificateNo.max,
    ),
    centerName: optionalDisplayText(
      'نام مرکز معاینه',
      RECORD_BOUNDS.centerName.min,
      RECORD_BOUNDS.centerName.max,
    ),
    inspectedAt: requiredDate('تاریخ معاینه'),
    validTo: requiredDate('تاریخ پایان اعتبار'),
    result: z.enum(INSPECTION_RESULTS, {
      errorMap: () => ({ message: 'نتیجهٔ معاینه را از فهرست انتخاب کنید' }),
    }),
    notes: z
      .string()
      .transform((raw) => raw.trim())
      .pipe(
        z
          .string()
          .max(RECORD_BOUNDS.notes.max, `یادداشت حداکثر ${fa(RECORD_BOUNDS.notes.max)} نویسه است`),
      )
      .transform((value) => (value === '' ? undefined : value)),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Date.parse(value.validTo) <= Date.parse(value.inspectedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validTo'],
        message: 'تاریخ پایان اعتبار باید پس از تاریخ معاینه باشد',
      });
    }
  })
  // A blank optional is absent, not `undefined`: the body is what the service reads.
  .transform(({ centerName, notes, ...rest }) => ({
    ...rest,
    ...(centerName !== undefined ? { centerName } : {}),
    ...(notes !== undefined ? { notes } : {}),
  }));

/** What asset-service accepts on `POST /v1/assets/{id}/inspections`. */
export type RecordInspectionBody = z.output<typeof recordInspectionFormSchema>;

export type ParsedRecordForm<B, F extends string> =
  | { readonly ok: true; readonly body: B }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<F, string>> };

export function parseRecordPolicyForm(
  values: RecordPolicyFormValues,
): ParsedRecordForm<RecordPolicyBody, RecordPolicyField> {
  const parsed = recordPolicyFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, body: parsed.data };
  return {
    ok: false,
    fieldErrors: firstIssuePerField(parsed.error, (value): value is RecordPolicyField =>
      (RECORD_POLICY_FIELDS as readonly string[]).includes(value),
    ),
  };
}

export function parseRecordInspectionForm(
  values: RecordInspectionFormValues,
): ParsedRecordForm<RecordInspectionBody, RecordInspectionField> {
  const parsed = recordInspectionFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, body: parsed.data };
  return {
    ok: false,
    fieldErrors: firstIssuePerField(parsed.error, (value): value is RecordInspectionField =>
      (RECORD_INSPECTION_FIELDS as readonly string[]).includes(value),
    ),
  };
}

// ---------------------------------------------------------------------------
// What the service says, in Persian
// ---------------------------------------------------------------------------

/**
 * Said when the service answers `409 IDEMPOTENCY_KEY_REUSED`: this very form was
 * already sent with other contents, so the first send may have been recorded.
 * Resending from the same form would be refused again, so the person is sent to
 * look at the list on a fresh page.
 */
export const RECORD_KEY_REUSED_MESSAGE =
  'این فرم پیش‌تر با اطلاعات دیگری فرستاده شده بود و ممکن است ثبت شده باشد. صفحه را تازه کنید، فهرست را ببینید و اگر لازم بود با فرم تازه دوباره ثبت کنید.';

export const POLICY_ALREADY_RECORDED_MESSAGE =
  'بیمه‌نامه‌ای با همین شماره و همین شرکت بیمه از پیش در سامانه ثبت شده است. شماره و نام شرکت را بررسی کنید.';

export const POLICY_EXPIRED_MESSAGE =
  'تاریخ پایان این بیمه‌نامه گذشته است و ثبت آن، دارایی را بیمه‌شده نشان می‌داد. بیمه‌نامهٔ جاری را ثبت کنید.';

const RECORD_MESSAGES: Readonly<Record<string, string>> = {
  'This Idempotency-Key was already used with a different request body': RECORD_KEY_REUSED_MESSAGE,
  'InsurancePolicy already exists': POLICY_ALREADY_RECORDED_MESSAGE,
  'This policy has already expired. Record the current policy instead.': POLICY_EXPIRED_MESSAGE,
};

/** What is said for a refusal whose sentence the portal does not know, by platform code. */
const RECORD_CODE_FALLBACKS: Readonly<Record<string, string>> = {
  IDEMPOTENCY_KEY_REUSED: RECORD_KEY_REUSED_MESSAGE,
  ALREADY_EXISTS: POLICY_ALREADY_RECORDED_MESSAGE,
};

function mappingOf<F extends string>(paths: Record<string, F>): FieldMapping<F> {
  return { paths, messages: RECORD_MESSAGES, byCode: RECORD_CODE_FALLBACKS };
}

export const RECORD_POLICY_FIELD_MAPPING = mappingOf<RecordPolicyField>({
  policyNumber: 'policyNumber',
  insurerName: 'insurerName',
  coverage: 'coverage',
  premiumMinor: 'premium',
  insuredValueMinor: 'insuredValue',
  validFrom: 'validFrom',
  validTo: 'validTo',
});

export const RECORD_INSPECTION_FIELD_MAPPING = mappingOf<RecordInspectionField>({
  certificateNo: 'certificateNo',
  centerName: 'centerName',
  inspectedAt: 'inspectedAt',
  validTo: 'validTo',
  result: 'result',
  notes: 'notes',
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const answerSchema = z.object({ id: z.string().min(1) });
export type WrittenRecord = z.infer<typeof answerSchema>;

function post<F extends string>(
  session: WebSession,
  assetId: string,
  collection: 'insurance-policies' | 'inspections',
  body: object,
  submissionId: string,
  mapping: FieldMapping<F>,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenRecord, F>> {
  return writeThroughGateway(session, {
    // The id goes in a path segment, so it is encoded rather than interpolated.
    path: `/v1/assets/${encodeURIComponent(assetId)}/${collection}`,
    body,
    // The bound submission id is the `Idempotency-Key`: asset-service stores the
    // answer under it, so a second send is the first one's response.
    submissionId,
    schema: answerSchema,
    mapping,
    fetchImpl,
  });
}

export const recordInsurancePolicy = (
  session: WebSession,
  assetId: string,
  body: RecordPolicyBody,
  submissionId: string,
  fetchImpl?: typeof fetch,
) =>
  post(
    session,
    assetId,
    'insurance-policies',
    body,
    submissionId,
    RECORD_POLICY_FIELD_MAPPING,
    fetchImpl,
  );

export const recordInspection = (
  session: WebSession,
  assetId: string,
  body: RecordInspectionBody,
  submissionId: string,
  fetchImpl?: typeof fetch,
) =>
  post(
    session,
    assetId,
    'inspections',
    body,
    submissionId,
    RECORD_INSPECTION_FIELD_MAPPING,
    fetchImpl,
  );
