import { z } from 'zod';

import { SYSTEM_MOVEMENT_ACTOR } from '@/lib/inventory-commands';
import { MAX_STOCK_QUANTITY } from '@/lib/inventory-fields';

import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import { utcInstant } from './instant';
import type { WebSession } from './session';
import type { ReadResult } from './assets';

export type { ReadResult };

/**
 * Reading warehouses and stock levels through the gateway (EXP-004 slice 3).
 *
 * Read-only: no command is issued from this module, so there is no
 * Idempotency-Key here (the commands are `inventory-commands.ts`). Reads follow
 * `projects.ts`.
 *
 * ## What is kept
 *
 * Only what a screen renders. A warehouse's coordinates, the organization id,
 * the ledger `version` and the actor ids are dropped: a React tree is
 * serialized into the page, and a value nobody reads should not travel with it.
 *
 * ## Quantities
 *
 * On hand, reserved and available are JSON integers in the API
 * (`z.number().int()`), bounded by what the service stores. They are validated
 * as whole, non-negative numbers within that bound and are never computed on
 * here: `available` is the service's figure, not on hand minus reserved.
 */

const quantity = z.number().int().min(0).max(MAX_STOCK_QUANTITY);

/** What the warehouse list renders. Timestamps are valid UTC instants (`instant.ts`). */
const warehouseSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  createdAt: utcInstant,
});

export type WarehouseSummary = z.infer<typeof warehouseSchema>;

const stockItemSchema = z.object({
  id: z.string().min(1),
  warehouseId: z.string().min(1),
  productId: z.string().min(1),
  onHandQuantity: quantity,
  reservedQuantity: quantity,
  availableQuantity: quantity,
  updatedAt: utcInstant,
});

export type StockItemSummary = z.infer<typeof stockItemSchema>;

const signedQuantity = z.number().int().min(-MAX_STOCK_QUANTITY).max(MAX_STOCK_QUANTITY);

/**
 * One line of the append-only ledger. `createdBy` is a platform user id (or the
 * service's own name for an expiry): it is reduced to whether the service wrote
 * it, and the id never travels into the page.
 */
const movementSchema = z
  .object({
    id: z.string().min(1),
    stockItemId: z.string().min(1),
    type: z.string().min(1),
    onHandDelta: signedQuantity,
    reservedDelta: signedQuantity,
    onHandAfter: quantity,
    reservedAfter: quantity,
    itemVersion: z.number().int().min(1),
    reservationId: z.string().min(1).nullable().default(null),
    sourceReference: z.string().min(1).nullable().default(null),
    createdAt: utcInstant,
    createdBy: z.string().min(1),
  })
  .transform(({ createdBy, ...movement }) => ({
    ...movement,
    bySystem: createdBy === SYSTEM_MOVEMENT_ACTOR,
  }));

export type MovementSummary = z.infer<typeof movementSchema>;

const nullableInstant = utcInstant.nullable().default(null);

const legSchema = z.object({
  sequence: z.number().int().min(1),
  carrierName: z.string(),
  carrierReference: z.string().nullable().default(null),
});

/**
 * A shipment as both its organizations read it. `organizationId` is the owner
 * of the origin warehouse: the portal compares it with the acting organization
 * to know which side the viewer is on (only the owner's operators move it).
 */
const shipmentSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  originWarehouseId: z.string().min(1),
  consigneeOrganizationId: z.string().min(1),
  orderReference: z.string().nullable().default(null),
  status: z.string().min(1),
  legs: z.array(legSchema).default([]),
  createdAt: utcInstant,
  dispatchedAt: nullableInstant,
  deliveredAt: nullableInstant,
  version: z.number().int().min(1),
});

export type ShipmentSummary = z.infer<typeof shipmentSchema>;

const trackingSchema = z.object({
  shipmentId: z.string().min(1),
  status: z.string().min(1),
  events: z.array(
    z.object({
      id: z.string().min(1),
      type: z.string().min(1),
      occurredAt: utcInstant,
      recordedAt: utcInstant,
    }),
  ),
});

