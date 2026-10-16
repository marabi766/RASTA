import { z } from 'zod';
import { ID_PREFIXES, organizationIdSchema } from '../common/identifiers';

/**
 * The return-shipment events of inventory-service on `rasta.inventory.v1` (ADR-048 § 2, § 3;
 * RUN-005) — `docs/events/README.md` § Inventory.
 *
 * **Contract only (A-03).** Names, wire shapes and their bounds; who may cause these events and
 * when is inventory-service's, decided there. A consumer validates what it reads with the same
 * schemas the producer validates with before the event reaches its outbox.
 *
 * ## Who owns what (ADR-048 § 2)
 *
 * inventory-service owns the **physical** half of a return: the goods on the road, their receipt,
 * their inspection and what becomes of them. These events are facts about goods and say nothing about
 * whether the return was *allowed* — that is marketplace's, which owns the return request and
 * verifies every one of these against it before acting (an event for a return it does not know, or
 * has not authorized, is refused there). No event here moves money or asks for it to move.
 *
 * ## One stream per return shipment, in order
 *
 * Keyed by `returnShipmentId`. `returnShipmentVersion` is the shipment's position in its own
 * history (1 = IN_TRANSIT, 2 = RECEIVED, 3 = INSPECTED, 4 = RESOLVED). Like the forward shipment stream (D-027), delivery
 * order is not guaranteed: a consumer orders and de-duplicates by the envelope's `streamSeq`
 * (`streamKey` = `returnShipmentId`, equal to `returnShipmentVersion`) — a sequence at or below the
 * last one applied is a duplicate or stale and has no effect.
 *
 * ## What these payloads never carry
 *
 * **Identifiers, integer quantities and instants only.** No carrier name or reference, no note,
 * no address, no personal data. People are named by user id.
 */

export const INVENTORY_RETURN_EVENTS = {
  RETURN_SHIPMENT_DISPATCHED: 'RETURN_SHIPMENT_DISPATCHED',
  RETURN_SHIPMENT_RECEIVED: 'RETURN_SHIPMENT_RECEIVED',
  RETURN_SHIPMENT_INSPECTED: 'RETURN_SHIPMENT_INSPECTED',
  RETURN_SHIPMENT_RESOLVED: 'RETURN_SHIPMENT_RESOLVED',
} as const;

/**
 * What can become of a received unit (ADR-048 § 1). Which of them an organization may choose is
 * configuration and the service's to enforce (Q-133); this is only the closed set a consumer can
 * meet on the wire.
 */
export const RETURN_DISPOSITIONS = [
  'RESTOCK',
  'REPAIR',
  'REPLACE',
  'RETURN_TO_SUPPLIER',
  'SCRAP',
  'RECYCLE',
] as const;
export type ReturnDisposition = (typeof RETURN_DISPOSITIONS)[number];

export type InventoryReturnEventName = keyof typeof INVENTORY_RETURN_EVENTS;

/** The aggregate every return-shipment event is about, and its stream key's name. */
export const RETURN_SHIPMENT_AGGREGATE = 'ReturnShipment';

