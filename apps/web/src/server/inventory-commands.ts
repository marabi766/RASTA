import { z } from 'zod';

import {
  AMOUNT_FIELD,
  CONSIGNEE_FIELD,
  INVENTORY_REFUSAL_TEXT as TEXT,
  LATITUDE_FIELD,
  LONGITUDE_FIELD,
  NAME_FIELD,
  ORDER_FIELD,
  PRODUCT_FIELD,
  QUANTITY_FIELD,
  SOURCE_FIELD,
  STOCK_ITEM_FIELD,
  legField,
  type AdjustmentBody,
  type InventoryBody,
  type InventoryCommand,
  type ReceiptBody,
  type ShipmentBody,
  type WarehouseBody,
} from '@/lib/inventory-commands';

import { webServerEnv } from './env';
import { tokenAuthority } from './realm-roles';
import type { WebSession } from './session';
import type { ShipmentSummary } from './inventory';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';

/**
 * The operator commands of inventory-service, through the gateway (EXP-004
 * criterion 1 and 2; `warehouse`, `stock` and `shipment` controllers, ADR-056):
 * create a warehouse, receive stock, adjust it (which is also the direct issue
 * without a reservation), create a shipment, dispatch it and deliver it.
 *
 * ## One key, and where a retry is honest
 *
 * Every one of these takes a required `Idempotency-Key` and the service stores
 * its response (`IdempotencyStore`): the same key with the same body from the
 * same user answers the original response and does nothing again, so a retry
 * under the kept key is the same request. The portal's submission id is that
 * key, once per form (`submission.ts`). While the first is still being
 * processed the service answers `409 CONFLICT` with `Retry-After`, which
 * `write.ts` reads as `IN_PROGRESS` and a form treats as unconfirmed.
 *
 * ## Who may do what — mirrored, not decided
 *
 * No inventory view says what the caller may do (there is no
 * `availableActions`), so the forms a page draws are copies of the service's
 * own checks (`InventoryAccess.assertOperator`, `shipment.state-machine.ts`),
 * from the roles **the access token** carries for the organization it resolves
 * to (`tokenAuthority`): a role of the operator set (`WEB_INVENTORY_ROLES`,
 * mirroring `INVENTORY_OPERATOR_ROLES`) and neither `AUDITOR` nor
 * `SYSTEM_ADMIN`; a shipment is moved only by an operator of the organization
 * that owns its origin warehouse, and only from the status the move needs.
 * `inventory-commands.contract.spec.ts` pins every copy against the service's
 * source and the published OpenAPI document. All of it is UX: the service
 * decides again on every request.
 *
 * ## Refusals
 *
 * Every documented refusal is said in fixed words (`INVENTORY_REFUSAL_TEXT`),
 * keyed by the platform code and by the closed reason in `details[].code`; the
 * service's sentence is never shown.
 */

// ---------------------------------------------------------------------------
// Who may
// ---------------------------------------------------------------------------

/** Who is asking, from the access token: the organization it acts for and its roles there. */
export interface InventoryCaller {
  readonly organizationId: string | null;
  readonly roles: readonly string[];
}

export function inventoryCallerOf(accessToken: string): InventoryCaller {
  return tokenAuthority(accessToken) ?? { organizationId: null, roles: [] };
}

/** The roles `InventoryAccess` refuses whatever the configuration says. */
const REFUSED_ROLES: readonly string[] = ['AUDITOR', 'SYSTEM_ADMIN'];

/**
 * `assertOperator`: a signed-in person acting for an organization, holding a
 * role of the operator set, and neither the oversight role nor the platform
 * administrator.
 */
export function mayOperateInventory(
  caller: InventoryCaller,
  operatorRoles: readonly string[] = webServerEnv().WEB_INVENTORY_ROLES,
): boolean {
  return (
    caller.organizationId !== null &&
    !REFUSED_ROLES.some((role) => caller.roles.includes(role)) &&
    operatorRoles.some((role) => caller.roles.includes(role))
  );
}

/** The status each shipment move leaves (`shipment.state-machine.ts`). */
export const SHIPMENT_MOVE_FROM = {
  DISPATCH_SHIPMENT: 'CREATED',
  DELIVER_SHIPMENT: 'DISPATCHED',
} as const;

export type ShipmentMove = keyof typeof SHIPMENT_MOVE_FROM;

/**
 * The moves of `shipment` this caller is offered now: an operator of the
 * origin warehouse's owner (never the consignee, Q-114), from the status the
 * move needs.
 */
