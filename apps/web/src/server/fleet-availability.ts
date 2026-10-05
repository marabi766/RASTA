import { z } from 'zod';

import {
  AVAILABILITY_CHOICES,
  DECLARE_AVAILABILITY_FIELDS,
  type DeclareAvailabilityField,
  type DeclareAvailabilityFormValues,
  type WindowState,
} from '@/lib/fleet-availability-fields';
import { BIDI_CONTROL } from '@/lib/format';

import { firstIssuePerField, readFields } from './asset-commands';
import {
  BIDI_CONTROL_MESSAGE,
  DATE_MESSAGE,
  RECORD_KEY_REUSED_MESSAGE,
  displayText,
} from './asset-records';
import { readFromGateway, type ReadResult } from './assets';
import { localDateToIso } from './drivers';
import { webServerEnv } from './env';
import { signPayload, verifyPayload } from './signed-payload';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';
import type { WebSession } from './session';

/**
 * A machine's availability, through the gateway (EXP-002, slice 7).
 *
 * Availability is the one answer on the platform assembled from facts several
 * services own (ADR-026), and fleet-service says so in every answer: each
 * blocker names its cause and its owner. This module reads that answer and the
 * machine's own **declarations** — the one part fleet-service decides itself —
 * and sends the two commands the service admits on them: declare, and revoke.
 *
 * ## What a person can undo, and what they cannot
 *
 * A *declaration* is a statement a fleet manager made; it is a window with an
 * id, and it can be revoked. A *block the platform imposes* — an expired
 * insurance policy, a failed inspection, a withdrawal for repair, a status that
 * does not dispatch, an assignment in progress — is a fact another service owns
 * and is not a window at all: it has no id, no endpoint withdraws it, and this
 * portal draws no control for it. Declaring a machine available does not clear
 * one either (the service says so on the route); the page says it too.
 *
 * ## Replay
 *
 * A declaration supersedes the machine's previous one, so a replay of an old
 * request could silently undo a newer one. `POST /v1/fleet/availability`
 * therefore stores the answer under the bound submission id sent as
 * `Idempotency-Key`: a second send of the same form is the first one's response
 * and declares nothing. A revoke needs no key: it is state-based, and its
 * replay is a refusal ("already withdrawn"), never a second change.
 */

// ---------------------------------------------------------------------------
// Who is offered the forms
// ---------------------------------------------------------------------------

/**
 * The roles `POST /v1/fleet/availability` and its `…/revoke` admit
 * (`fleet.controller.ts`): the same three as the records, pinned by the contract
 * spec. A Route Guard as UX, exactly as `canManageAssets` documents.
 */
const AVAILABILITY_ROLES: readonly string[] = [
  'ORGANIZATION_ADMIN',
  'FLEET_MANAGER',
  'UNION_ADMIN',
];

export const canManageAvailability = (effectiveRoles: readonly string[]): boolean =>
  effectiveRoles.some((role) => AVAILABILITY_ROLES.includes(role));

// ---------------------------------------------------------------------------
// Which asset, and which window, a form is for
// ---------------------------------------------------------------------------

const BASELINE_PURPOSE = 'fleet-availability-baseline';

/** The two commands the page offers. */
export const AVAILABILITY_COMMANDS = ['declare', 'revoke'] as const;
export type AvailabilityCommand = (typeof AVAILABILITY_COMMANDS)[number];

const baselineSchema = z.object({
  assetId: z.string().min(1).max(200),
  command: z.enum(AVAILABILITY_COMMANDS),
  /** Only a revoke names a window. */
  windowId: z.string().min(1).max(200).optional(),
});

export type AvailabilityBaseline = z.infer<typeof baselineSchema>;

/**
 * The asset — and, for a revoke, the window — a form was drawn for, signed for
 * this session. A value bound to the action by a client component is one the
 * browser sends back, so nothing about it is trusted: the runner refuses a bound
 * id that is not the one signed here. fleet-service still decides on every send
 * and answers another organization's machine or window as a missing one.
 */
export function sealAvailabilityBaseline(
  session: WebSession,
  baseline: AvailabilityBaseline,
): string {
  return signPayload(
    session,
    BASELINE_PURPOSE,
    { ...baseline },
    webServerEnv().WEB_SESSION_MAX_AGE_SECONDS,
  );
}

/**
 * The baseline, if `token` is one this session was given for `command`;
 * otherwise `null` — one answer for forged, somebody else's, expired, minted
 * for the other command and from an earlier login.
 */