const ulid = '[0-9A-HJKMNP-TV-Z]{26}';
const prefixed = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_${ulid}$`));

const returnShipmentId = prefixed(ID_PREFIXES.returnShipment);
const returnRequestId = prefixed(ID_PREFIXES.returnRequest);
const orderId = prefixed(ID_PREFIXES.order);
const warehouseId = prefixed(ID_PREFIXES.warehouse);
const trackingEventId = prefixed('RTK');
const orderLineId = z.string().min(1).max(128);
const productId = z.string().min(1).max(128);
/** A platform identifier of a person or an organization, as every other event carries one. */
const id = z.string().min(1).max(128);
/** ISO 8601 in UTC, the form every event of the platform carries a time in. */
const instant = z.string().datetime({ offset: false });

/** A line of the goods on the road: what was said to be coming, never a price. */
export const returnShipmentLineSchema = z
  .object({ orderLineId, productId, expectedQuantity: z.number().int().min(1) })
  .strict();

/** A line as it arrived: the same, and how many of it did. May be fewer than expected, or none. */
export const receivedReturnShipmentLineSchema = returnShipmentLineSchema
  .extend({ receivedQuantity: z.number().int().min(0) })
  .strict()
  .refine((line) => line.receivedQuantity <= line.expectedQuantity, {
    message: 'receivedQuantity exceeds expectedQuantity',
    path: ['receivedQuantity'],
  });

/** What every return-shipment event says: which shipment, for which return, between whom. */
const returnShipmentFacts = {
  returnShipmentId,
  /** The owner of the destination warehouse — the tenant, and (Q-133) the order's supplier. */
  organizationId: id,
  returnRequestId,
  orderId,
  /** The organization the goods come from. Never resolved by inventory-service. */
  buyerOrganizationId: organizationIdSchema,
  destinationWarehouseId: warehouseId,
  /** The tracking event this event announces. */
  trackingEventId,
};

const distinctLines = (lines: readonly { orderLineId: string }[]) =>
  new Set(lines.map((line) => line.orderLineId)).size === lines.length;

/** Goods of a return left the buyer: the shipment exists, IN_TRANSIT. */
export const returnShipmentDispatchedPayloadSchema = z
  .object({
    ...returnShipmentFacts,
    returnShipmentVersion: z.literal(1),
    lines: z
      .array(returnShipmentLineSchema)
      .min(1)
      .max(50)
      .refine(distinctLines, { message: 'an order line appears once' }),
    dispatchedBy: id,
    dispatchedAt: instant,
  })
  .strict();

/** Goods arrived at the destination warehouse: IN_TRANSIT → RECEIVED. They are not stock. */
export const returnShipmentReceivedPayloadSchema = z
  .object({
    ...returnShipmentFacts,
    returnShipmentVersion: z.literal(2),
    lines: z
      .array(receivedReturnShipmentLineSchema)
      .min(1)
      .max(50)
      .refine(distinctLines, { message: 'an order line appears once' }),
    receivedBy: id,
    receivedAt: instant,
  })
  .strict();

/**
 * The received goods were examined: RECEIVED → INSPECTED. They are still not stock. The inspector's
 * note stays in inventory-service; the report is a file in document-service, named by id.
 */
export const returnShipmentInspectedPayloadSchema = z
  .object({
    ...returnShipmentFacts,
    returnShipmentVersion: z.literal(3),
    reportDocumentId: prefixed(ID_PREFIXES.document).nullable(),
    inspectedBy: id,
    inspectedAt: instant,
  })
  .strict();

/** What becomes of one line's received units: a closed outcome and how many went that way. */
export const returnDispositionLineSchema = z
  .object({
    orderLineId,
    disposition: z.enum(RETURN_DISPOSITIONS),
    quantity: z.number().int().min(1),
  })
  .strict();

/**
 * Every received unit was given an outcome: INSPECTED → RESOLVED. The record is a fact about
 * goods. It moves no stock and asks for no money: whether a restocked unit becomes sellable, and
 * whether the buyer is refunded, are other owners' decisions (ADR-048 § 2, § 4).
 */
export const returnShipmentResolvedPayloadSchema = z
  .object({
    ...returnShipmentFacts,
    returnShipmentVersion: z.literal(4),
    dispositions: z
      .array(returnDispositionLineSchema)
      .min(1)
      .max(300)
      .refine(
        (rows) =>
          new Set(rows.map((row) => `${row.orderLineId}|${row.disposition}`)).size === rows.length,
        { message: 'a line has one row per disposition' },
      ),
    resolvedBy: id,
    resolvedAt: instant,
  })
  .strict();

export const INVENTORY_RETURN_EVENT_SCHEMAS = {
  RETURN_SHIPMENT_DISPATCHED: returnShipmentDispatchedPayloadSchema,
  RETURN_SHIPMENT_RECEIVED: returnShipmentReceivedPayloadSchema,
  RETURN_SHIPMENT_INSPECTED: returnShipmentInspectedPayloadSchema,
  RETURN_SHIPMENT_RESOLVED: returnShipmentResolvedPayloadSchema,
} as const satisfies Record<InventoryReturnEventName, z.ZodTypeAny>;

export type ReturnShipmentLine = z.infer<typeof returnShipmentLineSchema>;
export type ReceivedReturnShipmentLine = z.infer<typeof receivedReturnShipmentLineSchema>;
export type ReturnShipmentDispatchedPayload = z.infer<typeof returnShipmentDispatchedPayloadSchema>;
export type ReturnShipmentReceivedPayload = z.infer<typeof returnShipmentReceivedPayloadSchema>;
export type ReturnShipmentInspectedPayload = z.infer<typeof returnShipmentInspectedPayloadSchema>;
export type ReturnShipmentResolvedPayload = z.infer<typeof returnShipmentResolvedPayloadSchema>;
export type ReturnDispositionLine = z.infer<typeof returnDispositionLineSchema>;
