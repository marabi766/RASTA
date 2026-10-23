import { z } from 'zod';

import { normalizePersianText, toPersianDigits } from '@/lib/format';
import {
  DISPUTE_COMMAND_FIELDS,
  DISPUTE_COMMAND_ROLES,
  DISPUTE_COMMANDS,
  DISPUTE_FIELD_LIMITS as LIMITS,
  DISPUTE_FROM_STATES,
  DISPUTE_TARGET_STATE,
  NEVER_ROLE,
  PLATFORM_ROLES,
  disputedThroughOrder,
  isDisputeCommand,
  type DisputeCommand,
  type DisputeField,
  type DisputeFormValues,
} from '@/lib/transaction-dispute-fields';

import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import { utcInstant } from './instant';
import type { WebSession } from './session';
import type { ReadResult } from './assets';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';

export type { ReadResult };

/**
 * Reading one transaction, and opening or resolving its dispute, through the
 * gateway (EXP-003; `GET /v1/transactions/:id`, `POST …/dispute`,
 * `POST …/resolve-dispute` in economic-service's `transaction.controller.ts`).
 *
 * ## Reading
 *
 * Every field the screen renders is declared, and every one economic-service
 * always sends (`toTransactionView`) is **required**: a missing field makes the
 * answer `MALFORMED`, never "no dispute" or "not settled". A field the service
 * types `T | null` is `.nullable()` — an explicit `null` is a real answer — and
 * nothing is defaulted. `createdBy`, `legs` and `commission` are not declared,
 * so Zod drops them: nothing renders them, and a React tree is serialized into
 * the page.
 *
 * ## Money
 *
 * Amounts stay decimal strings end to end (ADR-022): checked to be whole minor
 * units, never turned into a `number`, only formatted.
 *
 * ## Writing
 *
 * The `transactions` prefix is `requiresIdempotencyKey` at the gateway and both
 * commands require the key again in the service, which really replays: the same
 * key with the same body answers with the stored result. The form's submission
 * id is that key, exactly as for placing an order (`place-order.ts`), and the
 * same rule follows: only a definite refusal (a 4xx with a problem body) means
 * "not done"; every `UNAVAILABLE` is unconfirmed.
 *
 * ## Refusals
 *
 * Rendered as fixed Persian text, keyed by the platform error code, with a
 * fallback: the service's own sentence is never shown (it is English and names
 * states and ids).
 */

/** Whole minor units as a string — never parsed into a `number` here. */
const minorUnits = z.string().regex(/^-?\d+$/, 'amount must be whole minor units');

const transactionSchema = z.object({
  id: z.string().min(1),
  /** The payer. */
  organizationId: z.string(),
  /** The payee; `null` for an obligation with no counterparty. */
  counterpartyOrganizationId: z.string().nullable(),
  transactionType: z.string(),
  status: z.string(),
  grossAmountMinor: minorUnits,
  commissionAmountMinor: minorUnits,
  netAmountMinor: minorUnits,
  currency: z.string(),
  occurredAt: utcInstant,
  sourceType: z.string().nullable(),
  sourceReference: z.string().nullable(),
  disputedAt: utcInstant.nullable(),
  /**
   * The reason the last dispute was raised with. A resolution no longer
   * overwrites it (#322, docs/23 D-060) — except on rows resolved before that
   * migration, which hold the resolution here with `disputeResolution` null.
   */
  disputeReason: z.string().nullable(),
  /** When the last resolution was decided; it may be an earlier dispute's. */
  disputeResolvedAt: utcInstant.nullable(),
  /** The last resolution's text, in its own field (D-060); null before it. */
  disputeResolution: z.string().nullable(),
  /**
   * The dispute the transaction holds or last held (docs/23 D-053): a new one on
   * every move into `DISPUTED`, kept until the next. A resolution names it, so a
   * decision about one dispute can never clear another raised since. `null` for
   * a transaction never disputed.
   */
  disputeId: z.string().min(1).nullable(),
  /**
   * The dispute the last resolution decided, recorded by economic-service
   * (task 061, docs/23 D-060): equal to `disputeId`, the resolution is the
   * latest dispute's; different, an earlier one's. `null` before any
   * resolution, and on rows resolved before it was kept that economic could
   * not attribute for certain — there the screen shows the resolution as the
   * transaction's last, says it cannot tell which dispute it decided, and
   * never infers it from the times (Codex on PR 352 round 2).
   */
  resolvedDisputeId: z.string().min(1).nullable(),
  settledAt: utcInstant.nullable(),
  /** The cancellation, refund or failure reason. */
  failureReason: z.string().nullable(),
  createdAt: utcInstant,
  settlement: z.object({ id: z.string().min(1), settledAt: utcInstant }).nullable(),
});

export type Transaction = z.infer<typeof transactionSchema>;

/** Exposed so a test can prove which fields are required and which are nullable. */
export const TRANSACTION_SCHEMA = transactionSchema;