export type ShipmentTracking = z.infer<typeof trackingSchema>;

function pageSchema<S extends z.ZodTypeAny>(item: S) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable().default(null),
    hasMore: z.boolean().default(false),
  });
}

const warehousePageSchema = pageSchema(warehouseSchema);
const stockPageSchema = pageSchema(stockItemSchema);
const movementPageSchema = pageSchema(movementSchema);
const shipmentPageSchema = pageSchema(shipmentSchema);

export type WarehousePage = z.infer<typeof warehousePageSchema>;
export type StockPage = z.infer<typeof stockPageSchema>;
export type MovementPage = z.infer<typeof movementPageSchema>;
export type ShipmentPage = z.infer<typeof shipmentPageSchema>;

export const WAREHOUSES_PER_PAGE = 20;
export const STOCK_PER_PAGE = 20;
export const MOVEMENTS_PER_PAGE = 20;
export const SHIPMENTS_PER_PAGE = 20;

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
      // inventory-service answers 404, never 403, for another organization's
      // warehouse, so its existence is not disclosed. It is rendered as absent.
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

export function fetchWarehouses(
  session: WebSession,
  cursor?: string,
): Promise<ReadResult<WarehousePage>> {
  const search = new URLSearchParams({ limit: String(WAREHOUSES_PER_PAGE) });
  if (cursor) search.set('cursor', cursor);
  return read(session, `/v1/warehouses?${search.toString()}`, warehousePageSchema);
}

export function fetchWarehouse(
  session: WebSession,
  warehouseId: string,
): Promise<ReadResult<WarehouseSummary>> {
  return read(session, `/v1/warehouses/${encodeURIComponent(warehouseId)}`, warehouseSchema);
}

/** The stock items of one warehouse, newest first. */
export function fetchStock(
  session: WebSession,
  warehouseId: string,
  cursor?: string,
): Promise<ReadResult<StockPage>> {
  const search = new URLSearchParams({ limit: String(STOCK_PER_PAGE), warehouseId });
  if (cursor) search.set('cursor', cursor);
  return read(session, `/v1/stock?${search.toString()}`, stockPageSchema);
}

/** The ledger of one warehouse, newest first (`GET /v1/stock/movements`). */
export function fetchMovements(
  session: WebSession,
  warehouseId: string,
  cursor?: string,
): Promise<ReadResult<MovementPage>> {
  const search = new URLSearchParams({ limit: String(MOVEMENTS_PER_PAGE), warehouseId });
  if (cursor) search.set('cursor', cursor);
  return read(session, `/v1/stock/movements?${search.toString()}`, movementPageSchema);
}

/**
 * The shipments the viewer's roles open, newest first: those leaving the
 * organization's warehouses (`origin`) and those sent to it (`consignee`).
 */
export function fetchShipments(
  session: WebSession,
  query: { readonly side?: 'origin' | 'consignee'; readonly cursor?: string } = {},
): Promise<ReadResult<ShipmentPage>> {
  const search = new URLSearchParams({ limit: String(SHIPMENTS_PER_PAGE) });
  if (query.side) search.set('side', query.side);
  if (query.cursor) search.set('cursor', query.cursor);
  return read(session, `/v1/shipments?${search.toString()}`, shipmentPageSchema);
}

export function fetchShipment(
  session: WebSession,
  shipmentId: string,
): Promise<ReadResult<ShipmentSummary>> {
  return read(session, `/v1/shipments/${encodeURIComponent(shipmentId)}`, shipmentSchema);
}

export function fetchShipmentTracking(
  session: WebSession,
  shipmentId: string,
): Promise<ReadResult<ShipmentTracking>> {
  return read(session, `/v1/shipments/${encodeURIComponent(shipmentId)}/tracking`, trackingSchema);
}
