import { z } from 'zod';

import {
  PHYSICAL_RETURN_STATUSES,
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
  /**
   * The physical half as marketplace-service mirrored it (#323): the shipment
   * it checked against this request, and when each step happened. Null while
   * the mirror is off — which it is by default — whatever the goods did.
   */
  returnShipmentId: z.string().min(1).nullable().default(null),
  inTransitAt: nullableDate,
  receivedAt: nullableDate,
  inspectedAt: nullableDate,
  resolvedAt: nullableDate,
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

/** A page of an order's own requests: the most `listReturnsQuerySchema` allows. */
const RETURNS_OF_ORDER_PAGE = 100;

/**
 * How many pages of an order's requests are followed before the count is
 * called incomplete: ten thousand requests, far past any real order, and a
 * bound on what one page view may ask of the service.
 */
const MAX_RETURN_PAGES = 100;

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

/**
 * Every page of a cursor-paged read, followed to its end — or `complete:
 * false` past `maxPages`. The first refusal or failure is the whole answer: a
 * count of part of the pages is not a count.
 */
async function readAllPages<T>(
  readPage: (
    cursor: string | undefined,
  ) => Promise<ReadResult<{ items: T[]; nextCursor: string | null }>>,
  maxPages: number,
): Promise<ReadResult<{ items: T[]; complete: boolean }>> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await readPage(cursor);
    if (result.kind !== 'OK') return result;
    items.push(...result.data.items);
    if (result.data.nextCursor === null) return { kind: 'OK', data: { items, complete: true } };
    cursor = result.data.nextCursor;
  }
  return { kind: 'OK', data: { items, complete: false } };
}

/** All the requests of one order this viewer's side lists, and whether that is all of them. */
export interface OrderReturnRequests {
  readonly items: ReturnRequest[];
  /** False when the pages were not followed to their end (`MAX_RETURN_PAGES`). */
  readonly complete: boolean;
}

/**
 * The requests of one order, on the side this viewer has in it — every page
 * (PR 336 review 1, finding 3): what a line still allows is sold less what
 * **every** open request takes, so the pages are followed to their end.
 */
