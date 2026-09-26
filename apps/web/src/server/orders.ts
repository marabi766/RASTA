import { z } from 'zod';

import { normalizePersianText, toLatinDigits, toPersianDigits } from '@/lib/format';
import {
  DISPUTE_OUTCOMES,
  IRREVERSIBLE_COMMANDS,
  ORDER_COMMANDS,
  ORDER_FIELD_LIMITS as LIMITS,
  RESPONSIBILITIES,
  isOrderCommand,
  type OrderCommand,
  type OrderCommandField,
  type OrderCommandFormValues,
  type OrderListRole,
} from '@/lib/order-fields';

import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import type { WebSession } from './session';
import type { ReadResult } from './assets';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';

export type { ReadResult };

/**
 * Reading orders and issuing the seven order commands, through the gateway.
 *
 * Reads follow `assets.ts`; writes follow `usage.ts` and `drivers.ts`. The
 * `orders` prefix is `requiresIdempotencyKey` at the gateway and
 * marketplace-service requires the key again itself, so every command carries
 * the form's submission id as `Idempotency-Key` — and here, unlike identity,
 * the service really does replay: the same key with the same body returns the
 * original result instead of acting twice.
 *
 * ## Money
 *
 * Amounts stay strings end to end (ADR-022). The schema below checks they are
 * whole numbers of minor units and nothing converts them to `number` — a
 * rial total past 2^53 would lose digits silently, and a total a buyer is
 * about to release against must not be approximately right. `formatMoney`
 * takes the string as it arrived.
 */

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Whole minor units as a string — never parsed into a `number` here. */
const minorUnits = z.string().regex(/^-?\d+$/, 'amount must be whole minor units');

const orderLineSchema = z.object({
  offerId: z.string(),
  productId: z.string(),
  productName: z.string(),
  quantity: z.number().int(),
  unitPriceMinor: minorUnits,
  lineTotalMinor: minorUnits,
  currency: z.string(),
});

const orderSchema = z.object({
  id: z.string(),
  status: z.string(),
  buyerOrganizationId: z.string(),
  supplierOrganizationId: z.string(),
  totalAmountMinor: minorUnits,
  currency: z.string(),
  lines: z.array(orderLineSchema).default([]),
  confirmedAt: z.string().nullable().default(null),
  fulfilledAt: z.string().nullable().default(null),
  receiptConfirmedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  cancelledAt: z.string().nullable().default(null),
  cancellationReason: z.string().nullable().default(null),
  failureReason: z.string().nullable().default(null),
  createdAt: z.string(),
  /**
   * The commands *this viewer* may issue now, computed by marketplace-service
   * (`order-actions.ts`). Anything the portal does not recognise is dropped
   * rather than rendered as a button it cannot build a form for — and a
   * service that stops sending the field leaves the order with no actions,
   * which offers nothing rather than guessing.
   */
  availableActions: z
    .array(z.string())
    .default([])
    .transform((actions) => actions.filter(isOrderCommand)),
});

/**
 * `placedBy`, `economicTransactionId`, `economicSettlementId`, reminder counts
 * and `supplierQualification` are not declared, so Zod drops them: the screens
 * do not render them, and a React tree is serialized into the page.
 */
export type Order = z.infer<typeof orderSchema>;
export type OrderLine = z.infer<typeof orderLineSchema>;

const orderPageSchema = z.object({
  items: z.array(orderSchema),
  nextCursor: z.string().nullable().default(null),
});

export type OrderPage = z.infer<typeof orderPageSchema>;

export const ORDERS_PER_PAGE = 20;

export interface OrderListQuery {
  /** Which side of the order the caller is asking about — the service's own term. */
  readonly role: OrderListRole;
  readonly status?: string;
  readonly cursor?: string;
}

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
      // marketplace-service answers 404, not 403, for an order the caller is
      // not a party to — refusing by name would confirm the order exists. The
      // screen must render it as absent for the same reason.
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

export function fetchOrders(
  session: WebSession,
  query: OrderListQuery,
): Promise<ReadResult<OrderPage>> {
  const search = new URLSearchParams({ role: query.role, limit: String(ORDERS_PER_PAGE) });
  if (query.status) search.set('status', query.status);
  if (query.cursor) search.set('cursor', query.cursor);
  return read(session, `/v1/orders?${search.toString()}`, orderPageSchema);
}

