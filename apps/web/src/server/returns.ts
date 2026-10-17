import { z } from 'zod';

import {
  RETURN_REFUSAL_TEXT as TEXT,
  REASON_FIELD,
  quantityField,
  type ReturnDecisionCommand,
  type ReturnListSide,
  type ReturnStatus,
} from '@/lib/return-fields';
import type { ReturnableLine, ReturnRequestBody } from '@/lib/return-request';

import type { ReadResult } from './assets';
import { webServerEnv } from './env';
import { callGateway, GatewayRequestError } from './gateway';
import { renderableDate } from './instant';
import type { Order } from './orders';
import { tokenAuthority } from './realm-roles';
import { rolesGuardAdmits } from './roles-guard';
import type { WebSession } from './session';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';

/**
 * Return requests through the gateway (EXP-003, RUN-005; ADR-048):
 * marketplace-service's request, decided by the supplier, withdrawn by the
 * buyer — and, read only, inventory-service's account of the goods coming
 * back.
 *
 * ## Who may do what — mirrored, not decided
 *
 * Neither the order nor the return view says what this caller may do with a
 * return (there is no `availableActions` for returns), so the forms a page
 * draws are copies of the service's own checks, from the roles **the access
 * token** carries for the organization it resolves to (`tokenAuthority`), in
 * the service's order:
 *
 * 1. `@Roles` of the route (`rolesGuardAdmits`: AUDITOR never, SYSTEM_ADMIN
 *    always), then
 * 2. `return-access.ts`: the buyer asks and withdraws, the supplier decides —
 *    `assertBuyer` / `assertSupplier` (`access.ts`), which compare the
 *    request's organization with the order's buyer or seller (a platform role
 *    is **not** exempt), then
 * 3. the state: a request only of a `COMPLETED` order (`RETURNABLE_ORDER_STATUS`,
 *    Q-132), a decision only of a `REQUESTED` request, a withdrawal of a
 *    `REQUESTED` or `AUTHORIZED` one (`RETURN_TRANSITIONS`).
 *
 * The **return window** is marketplace-service's configuration
 * (`MARKETPLACE_RETURN_WINDOW_DAYS`, no default — Q-132) and no endpoint
 * reports it, so the portal cannot know it: the request form is offered for a
 * completed order, and a window that is not configured or has elapsed is
 * learned from the refusal and said in fixed words. `returns.contract.spec.ts`
 * pins every copy here against the service's source. All of it is UX: the
 * service decides again on every request.
 *
 * ## Refusals
 *
 * Every business refusal is `422 BUSINESS_RULE_VIOLATION`, and the reason is
 * kept in the service's log, not its response — only the English sentence
 * differs. The sentences are classified (`RETURN_FIELD_MAPPING`) and said in
 * the portal's own fixed words; none is ever shown.
 */

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const returnLineSchema = z.object({
  orderLineId: z.string().min(1),
  productId: z.string().min(1),
  quantity: z.number().int().positive(),
});

const nullableDate = renderableDate.nullable().default(null);

const returnRequestSchema = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1),
  status: z.string().min(1),
  version: z.number().int().min(1),
  buyerOrganizationId: z.string().min(1),
  supplierOrganizationId: z.string().min(1),
  reason: z.string(),
  lines: z.array(returnLineSchema).default([]),
  requestedAt: renderableDate,
  authorizedAt: nullableDate,
  rejectedAt: nullableDate,
  cancelledAt: nullableDate,
  cancelledFrom: z.string().nullable().default(null),
});

/**
 * `requestedBy`, `authorizedBy`, `rejectedBy` and `cancelledBy` are platform
 * user ids: not declared, so Zod drops them — the screens name no person, and
 * a React tree is serialized into the page.
 */
export type ReturnRequest = z.infer<typeof returnRequestSchema>;

const returnPageSchema = z.object({
  items: z.array(returnRequestSchema),
  nextCursor: z.string().nullable().default(null),
});

