import { z } from 'zod';

import {
  CHANGE_STATUS_TARGETS,
  statusTargetsFrom,
  type ActivateAssetFormValues,
  type AssetLifecycleCommand,
  type ChangeStatusField,
  type ChangeStatusFormValues,
  type DecommissionField,
  type DecommissionFormValues,
} from '@/lib/asset-lifecycle-fields';
import { CHANGE_STATUS_FIELDS, DECOMMISSION_FIELDS } from '@/lib/asset-lifecycle-fields';
import { toPersianDigits } from '@/lib/format';

import { firstIssuePerField, readFields } from './asset-commands';
import { signPayload, verifyPayload } from './signed-payload';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';
import type { WebSession } from './session';

/**
 * Commissioning, changing the status of, and decommissioning a machine,
 * through the gateway (ADR-058 § 3, ADR-059 § 3).
 *
 * The same split as `repair-order-commands.ts`: the form's own schema says what
 * a person may type and in what words a mistake is reported; asset-service
 * decides what is true. A rule copied here saves a round trip and is never the
 * enforcement — the service refuses again, and a rule this file forgets is still
 * refused there.
 *
 * ## What a command acts on
 *
 * Not a field of any form. The page signs `{asset, command, version, status,
 * name}` for this session (`sealAssetLifecycleBaseline`) and the action takes the
 * asset, the version and the status the person was looking at from that token
 * alone, so a form whose hidden fields were rewritten to name another asset or
 * another version has nothing to name it with.
 *
 * The version is sent as `expectedVersion`. asset-service applies the command to
 * that version only and answers `409 OPTIMISTIC_LOCK_FAILED` for any other —
 * including for a command that was already applied once, because the first
 * request moved the version. That is the whole guard against a double submit:
 * the service does not store the submission id for these routes, and a second
 * decommission or a second "idle" must never be a second event.
 */

// ---------------------------------------------------------------------------
// Who is offered the forms
// ---------------------------------------------------------------------------

/**
 * The roles each command admits (`asset.controller.ts`, pinned by the contract
 * spec): activation and a status change the three that manage assets,
 * decommissioning only the two above a fleet manager.
 *
 * A Route Guard as UX, exactly as `canManageAssets` documents: it hides forms
 * nobody in another role could use, and is never the check.
 */
const STATUS_ROLES: readonly string[] = ['ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN'];
const DECOMMISSION_ROLES: readonly string[] = ['ORGANIZATION_ADMIN', 'UNION_ADMIN'];

export const canChangeAssetStatus = (effectiveRoles: readonly string[]): boolean =>
  effectiveRoles.some((role) => STATUS_ROLES.includes(role));

export const canDecommissionAsset = (effectiveRoles: readonly string[]): boolean =>
  effectiveRoles.some((role) => DECOMMISSION_ROLES.includes(role));

// ---------------------------------------------------------------------------
// What a person types
// ---------------------------------------------------------------------------

const fa = (value: number): string => toPersianDigits(String(value));

/**
 * A reason, as asset-service takes it: trimmed text of `min` to `max`
 * characters with **no** character class (`changeStatusSchema` and
 * `decommissionSchema`, `dto.ts`), so none is added here — a reason is the
 * person's own words and is stored as typed. The contract spec pins both bounds.
 */
function reasonText(label: string, min: number, max: number) {
  return z
    .string()
    .transform((raw) => raw.trim())
    .pipe(
      z
        .string()
        .min(1, `${label} را بنویسید`)
        .min(min, `${label} دست‌کم ${fa(min)} نویسه باشد`)
        .max(max, `${label} حداکثر ${fa(max)} نویسه است`),
    );
}

export const CHANGE_STATUS_REASON_BOUNDS = { min: 3, max: 500 } as const;
export const DECOMMISSION_REASON_BOUNDS = { min: 10, max: 1000 } as const;

export function changeStatusFormValues(form: FormData): ChangeStatusFormValues {
  return readFields(form, CHANGE_STATUS_FIELDS);
}

