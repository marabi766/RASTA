import { z } from 'zod';
import { ID_PREFIXES, organizationIdSchema } from '../common/identifiers';

/**
 * The shipment events of inventory-service on `rasta.inventory.v1` (ADR-056 § 2, § 6; COM-006
 * PR 2) — `docs/events/README.md` § Inventory.
 *
 * **Contract only (A-03).** Names, wire shapes and their bounds; who may cause these events and
 * when is inventory-service's, decided there and nowhere else. A consumer validates what it reads
 * with the same schemas the producer validates with before the event reaches its outbox.
 *
 * ## One stream per shipment, in order
 *
 * Every event here is keyed by `shipmentId` — the STRICT stream of ADR-056 § 6: a shipment is
 * created, then dispatched, then delivered, and an inversion would be a shipment "delivered
 * before it left". `shipmentVersion` is the shipment's position in its own history (1, 2, 3); a
 * consumer reads order from it and from the envelope's `streamSeq`, never from arrival (D-027).
 *
 * ## What these payloads never carry
 *
 * **Identifiers and instants only.** No carrier name or carrier reference (free text, kept by
 * inventory-service and read through its API, Q-115), no address, no personal data. The
 * catalogue's `orderId` is `orderReference`: an opaque `ORD_`/`PO_` reference never resolved by
 * inventory-service. People are named by user id.
 */

export const INVENTORY_SHIPMENT_EVENTS = {
  SHIPMENT_CREATED: 'SHIPMENT_CREATED',
  SHIPMENT_DISPATCHED: 'SHIPMENT_DISPATCHED',
  SHIPMENT_DELIVERED: 'SHIPMENT_DELIVERED',
} as const;

export type InventoryShipmentEventName = keyof typeof INVENTORY_SHIPMENT_EVENTS;

/** The aggregate every shipment event is about, and its stream key's name. */
export const SHIPMENT_AGGREGATE = 'Shipment';

/** `<PREFIX>_<ULID>`, the form of every identifier inventory-service mints. */
const prefixed = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));

const shipmentId = prefixed(ID_PREFIXES.shipment);
const warehouseId = prefixed(ID_PREFIXES.warehouse);
const trackingEventId = prefixed('TRK');
/** A platform identifier of a person or an organization, as every other event carries one. */
const id = z.string().min(1).max(128);
/** ISO 8601 in UTC, the form every event of the platform carries a time in. */
const instant = z.string().datetime({ offset: false });
const orderReference = z
  .string()
  .regex(/^(ORD|PO)_[0-9A-HJKMNP-TV-Z]{26}$/)
  .nullable();

/** What every shipment event says about the shipment: which, from where, to whom, and where in its history. */
const shipmentFacts = {
  shipmentId,
  /** The owner of the origin warehouse — the tenant. */
  organizationId: id,
  originWarehouseId: warehouseId,
  /** Who it is sent to (ADR-056 § 5). Never resolved by inventory-service (Q-113). */
  consigneeOrganizationId: organizationIdSchema,
  orderReference,
  /** The tracking event this event announces. */
  trackingEventId,
};

/** A shipment was created, CREATED, with `legCount` legs, out of its owner's warehouse. */
export const shipmentCreatedPayloadSchema = z
  .object({
    ...shipmentFacts,
    shipmentVersion: z.literal(1),
    legCount: z.number().int().min(1),
    createdBy: id,
    createdAt: instant,
  })
  .strict();

/** The shipment left its origin warehouse: CREATED → DISPATCHED. */
export const shipmentDispatchedPayloadSchema = z
  .object({
    ...shipmentFacts,
    shipmentVersion: z.literal(2),
    dispatchedBy: id,
    dispatchedAt: instant,
  })
  .strict();

/** The shipment was delivered, as its origin warehouse's owner recorded: DISPATCHED → DELIVERED. */
export const shipmentDeliveredPayloadSchema = z
  .object({
    ...shipmentFacts,
    shipmentVersion: z.literal(3),
    deliveredBy: id,
    deliveredAt: instant,
  })
  .strict();

export const INVENTORY_SHIPMENT_EVENT_SCHEMAS = {
  SHIPMENT_CREATED: shipmentCreatedPayloadSchema,
  SHIPMENT_DISPATCHED: shipmentDispatchedPayloadSchema,
  SHIPMENT_DELIVERED: shipmentDeliveredPayloadSchema,
} as const satisfies Record<InventoryShipmentEventName, z.ZodTypeAny>;

export type ShipmentCreatedPayload = z.infer<typeof shipmentCreatedPayloadSchema>;
export type ShipmentDispatchedPayload = z.infer<typeof shipmentDispatchedPayloadSchema>;
export type ShipmentDeliveredPayload = z.infer<typeof shipmentDeliveredPayloadSchema>;