export type ReturnPage = z.infer<typeof returnPageSchema>;

export const RETURNS_PER_PAGE = 20;

/** An order's own requests, on one page: an order has at most fifty lines to return. */
const RETURNS_OF_ORDER = 100;

export interface ReturnListQuery {
  readonly side: ReturnListSide;
  readonly status?: ReturnStatus;
  readonly orderId?: string;
  readonly cursor?: string;
  readonly limit?: number;
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
      // marketplace-service answers 404, not 403, to an organization that is
      // neither party — refusing by name would confirm the request exists. The
      // screen renders it exactly like an id that was never there.
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

export function fetchReturns(
  session: WebSession,
  query: ReturnListQuery,
): Promise<ReadResult<ReturnPage>> {
  const search = new URLSearchParams({
    role: query.side,
    limit: String(query.limit ?? RETURNS_PER_PAGE),
  });
  if (query.status) search.set('status', query.status);
  if (query.orderId) search.set('orderId', query.orderId);
  if (query.cursor) search.set('cursor', query.cursor);
  return read(session, `/v1/returns?${search.toString()}`, returnPageSchema);
}

/** The requests of one order, on the side this viewer has in it. */
export function fetchReturnsOfOrder(
  session: WebSession,
  orderId: string,
  side: ReturnListSide,
): Promise<ReadResult<ReturnPage>> {
  return fetchReturns(session, { side, orderId, limit: RETURNS_OF_ORDER });
}

export function fetchReturn(
  session: WebSession,
  returnId: string,
): Promise<ReadResult<ReturnRequest>> {
  return read(session, `/v1/returns/${encodeURIComponent(returnId)}`, returnRequestSchema);
}

// -- the goods coming back (inventory-service, read only) -------------------

const returnShipmentSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  returnRequestId: z.string().min(1),
  lines: z
    .array(
      z.object({
        orderLineId: z.string().min(1),
        productId: z.string().min(1),
        expectedQuantity: z.number().int(),
        receivedQuantity: z.number().int().nullable().default(null),
      }),
    )
    .default([]),
  carrierName: z.string().nullable().default(null),
  carrierReference: z.string().nullable().default(null),
  createdAt: renderableDate,
  receivedAt: nullableDate,
  inspectedAt: nullableDate,
  inspectionNote: z.string().nullable().default(null),
  resolvedAt: nullableDate,
  dispositions: z
    .array(
      z.object({
        orderLineId: z.string().min(1),
        disposition: z.string().min(1),
        quantity: z.number().int(),
      }),
    )
    .default([]),
});

/**
 * `organizationId`, `destinationWarehouseId`, `buyerOrganizationId` and
 * `inspectionReportDocumentId` are not declared: the screen does not show a
 * warehouse or open a document.
 */
export type ReturnShipment = z.infer<typeof returnShipmentSchema>;

const returnShipmentPageSchema = z.object({
  items: z.array(returnShipmentSchema),
  nextCursor: z.string().nullable().default(null),
});

/**
 * The return shipments inventory-service records for one return request — at
 * most one (Q-133) — as far as this caller's roles open a side of it
 * (`INVENTORY_*_ROLES`, ORGANIZATION_ADMIN by default). A refusal (`403`) is
 * not the return's: it only means this person is not shown the goods' side.
 */
export function fetchReturnShipments(
  session: WebSession,
  returnId: string,
): Promise<ReadResult<readonly ReturnShipment[]>> {
  const search = new URLSearchParams({ returnRequestId: returnId, limit: '5' });
  return read(
    session,
    `/v1/return-shipments?${search.toString()}`,
    returnShipmentPageSchema.transform((page) =>
      page.items.filter((shipment) => shipment.returnRequestId === returnId),
    ),
  );
}

// ---------------------------------------------------------------------------
// Who may do what (mirrors marketplace-service; pinned by the contract spec)
// ---------------------------------------------------------------------------