export function decommissionFormValues(form: FormData): DecommissionFormValues {
  return readFields(form, DECOMMISSION_FIELDS);
}

/** Activation has no fields. */
export const activateFormValues = (): ActivateAssetFormValues => ({});

export const changeStatusFormSchema = z
  .object({
    status: z.enum(CHANGE_STATUS_TARGETS, {
      errorMap: () => ({ message: 'وضعیت تازه را از فهرست انتخاب کنید' }),
    }),
    reason: reasonText(
      'دلیل تغییر',
      CHANGE_STATUS_REASON_BOUNDS.min,
      CHANGE_STATUS_REASON_BOUNDS.max,
    ),
  })
  .strict();

/** What asset-service accepts on `POST /v1/assets/{id}/status`, less the version. */
export type ChangeStatusBody = z.infer<typeof changeStatusFormSchema>;

export const NOT_OFFERED_MESSAGE = 'این تغییر وضعیت از وضعیت فعلی دارایی ممکن نیست';

export type ParsedLifecycleForm<B, F extends string> =
  | { readonly ok: true; readonly body: B }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<F, string>> };

/**
 * `shownStatus` is the status the page drew the form from — from the signed
 * baseline, never from the form. A target the page did not offer from it is
 * refused as a mistake in the `status` field, as a hand-built post would be.
 */
export function parseChangeStatusForm(
  values: ChangeStatusFormValues,
  shownStatus: string,
): ParsedLifecycleForm<ChangeStatusBody, ChangeStatusField> {
  const parsed = changeStatusFormSchema.safeParse(values);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: firstIssuePerField(parsed.error, (value): value is ChangeStatusField =>
        (CHANGE_STATUS_FIELDS as readonly string[]).includes(value),
      ),
    };
  }
  if (!statusTargetsFrom(shownStatus).includes(parsed.data.status)) {
    return { ok: false, fieldErrors: { status: NOT_OFFERED_MESSAGE } };
  }
  return { ok: true, body: parsed.data };
}

export const DECOMMISSION_UNCONFIRMED_MESSAGE =
  'برای اسقاط باید تأیید کنید که پیامد آن را می‌دانید';

export const decommissionFormSchema = z
  .object({
    reason: reasonText(
      'دلیل اسقاط',
      DECOMMISSION_REASON_BOUNDS.min,
      DECOMMISSION_REASON_BOUNDS.max,
    ),
    confirm: z.literal('yes', { errorMap: () => ({ message: DECOMMISSION_UNCONFIRMED_MESSAGE }) }),
  })
  .strict()
  // The tick is the person's confirmation and is not sent: the service's body
  // has `reason` and the version, and a field it does not know is a 400.
  .transform(({ reason }) => ({ reason }));

/** What asset-service accepts on `POST /v1/assets/{id}/decommission`, less the version. */
export type DecommissionBody = z.output<typeof decommissionFormSchema>;

export function parseDecommissionForm(
  values: DecommissionFormValues,
): ParsedLifecycleForm<DecommissionBody, DecommissionField> {
  const parsed = decommissionFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, body: parsed.data };
  return {
    ok: false,
    fieldErrors: firstIssuePerField(parsed.error, (value): value is DecommissionField =>
      (DECOMMISSION_FIELDS as readonly string[]).includes(value),
    ),
  };
}

/** Activation sends nothing the person typed. */
export function parseActivateForm(): ParsedLifecycleForm<Record<string, never>, never> {
  return { ok: true, body: {} };
}

// ---------------------------------------------------------------------------
// What the service says, in Persian
// ---------------------------------------------------------------------------

/**
 * Said when asset-service answers a command's version with a 409: the machine
 * was changed after the page was drawn — or this very command was already
 * applied. The action recognises the service's sentence (`OPTIMISTIC_LOCK_FAILED`,
 * which the platform's error body carries as text and no rule code a client may
 * read) and sends the person back to a fresh read; the contract spec pins the
 * sentence to its source.
 */