export function shipmentMovesFor(
  caller: InventoryCaller,
  shipment: Pick<ShipmentSummary, 'organizationId' | 'status'>,
  operatorRoles?: readonly string[],
): ShipmentMove[] {
  if (!mayOperateInventory(caller, operatorRoles)) return [];
  if (caller.organizationId !== shipment.organizationId) return [];
  return (Object.keys(SHIPMENT_MOVE_FROM) as ShipmentMove[]).filter(
    (move) => SHIPMENT_MOVE_FROM[move] === shipment.status,
  );
}

/** Whether the caller is the consignee side of `shipment` and not its owner. */
export function isConsigneeOnly(
  caller: InventoryCaller,
  shipment: Pick<ShipmentSummary, 'organizationId' | 'consigneeOrganizationId'>,
): boolean {
  return (
    caller.organizationId !== null &&
    caller.organizationId !== shipment.organizationId &&
    caller.organizationId === shipment.consigneeOrganizationId
  );
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * The service's own refusals, by the platform code they ride on
 * (`docs/api/inventory-service.openapi.json`, the 400, 409 and 422 answers of
 * these routes).
 */
const BY_CODE: Readonly<Record<string, string>> = {
  VALIDATION_FAILED: TEXT.VALIDATION,
  BUSINESS_RULE_VIOLATION: TEXT.OTHER_RULE,
  INVALID_STATE_TRANSITION: TEXT.WRONG_STATE,
  OPTIMISTIC_LOCK_FAILED: TEXT.CHANGED,
  IDEMPOTENCY_KEY_REUSED: TEXT.KEY_REUSED,
  // A `409 CONFLICT` without `Retry-After`: the key's work is not in flight any more.
  CONFLICT: TEXT.ALREADY_FILED,
};

/** The closed reasons of `details[].code` (`REFUSAL_REASONS`), in fixed words. */
export const INVENTORY_DETAIL_CODE_TEXT: Readonly<Record<string, string>> = {
  ON_HAND_WOULD_BE_NEGATIVE: TEXT.ON_HAND_WOULD_BE_NEGATIVE,
  QUANTITY_OUT_OF_RANGE: TEXT.QUANTITY_OUT_OF_RANGE,
  SHIPMENT_NOT_CREATED: TEXT.SHIPMENT_NOT_CREATED,
  SHIPMENT_NOT_DISPATCHED: TEXT.SHIPMENT_NOT_DISPATCHED,
};

/** Which form field a body path of each command belongs to. */
const PATHS: Readonly<Record<InventoryCommand, Readonly<Record<string, string>>>> = {
  CREATE_WAREHOUSE: {
    name: NAME_FIELD,
    'location.latitude': LATITUDE_FIELD,
    'location.longitude': LONGITUDE_FIELD,
  },
  RECEIVE_STOCK: {
    productId: PRODUCT_FIELD,
    quantity: QUANTITY_FIELD,
    sourceReference: SOURCE_FIELD,
  },
  ADJUST_STOCK: {
    stockItemId: STOCK_ITEM_FIELD,
    quantityDelta: AMOUNT_FIELD,
    sourceReference: SOURCE_FIELD,
  },
  CREATE_SHIPMENT: {
    consigneeOrganizationId: CONSIGNEE_FIELD,
    orderReference: ORDER_FIELD,
  },
  DISPATCH_SHIPMENT: {},
  DELIVER_SHIPMENT: {},
};

/** A command's field mapping; a shipment's legs each land on their own two fields. */
export function inventoryFieldMapping(
  command: InventoryCommand,
  body: InventoryBody | null,
): FieldMapping<string> {
  const paths: Record<string, string> = { ...PATHS[command] };
  if (command === 'CREATE_SHIPMENT' && body !== null) {
    (body as ShipmentBody).legs.forEach((_leg, index) => {
      paths[`legs.${index}.carrierName`] = legField(index, 'carrierName');
      paths[`legs.${index}.carrierReference`] = legField(index, 'carrierReference');
    });
  }
  return {
    paths,
    byCode: BY_CODE,
    byDetailCode: INVENTORY_DETAIL_CODE_TEXT,
    fallback: TEXT.FALLBACK,
  };
}

/** What a confirmed command answers with: enough for a redirect, nothing more. */
const warehouseAnswer = z.object({ id: z.string().min(1) });
const stockChangeAnswer = z.object({
  stockItem: z.object({ id: z.string().min(1), warehouseId: z.string().min(1) }),
  movement: z.object({ id: z.string().min(1) }),
});
const shipmentAnswer = z.object({ id: z.string().min(1), status: z.string().min(1) });

/** The id the page the person lands on is addressed by, from what the command answered. */
export interface InventoryWriteData {
  readonly id: string;
}

export type InventoryWriteResult = Exclude<
  WriteResult<InventoryWriteData, string>,
  { readonly kind: 'UNAVAILABLE' }
>;

/**
 * inventory-service stores the idempotent response inside the command's own
 * transaction, but an answer can still be lost after it commits. Only a
 * definite refusal (a 4xx with a code) means "nothing was written": every
 * `UNAVAILABLE` — a 5xx, or a status with no problem body — is unconfirmed.
 */
function unconfirmedUnlessDefinite(
  result: WriteResult<InventoryWriteData, string>,
): InventoryWriteResult {
  return result.kind === 'UNAVAILABLE'
    ? { kind: 'UNKNOWN_OUTCOME', correlationId: result.correlationId }
    : result;
}

/** What a command posts: its path and its whole body, optional fields left out when empty. */
export interface InventoryRequest {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

function without<T extends Record<string, unknown>>(fields: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null && value !== undefined),
  );
}