export async function fetchTransaction(
  session: WebSession,
  transactionId: string,
): Promise<ReadResult<Transaction>> {
  try {
    const response = await callGateway<unknown>({
      baseUrl: webServerEnv().API_GATEWAY_URL,
      path: `/v1/transactions/${encodeURIComponent(transactionId)}`,
      accessToken: session.accessToken,
    });

    const parsed = transactionSchema.safeParse(response.data);
    if (!parsed.success) return { kind: 'MALFORMED', correlationId: response.correlationId };
    return { kind: 'OK', data: parsed.data };
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      if (error.status === 403) return { kind: 'FORBIDDEN' };
      // economic-service answers 404, never 403, for a transaction the caller
      // is not a party to (`assertTransactionVisible`): a 403 would confirm it
      // exists. The screen renders it as absent for the same reason.
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Which commands to offer
// ---------------------------------------------------------------------------

export interface DisputeViewer {
  /**
   * The roles the service will act on for this request — read from the access
   * token (`tokenAuthority`), never from `/v1/users/me` — or `null` when they
   * could not be read.
   */
  readonly roles: readonly string[] | null;
  /** The organization the request resolves to — the token's `org_id`, the one the service compares. */
  readonly organizationId: string | null;
}

/**
 * The commands worth drawing a form for. **UX, not access control**: hiding a
 * form refuses nobody, and economic-service decides on every request. It
 * mirrors exactly what the service would refuse, and nothing else:
 *
 * - `AUDITOR` never (`assertNotAuditor`, before any role is looked at);
 * - the route's `@Roles` (`DISPUTE_COMMAND_ROLES`);
 * - the state machine (`DISPUTE_FROM_STATES`): from any other state the
 *   answer is `409 INVALID_STATE_TRANSITION`;
 * - `canCommitOrganization(transaction.organizationId)`: a platform role, or
 *   the payer's own organization — the payee's administrator gets `403`.
 *
 * And one product rule (Q-138): a `MARKETPLACE_ORDER` transaction is disputed
 * only through its order, so neither command is offered on it. A resolution is
 * offered only with a `disputeId` to name (D-053): every move into `DISPUTED`
 * gets one, so a disputed transaction without it is a view this portal cannot
 * bind a decision to.
 *
 * Roles that could not be read offer nothing: a form that leads to a refusal is
 * the worse mistake, and the page still shows the transaction.
 */
export function disputeCommandsFor(
  transaction: Pick<
    Transaction,
    'status' | 'organizationId' | 'transactionType' | 'sourceType' | 'sourceReference' | 'disputeId'
  >,
  viewer: DisputeViewer,
): readonly DisputeCommand[] {
  const { roles } = viewer;
  if (roles === null || roles.includes(NEVER_ROLE)) return [];
  if (disputedThroughOrder(transaction) !== null) return [];
  const platform = PLATFORM_ROLES.some((role) => roles.includes(role));
  const commitsPayer = platform || viewer.organizationId === transaction.organizationId;

  return DISPUTE_COMMANDS.filter(
    (command) =>
      DISPUTE_FROM_STATES[command].includes(transaction.status) &&
      DISPUTE_COMMAND_ROLES[command].some((role) => roles.includes(role)) &&
      commitsPayer &&
      // A resolution must name the dispute it decides; with none to name, none is offered.
      (command !== 'RESOLVE_DISPUTE' || transaction.disputeId !== null),
  );
}

// ---------------------------------------------------------------------------
// Issuing a command
// ---------------------------------------------------------------------------

export interface DisputeFormInput {
  readonly command: string;
  readonly values: DisputeFormValues;
}

export function disputeFormValues(form: FormData): DisputeFormInput {
  const text = (name: string): string => {
    const value = form.get(name);
    return typeof value === 'string' ? normalizePersianText(value) : '';
  };
  return {
    command: text('command'),
    values: { reason: text('reason'), resolution: text('resolution') },
  };
}

const digits = (limit: number): string => toPersianDigits(String(limit));

const textSchema = (field: DisputeField, what: string, why: string) =>
  z
    .string()
    .trim()
    .min(LIMITS[field].min, `${what} را دست‌کم در ${digits(LIMITS[field].min)} نویسه بنویسید${why}`)
    .max(LIMITS[field].max, `${what} نباید بیش از ${digits(LIMITS[field].max)} نویسه باشد`);

const COMMAND_SCHEMAS = {
  DISPUTE: z.object({
    reason: textSchema('reason', 'دلیل اعتراض', ' — کسی که رسیدگی می‌کند باید بداند موضوع چیست'),
  }),
  RESOLVE_DISPUTE: z.object({ resolution: textSchema('resolution', 'شرح تصمیم', '') }),
} satisfies Record<DisputeCommand, z.ZodTypeAny>;

/** The path under `/v1/transactions/:id` each command posts to. */
const COMMAND_PATHS: Readonly<Record<DisputeCommand, string>> = {
  DISPUTE: 'dispute',
  RESOLVE_DISPUTE: 'resolve-dispute',
};

export interface DisputeCommandRequest {
  readonly command: DisputeCommand;
  /**
   * Exactly the body the command's `.strict()` DTO accepts: its one text field,
   * and for a resolution the dispute it decides ({@link boundDisputeRequest}).
   */
  readonly body: Readonly<Partial<Record<DisputeField, string>> & { disputeId?: string }>;
}

export type ParsedDisputeCommand =
  | { readonly ok: true; readonly request: DisputeCommandRequest }
  | {
      readonly ok: false;
      /** `null` when the command itself was not one the portal knows. */
      readonly command: DisputeCommand | null;
      readonly fieldErrors: Partial<Record<DisputeField, string>>;
    };

/**
 * One form's values, into exactly the body that command's DTO accepts. Both
 * DTOs are `.strict()`, so a command gets only its own field.
 */
export function parseDisputeCommand(input: DisputeFormInput): ParsedDisputeCommand {
  if (!isDisputeCommand(input.command)) return { ok: false, command: null, fieldErrors: {} };

  const command = input.command;
  const field = DISPUTE_COMMAND_FIELDS[command];
  const parsed = COMMAND_SCHEMAS[command].safeParse(input.values);
  if (parsed.success) {
    const text = (parsed.data as Record<DisputeField, string>)[field];
    return { ok: true, request: { command, body: { [field]: text } } };
  }

  const fieldErrors: Partial<Record<DisputeField, string>> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if (key === field) fieldErrors[field] ??= issue.message;
  }
  return { ok: false, command, fieldErrors };
}

/**
 * The request as it is sent: a resolution carries the dispute its form was
 * drawn for — read from the submission's signed stamp, the same on every send
 * under that key — so economic-service applies it only while the transaction
 * still holds that dispute, and refuses it (`409 INVALID_STATE_TRANSITION`)
 * once another has replaced it (docs/23 D-053). Null for a resolution that has
 * no dispute to name: it is not sent. Opening a dispute names none.
 */
export function boundDisputeRequest(
  request: DisputeCommandRequest,
  disputeId: string | null,
): DisputeCommandRequest | null {
  if (request.command !== 'RESOLVE_DISPUTE') return request;
  if (disputeId === null) return null;
  return { ...request, body: { ...request.body, disputeId } };
}

const lengthRule = (field: DisputeField): string =>
  `دست‌کم ${digits(LIMITS[field].min)} و حداکثر ${digits(LIMITS[field].max)} نویسه بنویسید.`;

export const DISPUTE_FIELD_MAPPING: FieldMapping<DisputeField> = {
  paths: { reason: 'reason', resolution: 'resolution' },
  byCode: {
    VALIDATION_FAILED: `متن پذیرفته نشد؛ ${lengthRule('reason')}`,
    INVALID_STATE_TRANSITION:
      'وضعیت کنونی این تراکنش اجازهٔ این اقدام را نمی‌دهد؛ ممکن است در این فاصله تغییر کرده باشد. صفحه را تازه کنید و وضعیت را ببینید.',
    OPTIMISTIC_LOCK_FAILED:
      'این تراکنش هم‌زمان تغییر کرد و اقدام انجام نشد. صفحه را تازه کنید و وضعیت را ببینید.',
    IDEMPOTENCY_KEY_REUSED:
      'این فرم پیش‌تر با متن دیگری فرستاده شده بود و ممکن است آن درخواست انجام شده باشد. صفحه را تازه کنید و وضعیت تراکنش را ببینید.',
    CONFLICT: 'این فرم پیش‌تر فرستاده شده بود. صفحه را تازه کنید و وضعیت تراکنش را ببینید.',
  },
  // Never the service's own sentence: it is English and names states and ids.
  fallback: 'این درخواست پذیرفته نشد. صفحه را تازه کنید و وضعیت تراکنش را ببینید.',
};

/**
 * What a confirmed answer must look like: this transaction, in the state the
 * command leads to. A replay answers with the stored result, which is that same
 * state, so a 2xx that shows anything else cannot be told from "maybe" and is
 * unconfirmed (`writeThroughGateway`).
 */
const answerSchema = (transactionId: string, command: DisputeCommand) =>
  z.object({ id: z.literal(transactionId), status: z.literal(DISPUTE_TARGET_STATE[command]) });

export type DisputeCommandResult = Exclude<
  WriteResult<{ id: string; status: string }, DisputeField>,
  { readonly kind: 'UNAVAILABLE' }
>;

export async function issueDisputeCommand(
  session: WebSession,
  transactionId: string,
  request: DisputeCommandRequest,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<DisputeCommandResult> {
  const result = await writeThroughGateway(session, {
    path: `/v1/transactions/${encodeURIComponent(transactionId)}/${COMMAND_PATHS[request.command]}`,
    body: request.body,
    submissionId,
    schema: answerSchema(transactionId, request.command),
    mapping: DISPUTE_FIELD_MAPPING,
    fetchImpl,
  });
  // Every `UNAVAILABLE` — a 5xx, or a status with no problem body — is
  // unconfirmed, as for placing an order: only a definite refusal means "not done".
  if (result.kind === 'UNAVAILABLE') {
    return { kind: 'UNKNOWN_OUTCOME', correlationId: result.correlationId };
  }
  return result;
}

/** Exposed so a test can prove every command has a path. */
export const DISPUTE_COMMAND_TABLE = DISPUTE_COMMANDS.map((command) => ({
  command,
  path: COMMAND_PATHS[command],
}));