export const ASSET_LIFECYCLE_CONFLICT_MESSAGE =
  'این دارایی پس از باز شدن این صفحه تغییر کرده است — شاید همین دستور پیش‌تر اعمال شده باشد. این بار چیزی نوشته نشد؛ وضعیت فعلی را در صفحه ببینید.';

const LIFECYCLE_MESSAGES: Readonly<Record<string, string>> = {
  'Asset was modified by another request; reload and retry': ASSET_LIFECYCLE_CONFLICT_MESSAGE,
  'A DECOMMISSIONED asset cannot change status. This state is final because financial and audit records still reference the asset.':
    'این دارایی اسقاط شده و نهایی است؛ وضعیت آن دیگر تغییر نمی‌کند.',
  'The asset cannot be activated without an insurance policy currently in force.':
    'برای فعال‌سازی، دارایی باید بیمه‌نامهٔ معتبر داشته باشد. بیمه‌نامه ثبت کنید و دوباره تلاش کنید.',
  'The asset cannot be activated without an ownership title or registration card.':
    'برای فعال‌سازی، سند مالکیت یا کارت ماشین دارایی باید ثبت شده باشد.',
  'The asset cannot be activated without an insurance policy currently in force and an ownership title or registration card.':
    'برای فعال‌سازی، دارایی هم بیمه‌نامهٔ معتبر و هم سند مالکیت یا کارت ماشین لازم دارد؛ هیچ‌کدام ثبت نشده است.',
  'A registered asset is commissioned with the activate command, which checks that its dossier is complete.':
    'دارایی ثبت‌شده با دستور «فعال‌سازی» به ناوگان می‌پیوندد، که کامل بودن پرونده را بررسی می‌کند.',
};

/** What is said for a refusal whose sentence the portal does not know, by platform code. */
const LIFECYCLE_STATE_FALLBACKS: Readonly<Record<string, string>> = {
  INVALID_STATE_TRANSITION:
    'وضعیت فعلی دارایی اجازهٔ این کار را نمی‌دهد. صفحه را تازه کنید و وضعیت را ببینید.',
  BUSINESS_RULE_VIOLATION: 'این کار با قواعد دارایی سازگار نیست. صفحه را تازه کنید.',
};

/**
 * The closed reasons asset-service gives for refusing a command while another
 * service has open work on the asset (`details[].code`, docs/24 Q-93). Pinned to
 * `lifecycle.ts` by the contract spec.
 */
export const OPEN_WORK_CODES: Readonly<Record<string, string>> = {
  OPEN_ASSIGNMENT:
    'این دارایی تخصیص باز دارد. نخست تخصیص را در بخش راننده و تخصیص پایان دهید؛ با پایان آن، دارایی به «فعال» برمی‌گردد و سپس می‌توان این کار را انجام داد.',
  OPEN_MAINTENANCE:
    'این دارایی در تعمیر است و ارجاع تعمیر باز دارد. نخست تعمیر را تکمیل کنید یا ارجاع را پس بگیرید؛ با آن، دارایی به «فعال» برمی‌گردد و سپس می‌توان این کار را انجام داد.',
};

function mappingOf<F extends string>(paths: Record<string, F>): FieldMapping<F> {
  return {
    paths,
    messages: LIFECYCLE_MESSAGES,
    byCode: LIFECYCLE_STATE_FALLBACKS,
    byDetailCode: OPEN_WORK_CODES,
  };
}

export const ACTIVATE_FIELD_MAPPING = mappingOf<never>({});
export const CHANGE_STATUS_FIELD_MAPPING = mappingOf<ChangeStatusField>({
  status: 'status',
  reason: 'reason',
});
export const DECOMMISSION_FIELD_MAPPING = mappingOf<DecommissionField>({ reason: 'reason' });

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const answerSchema = z.object({ id: z.string().min(1) });
export type WrittenLifecycle = z.infer<typeof answerSchema>;