export function fetchOrder(session: WebSession, orderId: string): Promise<ReadResult<Order>> {
  return read(session, `/v1/orders/${encodeURIComponent(orderId)}`, orderSchema);
}

// ---------------------------------------------------------------------------
// Issuing a command
// ---------------------------------------------------------------------------

export function orderCommandFormValues(form: FormData): OrderCommandFormValues {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? normalizePersianText(value) : '';
  };

  return {
    command: text('command'),
    reason: text('reason'),
    note: text('note'),
    trackingReference: text('trackingReference'),
    outcome: text('outcome'),
    resolution: text('resolution'),
    responsibility: text('responsibility'),
    rating: toLatinDigits(text('rating')),
    comment: text('comment'),
    acknowledge: text('acknowledge'),
  };
}

/** An optional free-text field: blank means "not given", so it is left out. */
const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .transform((value) => (value.length === 0 ? undefined : value));

/**
 * A limit as it appears inside a message a person reads: Persian digits, at
 * the last moment. The limit itself stays a number, and is what the schema
 * enforces (docs/16 § 16.3).
 */
const digits = (limit: number): string => toPersianDigits(String(limit));

const COMMAND_SCHEMAS = {
  // `confirm` takes no body. `{}` is sent so the request is a well-formed JSON
  // post like every other, and the service ignores it.
  CONFIRM: z.object({}),

  FULFILL: z.object({
    trackingReference: optionalText(
      LIMITS.trackingReference.max,
      `کد رهگیری نباید بیش از ${digits(LIMITS.trackingReference.max)} نویسه باشد`,
    ),
    note: optionalText(
      LIMITS.note.max,
      `یادداشت نباید بیش از ${digits(LIMITS.note.max)} نویسه باشد`,
    ),
  }),

  CONFIRM_RECEIPT: z.object({
    note: optionalText(
      LIMITS.note.max,
      `یادداشت نباید بیش از ${digits(LIMITS.note.max)} نویسه باشد`,
    ),
  }),

  RAISE_DISPUTE: z.object({
    reason: z
      .string()
      .trim()
      .min(
        LIMITS.disputeReason.min,
        `دلیل اختلاف را دست‌کم در ${digits(LIMITS.disputeReason.min)} نویسه بنویسید — کسی که رسیدگی می‌کند باید بداند موضوع چیست`,
      )
      .max(
        LIMITS.disputeReason.max,
        `دلیل نباید بیش از ${digits(LIMITS.disputeReason.max)} نویسه باشد`,
      ),
  }),

  RESOLVE_DISPUTE: z.object({
    outcome: z.enum(DISPUTE_OUTCOMES, { errorMap: () => ({ message: 'نتیجه را انتخاب کنید' }) }),
    resolution: z
      .string()
      .trim()
      .min(
        LIMITS.resolution.min,
        `شرح تصمیم را دست‌کم در ${digits(LIMITS.resolution.min)} نویسه بنویسید`,
      )
      .max(LIMITS.resolution.max, `شرح نباید بیش از ${digits(LIMITS.resolution.max)} نویسه باشد`),
    // Required, never defaulted: ADR-052 rule 14 forbids reading
    // responsibility out of the outcome or out of free text.
    responsibility: z.enum(RESPONSIBILITIES, {
      errorMap: () => ({ message: 'مسئول را صریحاً مشخص کنید' }),
    }),
  }),

  CANCEL: z.object({
    reason: z
      .string()
      .trim()
      .min(LIMITS.cancelReason.min, 'دلیل لغو را بنویسید')
      .max(
        LIMITS.cancelReason.max,
        `دلیل نباید بیش از ${digits(LIMITS.cancelReason.max)} نویسه باشد`,
      ),
  }),

  REVIEW: z.object({
    rating: z
      .string()
      .regex(/^[1-5]$/, 'امتیازی از ۱ تا ۵ انتخاب کنید')
      .transform((value) => Number(value)),
    comment: optionalText(
      LIMITS.reviewComment.max,
      `نظر نباید بیش از ${digits(LIMITS.reviewComment.max)} نویسه باشد`,
    ),
  }),
} satisfies Record<OrderCommand, z.ZodTypeAny>;