export function openAvailabilityBaseline(
  session: WebSession,
  token: unknown,
  command: AvailabilityCommand,
): AvailabilityBaseline | null {
  const payload = verifyPayload(session, BASELINE_PURPOSE, token, baselineSchema);
  if (!payload || payload.command !== command) return null;
  // A revoke without its window, or a declare with one, is not a token this
  // server issued.
  if ((command === 'revoke') !== (payload.windowId !== undefined)) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const blockerSchema = z.object({
  code: z.string(),
  owner: z.string(),
  /** fleet-service's English sentence — kept for the fallback, never parsed. */
  detail: z.string(),
  /** For `DISPATCH_BLOCKED`: which safety cause, so no sentence is parsed. */
  cause: z.string().optional(),
  /** For an insurance cause: the lapsed coverages. */
  coverages: z.array(z.string()).optional(),
});

export type AvailabilityBlocker = z.infer<typeof blockerSchema>;

const availabilitySchema = z.object({
  items: z.array(
    z.object({
      assetId: z.string(),
      available: z.boolean(),
      blockers: z.array(blockerSchema),
      currentAssignment: z
        .object({ id: z.string(), driverId: z.string(), startedAt: z.string() })
        .nullable()
        .default(null),
    }),
  ),
});

/** One machine's composed answer; `null` when fleet-service has no record of it (yet). */
export type MachineAvailability = z.infer<typeof availabilitySchema>['items'][number];

const windowSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  available: z.boolean(),
  fromAt: z.string(),
  toAt: z.string().nullable().default(null),
  reason: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable().default(null),
});

export type AvailabilityWindow = z.infer<typeof windowSchema>;

const windowsSchema = z.object({
  items: z.array(windowSchema),
  hasMore: z.boolean().default(false),
});

export type AvailabilityWindows = z.infer<typeof windowsSchema>;

/** How many declarations the page lists; the service pages further. */
export const WINDOWS_PER_PAGE = 20;

export async function fetchAvailability(
  session: WebSession,
  assetId: string,
): Promise<ReadResult<MachineAvailability | null>> {
  // The id goes in a query value, so it is encoded rather than interpolated.
  const result = await readFromGateway(
    session,
    `/v1/fleet/availability?assetId=${encodeURIComponent(assetId)}&limit=1`,
    availabilitySchema,
  );
  if (result.kind !== 'OK') return result;
  // The service filters by `assetId`; a row for another machine is never trusted.
  const own = result.data.items.find((item) => item.assetId === assetId);
  return { kind: 'OK', data: own ?? null };
}

export function fetchAvailabilityWindows(
  session: WebSession,
  assetId: string,
): Promise<ReadResult<AvailabilityWindows>> {
  return readFromGateway(
    session,
    `/v1/fleet/availability/windows?assetId=${encodeURIComponent(assetId)}&limit=${WINDOWS_PER_PAGE}`,
    windowsSchema,
  );
}

/**
 * Where a declaration stands at `now`: withdrawn, finished, not begun, or in
 * force. `now` is the clock of the server that draws the page — passed in so a
 * test pins it, and a client component, whose clock is the visitor's, never has
 * one. The service reads "in force" as `from <= now <= to` with an open end
 * meaning until revoked; an instant that cannot be read is `ENDED`, never
 * `IN_FORCE`: a declaration whose dates are unknown must not look current.
 */
export function windowStateOf(window: AvailabilityWindow, now: Date): WindowState {
  if (window.revokedAt !== null) return 'REVOKED';
  const from = Date.parse(window.fromAt);
  const to = window.toAt === null ? Number.POSITIVE_INFINITY : Date.parse(window.toAt);
  const at = now.getTime();
  if (Number.isNaN(from) || Number.isNaN(to) || Number.isNaN(at)) return 'ENDED';
  if (at < from) return 'SCHEDULED';
  if (at > to) return 'ENDED';
  return 'IN_FORCE';
}

/** A declaration the person can still withdraw: not begun, or in force. */
export const isRevocable = (state: WindowState): boolean =>
  state === 'IN_FORCE' || state === 'SCHEDULED';

// ---------------------------------------------------------------------------
// What a person types
// ---------------------------------------------------------------------------

/**
 * The reason's bounds (`declareAvailabilitySchema`: `displayText(3, 500)`) —
 * pinned by the contract spec, which reads them out of the service's source.
 */
export const AVAILABILITY_BOUNDS = { reason: { min: 3, max: 500 } } as const;

/** An optional calendar day, as the Tehran-midnight instant the service takes. */
const optionalDate = z.string().transform((raw, ctx): string | undefined => {
  if (raw.trim() === '') return undefined;
  const iso = localDateToIso(raw);
  if (iso === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: DATE_MESSAGE });
    return z.NEVER;
  }
  return iso;
});

export const END_NOT_AFTER_START_MESSAGE = 'پایان باید پس از آغاز باشد';

export function declareAvailabilityFormValues(form: FormData): DeclareAvailabilityFormValues {
  return readFields(form, DECLARE_AVAILABILITY_FIELDS);
}

