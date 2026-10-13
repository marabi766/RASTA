import { z } from 'zod';
import { cursorPaginationSchema, plainText, referenceId } from '@rasta/contracts';
import { expectedVersionSchema, warehouseIdSchema } from '../shared/dto';

/**
 * The request and response shapes of the shipment API (ADR-056 § 2, § 5; COM-006 PR 2).
 */

/** The most legs one shipment is created with: protection of the service, not a rule (Q-115). */
export const MAX_SHIPMENT_LEGS = 10;
export const MAX_CARRIER_NAME_LENGTH = 200;
export const MAX_CARRIER_REFERENCE_LENGTH = 100;

/** CREATED → DISPATCHED → DELIVERED, and nothing else in this version (Q-114). */
export const SHIPMENT_STATES = ['CREATED', 'DISPATCHED', 'DELIVERED'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATES)[number];

/** Which side of a shipment a list reads (ADR-056 § 5). */
export const SHIPMENT_SIDES = ['origin', 'consignee'] as const;
export type ShipmentSide = (typeof SHIPMENT_SIDES)[number];

/**
 * An organization of the platform, `ORG_<ULID>` (or a readable seed id), as the database's
 * `ck_shipment_consignee` accepts it. Never resolved here (Q-113).
 */
export const consigneeOrganizationIdSchema = z
  .string()
  .regex(/^ORG(_[0-9A-HJKMNP-TV-Z]{26}|-[A-Z0-9-]{1,48})$/)
  .describe(
    'The organization the shipment is sent to (ADR-056 § 5): it may read the shipment and its ' +
      'tracking, never move it. An opaque platform organization id, not resolved or verified ' +
      'by this service (Q-113). May be the owner itself.',
  );

export const shipmentIdSchema = z.string().regex(/^SHP_[0-9A-HJKMNP-TV-Z]{26}$/);

const legSchema = z
  .object({
    carrierName: plainText()
      .min(1)
      .max(MAX_CARRIER_NAME_LENGTH)
      .describe(
        'Who carries this leg: trimmed, 1 to 200 characters, without bidirectional control ' +
          'characters. Shown to the shipment’s readers; never on an event (Q-115).',
      ),
    carrierReference: referenceId()
      .min(1)
      .max(MAX_CARRIER_REFERENCE_LENGTH)
      .optional()
      .describe('Optional: the carrier’s own reference (a waybill number). Never on an event.'),
  })
  .strict();

/** `POST /v1/shipments`: a shipment out of one of the owner's warehouses. */
export const createShipmentSchema = z
  .object({
    originWarehouseId: warehouseIdSchema.describe(
      'The warehouse it leaves: one of the organization the request acts for (another’s is 404). ' +
        'A shipment always leaves a warehouse of this platform (ADR-056 § 2).',
    ),
    consigneeOrganizationId: consigneeOrganizationIdSchema,
    orderReference: z
      .string()
      .regex(/^(ORD|PO)_[0-9A-HJKMNP-TV-Z]{26}$/)
      .optional()
      .describe('Optional opaque `ORD_`/`PO_` reference of the order it is for. Never resolved.'),
    legs: z
      .array(legSchema)
      .min(1)
      .max(MAX_SHIPMENT_LEGS)
      .describe(
        '1 to 10 legs, in the order they are carried; numbered from 1. Fixed once created.',
      ),
  })
  .strict();
export type CreateShipmentDto = z.infer<typeof createShipmentSchema>;

/** `POST /v1/shipments/{id}/dispatch` and `…/deliver`. */
export const moveShipmentSchema = z.object({ expectedVersion: expectedVersionSchema }).strict();
export type MoveShipmentDto = z.infer<typeof moveShipmentSchema>;

export const listShipmentsQuerySchema = cursorPaginationSchema
  .extend({
    side: z
      .enum(SHIPMENT_SIDES)
      .optional()
      .describe(
        '`origin`: shipments leaving the warehouses of the organization the request acts for; ' +
          '`consignee`: shipments sent to it. Without it, both — as far as the caller’s roles ' +
          'open each side.',
      ),
    status: z.enum(SHIPMENT_STATES).optional(),
  })
  .strict();
export type ListShipmentsQuery = z.infer<typeof listShipmentsQuerySchema>;

export const shipmentLegViewSchema = z
  .object({
    sequence: z.number().int(),
    carrierName: z.string(),
    carrierReference: z.string().nullable(),
  })
  .strict();
export type ShipmentLegView = z.infer<typeof shipmentLegViewSchema>;

/**
 * A shipment as both of its organizations read it. No user id: the consignee is another
 * organization, and who in the owner did what is the owner's audit trail (the events).
 */
export const shipmentViewSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().describe('The owner of the origin warehouse.'),
    originWarehouseId: z.string(),
    consigneeOrganizationId: z.string(),
    orderReference: z.string().nullable(),
    status: z.enum(SHIPMENT_STATES),
    legs: z.array(shipmentLegViewSchema),
    createdAt: z.string(),
    dispatchedAt: z.string().nullable(),
    deliveredAt: z.string().nullable(),
    updatedAt: z.string(),
    version: z.number().int().describe('1 while CREATED, 2 once DISPATCHED, 3 once DELIVERED.'),
  })
  .strict();
export type ShipmentView = z.infer<typeof shipmentViewSchema>;

export const trackingEventViewSchema = z
  .object({
    id: z.string(),
    type: z.enum(SHIPMENT_STATES).describe('The status the shipment reached.'),
    occurredAt: z.string(),
    recordedAt: z.string(),
  })
  .strict();
export type TrackingEventView = z.infer<typeof trackingEventViewSchema>;

/** `GET /v1/shipments/{id}/tracking` (`TrackShipment`, ADR-056 plan step 10). */
export const trackingViewSchema = z
  .object({
    shipmentId: z.string(),
    status: z.enum(SHIPMENT_STATES),
    originWarehouseId: z.string(),
    consigneeOrganizationId: z.string(),
    events: z
      .array(trackingEventViewSchema)
      .describe('What happened to the shipment, in the order it happened.'),
  })
  .strict();
export type TrackingView = z.infer<typeof trackingViewSchema>;