/** The path under `/v1/orders/:id` each command posts to. */
const COMMAND_PATHS: Readonly<Record<OrderCommand, string>> = {
  CONFIRM: 'confirm',
  FULFILL: 'fulfill',
  CONFIRM_RECEIPT: 'confirm-receipt',
  RAISE_DISPUTE: 'disputes',
  RESOLVE_DISPUTE: 'disputes/resolve',
  CANCEL: 'cancel',
  REVIEW: 'reviews',
};

export interface OrderCommandRequest {
  readonly command: OrderCommand;
  readonly body: Record<string, unknown>;
}

export type ParsedOrderCommand =
  | { readonly ok: true; readonly request: OrderCommandRequest }
  | {
      readonly ok: false;
      /** `null` when the command itself was not one the portal knows. */
      readonly command: OrderCommand | null;
      readonly fieldErrors: Partial<Record<OrderCommandField, string>>;
    };

/**
 * One form's values, into exactly the body that command's DTO accepts.
 *
 * Every marketplace input schema is `.strict()`, so a field posted for another
 * command would be refused as unknown — each command therefore gets only its
 * own fields, and an optional field left blank is omitted rather than sent as
 * `""`.
 */
export function parseOrderCommand(values: OrderCommandFormValues): ParsedOrderCommand {
  if (!isOrderCommand(values.command)) {
    return { ok: false, command: null, fieldErrors: {} };
  }

  const command = values.command;
  const parsed = COMMAND_SCHEMAS[command].safeParse(values);

  // Checked here, on the server, not only by the checkbox's `required`: a
  // browser attribute is a convenience a crafted post does not have to honour,
  // and `CONFIRM_RECEIPT` is the one command that releases money to the
  // supplier (ADR-038). The service does not ask for this, so it is not part
  // of the body — it is the portal making sure a person meant it.
  const acknowledged = !IRREVERSIBLE_COMMANDS.has(command) || values.acknowledge === 'yes';

  if (parsed.success && acknowledged) {
    // Strip the `undefined`s the optional fields produced, so a blank note is
    // absent from the JSON rather than present as `null`.
    const body = Object.fromEntries(
      Object.entries(parsed.data as Record<string, unknown>).filter(([, v]) => v !== undefined),
    );
    return { ok: true, request: { command, body } };
  }

  const fieldErrors: Partial<Record<OrderCommandField, string>> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === 'string' && field !== 'command') {
        fieldErrors[field as OrderCommandField] ??= issue.message;
      }
    }
  }
  if (!acknowledged) {
    fieldErrors.acknowledge = 'برای ادامه تأیید کنید که این اقدام بازگشت‌پذیر نیست';
  }
  return { ok: false, command, fieldErrors };
}

export const ORDER_COMMAND_FIELD_MAPPING: FieldMapping<OrderCommandField> = {
  paths: {
    reason: 'reason',
    note: 'note',
    trackingReference: 'trackingReference',
    outcome: 'outcome',
    resolution: 'resolution',
    responsibility: 'responsibility',
    rating: 'rating',
    comment: 'comment',
  },
  messages: {},
};

export function issueOrderCommand(
  session: WebSession,
  orderId: string,
  request: OrderCommandRequest,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<{ id: string }, OrderCommandField>> {
  return writeThroughGateway(session, {
    path: `/v1/orders/${encodeURIComponent(orderId)}/${COMMAND_PATHS[request.command]}`,
    body: request.body,
    submissionId,
    // Every command answers with the order, except `reviews`, which answers
    // with the review. Both carry an `id`, which is all a redirect needs.
    schema: z.object({ id: z.string() }),
    mapping: ORDER_COMMAND_FIELD_MAPPING,
    fetchImpl,
  });
}

/** Exposed so a test can prove every command has a path and a schema. */
export const ORDER_COMMAND_TABLE = ORDER_COMMANDS.map((command) => ({
  command,
  path: COMMAND_PATHS[command],
}));