export const declareAvailabilityFormSchema = z
  .object({
    available: z.enum(AVAILABILITY_CHOICES, {
      errorMap: () => ({ message: 'وضعیت را از فهرست انتخاب کنید' }),
    }),
    reason: displayText(
      'دلیل',
      AVAILABILITY_BOUNDS.reason.min,
      AVAILABILITY_BOUNDS.reason.max,
    ).refine((value) => !BIDI_CONTROL.test(value), BIDI_CONTROL_MESSAGE),
    fromAt: optionalDate,
    toAt: optionalDate,
  })
  .strict()
  .superRefine((value, ctx) => {
    // The service's own rule, only where both days were typed: without a start
    // it means "now", which the portal's clock must not guess at.
    if (value.fromAt !== undefined && value.toAt !== undefined) {
      if (Date.parse(value.toAt) <= Date.parse(value.fromAt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['toAt'],
          message: END_NOT_AFTER_START_MESSAGE,
        });
      }
    }
  })
  // The service's types: `available` is a boolean, and a blank day is absent.
  .transform(({ available, fromAt, toAt, ...rest }) => ({
    ...rest,
    available: available === 'true',
    ...(fromAt !== undefined ? { fromAt } : {}),
    ...(toAt !== undefined ? { toAt } : {}),
  }));

/** What fleet-service accepts on `POST /v1/fleet/availability`, less the `assetId` the page supplies. */
export type DeclareAvailabilityBody = z.output<typeof declareAvailabilityFormSchema>;

export type ParsedDeclareForm =
  | { readonly ok: true; readonly body: DeclareAvailabilityBody }
  | {
      readonly ok: false;
      readonly fieldErrors: Partial<Record<DeclareAvailabilityField, string>>;
    };

export function parseDeclareAvailabilityForm(
  values: DeclareAvailabilityFormValues,
): ParsedDeclareForm {
  const parsed = declareAvailabilityFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, body: parsed.data };
  return {
    ok: false,
    fieldErrors: firstIssuePerField(parsed.error, (value): value is DeclareAvailabilityField =>
      (DECLARE_AVAILABILITY_FIELDS as readonly string[]).includes(value),
    ),
  };
}

// ---------------------------------------------------------------------------
// What the service says, in Persian
// ---------------------------------------------------------------------------

/** Said when a revoke names a declaration that is already withdrawn. */
export const ALREADY_REVOKED_MESSAGE =
  'این اعلام پیش‌تر باطل شده است. صفحه را تازه کنید تا وضعیت فعلی را ببینید.';

export const DECLARE_MESSAGES: Readonly<Record<string, string>> = {
  'This Idempotency-Key was already used with a different request body': RECORD_KEY_REUSED_MESSAGE,
  'toAt must be after fromAt': END_NOT_AFTER_START_MESSAGE,
};

export const DECLARE_MAPPING: FieldMapping<DeclareAvailabilityField> = {
  paths: { available: 'available', reason: 'reason', fromAt: 'fromAt', toAt: 'toAt' },
  messages: DECLARE_MESSAGES,
  byCode: { IDEMPOTENCY_KEY_REUSED: RECORD_KEY_REUSED_MESSAGE },
};

export const REVOKE_MESSAGES: Readonly<Record<string, string>> = {
  'This availability window has already been revoked': ALREADY_REVOKED_MESSAGE,
  'This availability window was revoked by another request': ALREADY_REVOKED_MESSAGE,
};

const REVOKE_MAPPING: FieldMapping<never> = {
  paths: {},
  messages: REVOKE_MESSAGES,
  byCode: { INVALID_STATE_TRANSITION: ALREADY_REVOKED_MESSAGE },
};

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const writtenSchema = z.object({ id: z.string().min(1) });
export type WrittenWindow = z.infer<typeof writtenSchema>;

export function declareAvailability(
  session: WebSession,
  assetId: string,
  body: DeclareAvailabilityBody,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenWindow, DeclareAvailabilityField>> {
  return writeThroughGateway(session, {
    path: '/v1/fleet/availability',
    // The asset is the page's own: it comes from the signed baseline, never a field.
    body: { assetId, ...body },
    // The bound submission id is the `Idempotency-Key`: fleet-service stores the
    // answer under it, so a second send is the first one's response.
    submissionId,
    schema: writtenSchema,
    mapping: DECLARE_MAPPING,
    fetchImpl,
  });
}

export function revokeAvailability(
  session: WebSession,
  windowId: string,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenWindow, never>> {
  return writeThroughGateway(session, {
    // The id goes in a path segment, so it is encoded rather than interpolated.
    path: `/v1/fleet/availability/${encodeURIComponent(windowId)}/revoke`,
    body: undefined,
    submissionId,
    schema: writtenSchema,
    mapping: REVOKE_MAPPING,
    fetchImpl,
  });
}