/** `@Roles` of `GET /v1/returns` and `GET /v1/returns/:id` (`return.controller.ts`). */
export const RETURN_READ_ROLES: readonly string[] = [
  'SYSTEM_ADMIN',
  'UNION_ADMIN',
  'ORGANIZATION_ADMIN',
  'PROCUREMENT_USER',
  'SUPPLIER',
];

/** `@Roles` of `POST /v1/orders/:orderId/returns`. */
export const RETURN_REQUEST_ROLES: readonly string[] = [
  'SYSTEM_ADMIN',
  'UNION_ADMIN',
  'ORGANIZATION_ADMIN',
  'PROCUREMENT_USER',
];

/** `@Roles` of `POST /v1/returns/:id/decisions`. */
export const RETURN_DECISION_ROLES: readonly string[] = [
  'SYSTEM_ADMIN',
  'UNION_ADMIN',
  'SUPPLIER',
  'ORGANIZATION_ADMIN',
];

/** `@Roles` of `POST /v1/returns/:id/cancellation`. */
export const RETURN_CANCEL_ROLES: readonly string[] = [
  'SYSTEM_ADMIN',
  'UNION_ADMIN',
  'ORGANIZATION_ADMIN',
  'PROCUREMENT_USER',
];

/** `BUYER_ROLES` (`access.ts`): who may act as the buyer, checked again by `assertBuyer`. */
const BUYER_ROLES: readonly string[] = [
  'SYSTEM_ADMIN',
  'UNION_ADMIN',
  'ORGANIZATION_ADMIN',
  'PROCUREMENT_USER',
];

/** `SUPPLIER_ROLES` (`access.ts`): who may act as the supplier, checked again by `assertSupplier`. */
const SUPPLIER_ROLES: readonly string[] = [
  'SYSTEM_ADMIN',
  'UNION_ADMIN',
  'SUPPLIER',
  'ORGANIZATION_ADMIN',
];

/** `RETURNABLE_ORDER_STATUS` (`return.service.ts`, Q-132): only a settled order. */
export const RETURNABLE_ORDER_STATUS = 'COMPLETED';

/** `RETURN_TRANSITIONS`: which statuses each command moves a request from. */
export const RETURN_COMMAND_FROM: Readonly<Record<ReturnDecisionCommand, readonly ReturnStatus[]>> =
  {
    AUTHORIZE: ['REQUESTED'],
    REJECT: ['REQUESTED'],
    CANCEL: ['REQUESTED', 'AUTHORIZED'],
  };

/** The statuses whose lines still take units of the order (`openQuantities`). */
const OPEN_STATUSES: readonly string[] = ['REQUESTED', 'AUTHORIZED'];

/** Who is asking, from the access token: the organization it acts for and its roles there. */
export interface ReturnCaller {
  readonly organizationId: string | null;
  readonly roles: readonly string[];
}

export function returnCallerOf(accessToken: string): ReturnCaller {
  const authority = tokenAuthority(accessToken);
  return authority ?? { organizationId: null, roles: [] };
}

/** Whether the Returns link and list are worth drawing (`@Roles` of the reads). */
export function canReadReturns(roles: readonly string[] | null): boolean {
  return roles !== null && rolesGuardAdmits(roles, RETURN_READ_ROLES);
}

/** `assertNotAuditor` + `hasAnyRole` of `assertBuyer` / `assertSupplier`. */
function holdsAny(roles: readonly string[], granted: readonly string[]): boolean {
  return !roles.includes('AUDITOR') && granted.some((role) => roles.includes(role));
}

/** Which side of an order this caller is on, if either — what its lists are asked with. */
export function sideOf(
  caller: ReturnCaller,
  parties: { readonly buyerOrganizationId: string; readonly supplierOrganizationId: string },
): ReturnListSide | null {
  if (caller.organizationId === null) return null;
  if (caller.organizationId === parties.buyerOrganizationId) return 'BUYER';
  if (caller.organizationId === parties.supplierOrganizationId) return 'SUPPLIER';
  return null;
}