/**
 * The request of a command on a slot. `targetId` is the warehouse (a receipt, a
 * new shipment) or the shipment (a move); `expectedVersion` is the stamp's.
 */
export function inventoryRequestOf(
  command: InventoryCommand,
  targetId: string | null,
  body: InventoryBody | null,
  expectedVersion: number | null,
): InventoryRequest | null {
  switch (command) {
    case 'CREATE_WAREHOUSE': {
      if (body === null) return null;
      const kept = body as WarehouseBody;
      return {
        path: '/v1/warehouses',
        body: without({ name: kept.name, location: kept.location }),
      };
    }
    case 'RECEIVE_STOCK': {
      if (body === null || targetId === null) return null;
      const kept = body as ReceiptBody;
      return {
        path: '/v1/stock/receipts',
        body: without({
          warehouseId: targetId,
          productId: kept.productId,
          quantity: kept.quantity,
          sourceReference: kept.sourceReference,
        }),
      };
    }
    case 'ADJUST_STOCK': {
      if (body === null) return null;
      const kept = body as AdjustmentBody;
      return {
        path: '/v1/stock/adjustments',
        body: without({
          stockItemId: kept.stockItemId,
          quantityDelta: kept.quantityDelta,
          sourceReference: kept.sourceReference,
        }),
      };
    }
    case 'CREATE_SHIPMENT': {
      if (body === null || targetId === null) return null;
      const kept = body as ShipmentBody;
      return {
        path: '/v1/shipments',
        body: without({
          originWarehouseId: targetId,
          consigneeOrganizationId: kept.consigneeOrganizationId,
          orderReference: kept.orderReference,
          legs: kept.legs.map((leg) =>
            without({ carrierName: leg.carrierName, carrierReference: leg.carrierReference }),
          ),
        }),
      };
    }
    case 'DISPATCH_SHIPMENT':
    case 'DELIVER_SHIPMENT': {
      if (targetId === null || expectedVersion === null) return null;
      const verb = command === 'DISPATCH_SHIPMENT' ? 'dispatch' : 'deliver';
      return {
        path: `/v1/shipments/${encodeURIComponent(targetId)}/${verb}`,
        body: { expectedVersion },
      };
    }
  }
}

/** The answer's schema, narrowed to the id the redirect is addressed by. */
function answerSchemaOf(
  command: InventoryCommand,
): z.ZodType<InventoryWriteData, z.ZodTypeDef, unknown> {
  switch (command) {
    case 'CREATE_WAREHOUSE':
      return warehouseAnswer;
    case 'RECEIVE_STOCK':
    case 'ADJUST_STOCK':
      return stockChangeAnswer.transform((answer) => ({ id: answer.stockItem.warehouseId }));
    default:
      return shipmentAnswer;
  }
}

/** Sends one inventory command under `submissionId`, the portal's `Idempotency-Key`. */
export async function issueInventoryCommand(
  session: WebSession,
  command: InventoryCommand,
  request: InventoryRequest,
  body: InventoryBody | null,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<InventoryWriteResult> {
  return unconfirmedUnlessDefinite(
    await writeThroughGateway(session, {
      path: request.path,
      body: request.body,
      submissionId,
      schema: answerSchemaOf(command),
      mapping: inventoryFieldMapping(command, body),
      fetchImpl,
    }),
  );
}