function post<F extends string, B extends object>(
  session: WebSession,
  assetId: string,
  action: string,
  body: B,
  expectedVersion: number,
  submissionId: string,
  mapping: FieldMapping<F>,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenLifecycle, F>> {
  return writeThroughGateway(session, {
    // The id goes in a path segment, so it is encoded rather than interpolated.
    path: `/v1/assets/${encodeURIComponent(assetId)}/${action}`,
    // The version the page was drawn at: asset-service applies the command to
    // that version only, so a stale page — or a second send of this one —
    // cannot write.
    body: { ...body, expectedVersion },
    submissionId,
    schema: answerSchema,
    mapping,
    fetchImpl,
  });
}

export const activateAsset = (
  session: WebSession,
  assetId: string,
  expectedVersion: number,
  submissionId: string,
  fetchImpl?: typeof fetch,
) =>
  post(
    session,
    assetId,
    'activate',
    {},
    expectedVersion,
    submissionId,
    ACTIVATE_FIELD_MAPPING,
    fetchImpl,
  );

export const changeAssetStatus = (
  session: WebSession,
  assetId: string,
  body: ChangeStatusBody,
  expectedVersion: number,
  submissionId: string,
  fetchImpl?: typeof fetch,
) =>
  post(
    session,
    assetId,
    'status',
    body,
    expectedVersion,
    submissionId,
    CHANGE_STATUS_FIELD_MAPPING,
    fetchImpl,
  );

export const decommissionAsset = (
  session: WebSession,
  assetId: string,
  body: DecommissionBody,
  expectedVersion: number,
  submissionId: string,
  fetchImpl?: typeof fetch,
) =>
  post(
    session,
    assetId,
    'decommission',
    body,
    expectedVersion,
    submissionId,
    DECOMMISSION_FIELD_MAPPING,
    fetchImpl,
  );

// ---------------------------------------------------------------------------
// What a command was drawn from
// ---------------------------------------------------------------------------

const BASELINE_PURPOSE = 'asset-lifecycle-baseline';

/**
 * Half an hour: a form for something that changes whether a machine may be
 * dispatched is read, thought about and perhaps discussed before it is sent, but
 * a page left open for a morning is not what the person decided on. The version
 * is compared again by the service on every send, so this bounds how stale a
 * *confirmation* can be, not how stale a write can be.
 */
const BASELINE_TTL_SECONDS = 30 * 60;

const LIFECYCLE_COMMAND_NAMES = ['activate', 'status', 'decommission'] as const;

const baselineSchema = z.object({
  assetId: z.string().min(1).max(200),
  command: z.enum(LIFECYCLE_COMMAND_NAMES),
  version: z.number().int().min(1),
  /** The status the page showed, which the offered targets were drawn from. */
  status: z.string().min(1).max(40),
  /** The name the page showed, which a decommission confirmation names. */
  assetName: z.string().min(1).max(1000),
});

export interface AssetLifecycleBaseline {
  readonly assetId: string;
  readonly command: AssetLifecycleCommand;
  readonly version: number;
  readonly status: string;
  readonly assetName: string;
}

/**
 * The asset a command is for, the command, the asset's version and status and
 * its name as the page showed them, signed for this session.
 *
 * Bound to the **command** as well as the asset, so the token minted beside
 * "decommission" cannot be posted to the form that merely marks it idle. The
 * browser's only say is whether to press the button, and what it types into the
 * form's own fields.
 */
export function sealAssetLifecycleBaseline(
  session: WebSession,
  baseline: AssetLifecycleBaseline,
): string {
  return signPayload(session, BASELINE_PURPOSE, { ...baseline }, BASELINE_TTL_SECONDS);
}

/**
 * The baseline, if `token` is one this session was given for `command`;
 * otherwise `null` — one answer for forged, somebody else's, expired, minted for
 * another command, and from an earlier login.
 */
export function openAssetLifecycleBaseline(
  session: WebSession,
  token: unknown,
  command: AssetLifecycleCommand,
): AssetLifecycleBaseline | null {
  const payload = verifyPayload(session, BASELINE_PURPOSE, token, baselineSchema);
  if (!payload || payload.command !== command) return null;
  return payload;
}