/**
 * Whether marketplace-service would take a return request of `order` from
 * this caller — the window aside, which it alone knows (Q-132).
 */
export function canRequestReturn(caller: ReturnCaller, order: Order): boolean {
  return (
    caller.organizationId !== null &&
    rolesGuardAdmits(caller.roles, RETURN_REQUEST_ROLES) &&
    holdsAny(caller.roles, BUYER_ROLES) &&
    caller.organizationId === order.buyerOrganizationId &&
    order.status === RETURNABLE_ORDER_STATUS &&
    order.completedAt !== null &&
    order.lines.some((line) => line.id !== null)
  );
}

/** The commands on `request` marketplace-service would take from this caller now. */
export function returnCommandsFor(
  caller: ReturnCaller,
  request: ReturnRequest,
): ReturnDecisionCommand[] {
  if (caller.organizationId === null) return [];
  const status = request.status as ReturnStatus;
  const commands: ReturnDecisionCommand[] = [];
  const supplier =
    rolesGuardAdmits(caller.roles, RETURN_DECISION_ROLES) &&
    holdsAny(caller.roles, SUPPLIER_ROLES) &&
    caller.organizationId === request.supplierOrganizationId;
  if (supplier) {
    for (const command of ['AUTHORIZE', 'REJECT'] as const) {
      if (RETURN_COMMAND_FROM[command].includes(status)) commands.push(command);
    }
  }
  const buyer =
    rolesGuardAdmits(caller.roles, RETURN_CANCEL_ROLES) &&
    holdsAny(caller.roles, BUYER_ROLES) &&
    caller.organizationId === request.buyerOrganizationId;
  if (buyer && RETURN_COMMAND_FROM.CANCEL.includes(status)) commands.push('CANCEL');
  return commands;
}

/**
 * What each line of the order still allows: sold, less what open requests
 * already take (`openQuantities`). `null` for every line when the order's
 * requests could not be read — the service makes the check either way.
 */
export function returnableLines(
  order: Order,
  requests: readonly ReturnRequest[] | null,
): ReturnableLine[] {
  const taken = new Map<string, number>();
  for (const request of requests ?? []) {
    if (!OPEN_STATUSES.includes(request.status)) continue;
    for (const line of request.lines) {
      taken.set(line.orderLineId, (taken.get(line.orderLineId) ?? 0) + line.quantity);
    }
  }
  return order.lines.flatMap((line) =>
    line.id === null
      ? []
      : [
          {
            orderLineId: line.id,
            available:
              requests === null ? null : Math.max(0, line.quantity - (taken.get(line.id) ?? 0)),
          },
        ],
  );
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * How a refusal is said. The sentences come from marketplace-service's own
 * source (`return.service.ts`, `state-machine.ts`) and are pinned there by
 * `returns.contract.spec.ts`; each value or id in them is matched, never shown.
 */
const MESSAGES: Readonly<Record<string, string>> = {
  'Returns are not open: no return window is configured (open question Q-132)':
    TEXT.WINDOW_NOT_CONFIGURED,
};

export const RETURN_REFUSAL_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/^The \d+-day return window for order \S+ has elapsed$/, TEXT.WINDOW_ELAPSED],
  [
    /^Order \S+ is [A-Z_]+: goods are returned only from a COMPLETED order$/,
    TEXT.ORDER_NOT_COMPLETED,
  ],
  [/^Order line \S+ has \d+ unit\(s\) left to return, \d+ asked$/, TEXT.QUANTITY_EXCEEDS],
  [/^Return request \S+ is already [A-Z_]+ and cannot change further$/, TEXT.WRONG_STATE],
  [/^Return request \S+ cannot move from [A-Z_]+ to [A-Z_]+$/, TEXT.WRONG_STATE],
];