export function fetchReturnsOfOrder(
  session: WebSession,
  orderId: string,
  side: ReturnListSide,
  maxPages: number = MAX_RETURN_PAGES,
): Promise<ReadResult<OrderReturnRequests>> {
  return readAllPages(
    (cursor) =>
      fetchReturns(session, {
        side,
        orderId,
        limit: RETURNS_OF_ORDER_PAGE,
        ...(cursor ? { cursor } : {}),
      }),
    maxPages,
  );
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
  /** The owner of the destination warehouse: who recorded it. */
  organizationId: z.string().min(1),
  /** The organization the goods come from, as the recorder said — never checked by inventory. */
  buyerOrganizationId: z.string().min(1),
  /** The marketplace references, as the recorder said — opaque to inventory. */
  returnRequestId: z.string().min(1),
  orderId: z.string().min(1),
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
 * `destinationWarehouseId` and `inspectionReportDocumentId` are not declared:
 * the screen does not show a warehouse or open a document.
 */
export type ReturnShipment = z.infer<typeof returnShipmentSchema>;

const returnShipmentPageSchema = z.object({
  items: z.array(returnShipmentSchema),
  nextCursor: z.string().nullable().default(null),
});

/** A page of return shipments; inventory-service caps a page at 100. */
const SHIPMENTS_PAGE = 50;
const MAX_SHIPMENT_PAGES = 20;

/**
 * Every return shipment inventory-service lists under one return request id,
 * as far as this caller's roles open a side of it (`INVENTORY_*_ROLES`,
 * ORGANIZATION_ADMIN by default) — every page. A refusal (`403`) is not the
 * return's: it only means this person is not shown the goods' side.
 *
 * **Listed is not verified** (PR 336 review 1, finding 1). inventory-service
 * never resolves the marketplace references a shipment carries: any
 * organization's operator can record a shipment into its own warehouse naming
 * any buyer and any return id, and the named buyer can read it as its sender.
 * What this returns is only a claim; `assessShipments` decides which of them
 * are this request's goods.
 */
export function fetchReturnShipments(
  session: WebSession,
  returnId: string,
  maxPages: number = MAX_SHIPMENT_PAGES,
): Promise<ReadResult<{ items: ReturnShipment[]; complete: boolean }>> {
  return readAllPages((cursor) => {
    const search = new URLSearchParams({
      returnRequestId: returnId,
      limit: String(SHIPMENTS_PAGE),
    });
    if (cursor) search.set('cursor', cursor);
    return read(session, `/v1/return-shipments?${search.toString()}`, returnShipmentPageSchema);
  }, maxPages);
}

/** The request's statuses a shipment may be this request's progress in (`decideMirror`). */
const SHIPPABLE_STATUSES: readonly string[] = ['AUTHORIZED', ...PHYSICAL_RETURN_STATUSES];

/**
 * Whether a listed shipment is this request's goods — the checks
 * marketplace-service's mirror makes before it moves a request
 * (`return-mirror.ts`, `decideMirror`), made again here on what inventory lists:
 *
 * - its marketplace references are this request's and this order's;
 * - it was recorded by **the request's supplier** (the warehouse's owner, Q-133)
 *   and names **the request's buyer** as the sender;
 * - the request was authorized and not withdrawn or refused;
 * - once marketplace-service has mirrored a shipment, it is that one — and its
 *   lines are lines of the request, of their product, at most what was
 *   authorized (the mirror checked them under its own dispatch rule);
 * - while nothing is mirrored (the mirror is off by default), its lines are
 *   **exactly** the request's — every line once, its product, the quantity
 *   authorized — the strict rule, because the portal cannot know whether
 *   partial dispatch is allowed (`MARKETPLACE_RETURN_PARTIAL_DISPATCH_ALLOWED`);
 *   a legitimate partial dispatch is then shown as unverified, never the reverse;
 * - what was received is at most what was dispatched, and every disposition is
 *   of a line of the shipment, within what was received.
 *
 * Anything else is a claim about this request that it does not bear out.
 */
export function isShipmentOfRequest(shipment: ReturnShipment, request: ReturnRequest): boolean {
  if (
    shipment.returnRequestId !== request.id ||
    shipment.orderId !== request.orderId ||
    shipment.organizationId !== request.supplierOrganizationId ||
    shipment.buyerOrganizationId !== request.buyerOrganizationId ||
    !SHIPPABLE_STATUSES.includes(request.status)
  ) {
    return false;
  }
  if (request.returnShipmentId !== null && request.returnShipmentId !== shipment.id) return false;

  const requested = new Map(request.lines.map((line) => [line.orderLineId, line]));
  const seen = new Set<string>();
  for (const line of shipment.lines) {
    const own = requested.get(line.orderLineId);
    if (!own || own.productId !== line.productId || seen.has(line.orderLineId)) return false;
    seen.add(line.orderLineId);
    if (line.expectedQuantity < 1 || line.expectedQuantity > own.quantity) return false;
    if (request.returnShipmentId === null && line.expectedQuantity !== own.quantity) return false;
    if (
      line.receivedQuantity !== null &&
      (line.receivedQuantity < 0 || line.receivedQuantity > line.expectedQuantity)
    ) {
      return false;
    }
  }
  if (shipment.lines.length === 0) return false;
  if (request.returnShipmentId === null && seen.size !== requested.size) return false;

  const received = new Map(
    shipment.lines.map((line) => [line.orderLineId, line.receivedQuantity ?? 0]),
  );
  const disposed = new Map<string, number>();
  for (const row of shipment.dispositions) {
    if (!received.has(row.orderLineId) || row.quantity < 1) return false;
    disposed.set(row.orderLineId, (disposed.get(row.orderLineId) ?? 0) + row.quantity);
  }
  for (const [orderLineId, quantity] of disposed) {
    if (quantity > received.get(orderLineId)!) return false;
  }
  return true;
}

/** What the portal can say about a request's goods, from what inventory listed. */
export type ShipmentAssessment =
  | {
      readonly kind: 'KNOWN';
      /** The shipments that are this request's goods (`isShipmentOfRequest`). */
      readonly verified: readonly ReturnShipment[];
      /** How many listed shipments claim this request and are not borne out — shown as a count, never as progress. */
      readonly unverified: number;
    }
  /** Not shown to this role, not read, or not read in full: nothing can be concluded. */
  | {
      readonly kind: 'UNKNOWN';
      readonly reason: 'FORBIDDEN' | 'UNAVAILABLE' | 'INCOMPLETE';
      readonly correlationId?: string;
    };

export function assessShipments(
  request: ReturnRequest,
  listed: ReadResult<{ items: readonly ReturnShipment[]; complete: boolean }>,
): ShipmentAssessment {
  if (listed.kind === 'FORBIDDEN' || listed.kind === 'NOT_FOUND') {
    return { kind: 'UNKNOWN', reason: 'FORBIDDEN' };
  }
  if (listed.kind === 'UNAVAILABLE' || listed.kind === 'MALFORMED') {
    return { kind: 'UNKNOWN', reason: 'UNAVAILABLE', correlationId: listed.correlationId };
  }
  // A shipment that never named this request is not counted at all.
  const claims = listed.data.items.filter((shipment) => shipment.returnRequestId === request.id);
  // Pages not followed to their end may hold the shipment that is the request's.
  if (!listed.data.complete) return { kind: 'UNKNOWN', reason: 'INCOMPLETE' };
  const verified = claims.filter((shipment) => isShipmentOfRequest(shipment, request));
  return { kind: 'KNOWN', verified, unverified: claims.length - verified.length };
}

/**
 * Whether goods of the request are on their way or further:
 *
 * - `MOVING` — marketplace-service mirrored a shipment or a physical step, or a
 *   verified shipment is listed;
 * - `NONE` — the request is not authorized (no shipment can be its progress),
 *   or inventory's answer was read in full and none of it is this request's;
 * - `UNKNOWN` — for an authorized request whose goods' side was not shown to
 *   this person, could not be read, or not read in full.
 */
export type GoodsState = 'NONE' | 'MOVING' | 'UNKNOWN';

export function goodsStateOf(request: ReturnRequest, shipments: ShipmentAssessment): GoodsState {
  if (
    request.returnShipmentId !== null ||
    request.inTransitAt !== null ||
    PHYSICAL_RETURN_STATUSES.includes(request.status as ReturnStatus)
  ) {
    return 'MOVING';
  }
  if (request.status !== 'AUTHORIZED') return 'NONE';
  if (shipments.kind === 'UNKNOWN') return 'UNKNOWN';
  return shipments.verified.length > 0 ? 'MOVING' : 'NONE';
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

/**
 * The statuses whose lines no longer take units of the order
 * (`RETURN_STATUSES_HOLDING_UNITS` is every other one): a request refused or
 * withdrawn. Goods on the road, received or resolved were returned and are not
 * returnable again — and a status this portal does not know is counted as
 * taking its units, never as freeing them.
 */
const RELEASING_STATUSES: readonly string[] = ['REJECTED', 'CANCELLED'];

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

/**
 * Whether this caller is the request's buyer in a role that may withdraw it —
 * `@Roles` of the cancellation, then `assertBuyer`.
 */
function mayWithdraw(caller: ReturnCaller, request: ReturnRequest): boolean {
  return (
    caller.organizationId !== null &&
    rolesGuardAdmits(caller.roles, RETURN_CANCEL_ROLES) &&
    holdsAny(caller.roles, BUYER_ROLES) &&
    caller.organizationId === request.buyerOrganizationId
  );
}

/**
 * The commands on `request` marketplace-service would take from this caller
 * now — **and**, for the withdrawal, only while no goods of it are known to be
 * moving (PR 336 review 1, finding 2). marketplace-service still says
 * AUTHORIZED after a dispatch while its mirror is off, and a withdrawal then
 * releases units that are on their way back, so the buyer could ask for the
 * same units again. The portal withholds it whenever goods are `MOVING` or
 * their state is `UNKNOWN` (`goodsStateOf`); `cancelWithheldFor` says why.
 * The service's own guard is separate backend work.
 */
export function returnCommandsFor(
  caller: ReturnCaller,
  request: ReturnRequest,
  goods: GoodsState,
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
  if (
    mayWithdraw(caller, request) &&
    RETURN_COMMAND_FROM.CANCEL.includes(status) &&
    goods === 'NONE'
  ) {
    commands.push('CANCEL');
  }
  return commands;
}

/**
 * Why the buyer, who could otherwise withdraw this request, is not offered it:
 * the goods' state — said in fixed words (`RETURN_CANCEL_WITHHELD`) — or null.
 */
export function cancelWithheldFor(
  caller: ReturnCaller,
  request: ReturnRequest,
  goods: GoodsState,
): Exclude<GoodsState, 'NONE'> | null {
  if (goods === 'NONE' || !mayWithdraw(caller, request)) return null;
  return RETURN_COMMAND_FROM.CANCEL.includes(request.status as ReturnStatus) ||
    PHYSICAL_RETURN_STATUSES.includes(request.status as ReturnStatus)
    ? goods
    : null;
}

/**
 * What each line of the order still allows: sold, less what every request
 * still holding units takes (`openQuantities`). `null` for every line unless
 * **all** the order's requests were read (`OrderReturnRequests.complete`): a count of
 * part of them would offer units another request already took (PR 336 review
 * 1, finding 3), and the request form is then not offered.
 */
export function returnableLines(
  order: Order,
  requests: OrderReturnRequests | null,
): ReturnableLine[] {
  const known = requests !== null && requests.complete;
  const taken = new Map<string, number>();
  for (const request of known ? requests.items : []) {
    if (RELEASING_STATUSES.includes(request.status)) continue;
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
            available: known ? Math.max(0, line.quantity - (taken.get(line.id) ?? 0)) : null,
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