const BY_CODE: Readonly<Record<string, string>> = {
  BUSINESS_RULE_VIOLATION: TEXT.OTHER_RULE,
  // A request already filed under this key whose stored response is gone.
  CONFLICT: TEXT.ALREADY_FILED,
  IDEMPOTENCY_KEY_REUSED: TEXT.KEY_REUSED,
  OPTIMISTIC_LOCK_FAILED: TEXT.CHANGED,
  VALIDATION_FAILED: TEXT.VALIDATION,
};

/** A request's field mapping: the reason, and each sent line on its own quantity field. */
export function returnRequestFieldMapping(body: ReturnRequestBody): FieldMapping<string> {
  const paths: Record<string, string> = { reason: REASON_FIELD };
  body.lines.forEach((line, index) => {
    paths[`lines.${index}.quantity`] = quantityField(line.orderLineId);
  });
  return {
    paths,
    messages: MESSAGES,
    patterns: RETURN_REFUSAL_PATTERNS,
    byCode: BY_CODE,
    byDetailCode: { unknown_order_line: TEXT.UNKNOWN_LINE },
    fallback: TEXT.FALLBACK,
  };
}

export const RETURN_COMMAND_FIELD_MAPPING: FieldMapping<string> = {
  paths: {},
  messages: MESSAGES,
  patterns: RETURN_REFUSAL_PATTERNS,
  byCode: BY_CODE,
  fallback: TEXT.FALLBACK,
};

/** What a confirmed command answers with: the request, of which a redirect needs only the id. */
const answerSchema = z.object({ id: z.string().min(1), status: z.string().min(1) });

export type ReturnWriteResult = Exclude<
  WriteResult<z.infer<typeof answerSchema>, string>,
  { readonly kind: 'UNAVAILABLE' }
>;

/**
 * marketplace-service stores the idempotent response inside the command's own
 * transaction, but an answer can still be lost after it commits. Only a
 * definite refusal (a 4xx with a code) means "nothing was written": every
 * `UNAVAILABLE` — a 5xx, or a status with no problem body — is unconfirmed.
 */
function unconfirmedUnlessDefinite(
  result: WriteResult<z.infer<typeof answerSchema>, string>,
): ReturnWriteResult {
  return result.kind === 'UNAVAILABLE'
    ? { kind: 'UNKNOWN_OUTCOME', correlationId: result.correlationId }
    : result;
}

/** `POST /v1/orders/:orderId/returns` — the body exactly as `createReturnSchema` takes it. */
export async function issueReturnRequest(
  session: WebSession,
  orderId: string,
  body: ReturnRequestBody,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<ReturnWriteResult> {
  return unconfirmedUnlessDefinite(
    await writeThroughGateway(session, {
      path: `/v1/orders/${encodeURIComponent(orderId)}/returns`,
      body: { reason: body.reason, lines: body.lines },
      submissionId,
      schema: answerSchema,
      mapping: returnRequestFieldMapping(body),
      fetchImpl,
    }),
  );
}

/** Where each command on a request posts, and its whole body — two words, or none. */
export const RETURN_COMMAND_REQUESTS: Readonly<
  Record<ReturnDecisionCommand, { readonly path: string; readonly body: Record<string, string> }>
> = {
  AUTHORIZE: { path: 'decisions', body: { decision: 'AUTHORIZE' } },
  REJECT: { path: 'decisions', body: { decision: 'REJECT' } },
  // The cancellation takes no body; `{}` keeps every post a JSON post.
  CANCEL: { path: 'cancellation', body: {} },
};

/** Authorize, reject or cancel `returnId`. */
export async function issueReturnCommand(
  session: WebSession,
  returnId: string,
  command: ReturnDecisionCommand,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<ReturnWriteResult> {
  const { path, body } = RETURN_COMMAND_REQUESTS[command];
  return unconfirmedUnlessDefinite(
    await writeThroughGateway(session, {
      path: `/v1/returns/${encodeURIComponent(returnId)}/${path}`,
      body,
      submissionId,
      schema: answerSchema,
      mapping: RETURN_COMMAND_FIELD_MAPPING,
      fetchImpl,
    }),
  );
}
