import { z } from 'zod';
import { cursorPaginationSchema, plainText, referenceId } from '@rasta/contracts';
import {
  expectedVersionSchema,
  productIdSchema,
  quantitySchema,
  warehouseIdSchema,
} from '../shared/dto';
import { consigneeOrganizationIdSchema } from '../shipment/dto';

/**
 * The request and response shapes of the return-shipment API (ADR-048 § 2, § 3; RUN-005 PR 2).
 *
 * A return shipment is the physical half of a return: goods coming back to one of the owner's
 * warehouses. The commercial half — whether the return is allowed — is marketplace's and is not
 * asked here; marketplace checks every fact this service publishes against its own request.
 * Nothing here carries a price, an amount, or a refund.
 */

export const MAX_RETURN_SHIPMENT_LINES = 50;

/** IN_TRANSIT → RECEIVED in this version; INSPECTED and RESOLVED widen it (ADR-048 § 3). */
export const RETURN_SHIPMENT_STATES = ['IN_TRANSIT', 'RECEIVED'] as const;
export type ReturnShipmentStatus = (typeof RETURN_SHIPMENT_STATES)[number];

/** Which side of a return shipment a list reads. */
export const RETURN_SHIPMENT_SIDES = ['destination', 'sender'] as const;
export type ReturnShipmentSide = (typeof RETURN_SHIPMENT_SIDES)[number];

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';

export const returnShipmentIdSchema = z.string().regex(new RegExp(`^RSP_${ULID}$`));

const returnRequestIdSchema = z
  .string()
  .regex(new RegExp(`^RET_${ULID}$`))
  .describe(
    'The marketplace return request this shipment is for: an opaque `RET_<ULID>` reference this ' +
      'service never resolves. Marketplace verifies it — the return exists, is authorized, and ' +
      'names this organization as its supplier — before acting on anything published here.',
  );

const orderIdSchema = z
  .string()
  .regex(new RegExp(`^ORD_${ULID}$`))
  .describe('The marketplace order the goods were sold under. Opaque; never resolved here.');

const orderLineIdSchema = z
  .string()
  .regex(new RegExp(`^OLN_${ULID}$`))
  .describe('A line of that order. Opaque; never resolved here.');

const dispatchedLineSchema = z
  .object({
    orderLineId: orderLineIdSchema,
    productId: productIdSchema,
    quantity: quantitySchema.describe('How many of this line are said to be coming back.'),
  })
  .strict();

/** `POST /v1/return-shipments`: goods of a return are on their way to one of the owner's warehouses. */
export const createReturnShipmentSchema = z
  .object({
    returnRequestId: returnRequestIdSchema,
    orderId: orderIdSchema,
    buyerOrganizationId: consigneeOrganizationIdSchema.describe(
      'The organization the goods come from: it may read the return shipment and its tracking, ' +
        'never move it. An opaque platform organization id, not resolved or verified here, and ' +
        'never the organization the request acts for.',
    ),
    destinationWarehouseId: warehouseIdSchema.describe(
      'The warehouse the goods come back to: one of the organization the request acts for ' +
        '(another’s is 404). Q-133, temporary decision: the order’s supplier receives its returns.',
    ),
    lines: z
      .array(dispatchedLineSchema)
      .min(1)
      .max(MAX_RETURN_SHIPMENT_LINES)
      .superRefine((lines, context) => {
        const seen = new Set<string>();
        for (const [index, line] of lines.entries()) {
          if (seen.has(line.orderLineId)) {
            context.addIssue({
              code: 'custom',
              path: [index, 'orderLineId'],
              message: 'An order line may appear once in a return shipment',
            });
          }
          seen.add(line.orderLineId);
        }
      }),
    carrierName: plainText()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Who carries the goods back: trimmed, 1 to 200 characters. Shown to the shipment’s ' +
          'readers; never on an event.',
      ),
    carrierReference: referenceId()
      .min(1)
      .max(100)
      .optional()
      .describe('Optional: the carrier’s own reference. Needs a carrierName. Never on an event.'),
  })
  .strict()
  .refine((body) => body.carrierReference === undefined || body.carrierName !== undefined, {
    message: 'A carrier reference needs a carrier name',
    path: ['carrierReference'],
  });
export type CreateReturnShipmentDto = z.infer<typeof createReturnShipmentSchema>;

/** `POST /v1/return-shipments/{id}/receive`: the goods arrived — how many of each line. */
export const receiveReturnShipmentSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    lines: z
      .array(
        z
          .object({
            orderLineId: orderLineIdSchema,
            receivedQuantity: z
              .number()
              .int()
              .min(0)
              .max(2_147_483_647)
              .describe('How many of this line arrived: 0 up to the quantity expected.'),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_RETURN_SHIPMENT_LINES)
      .describe('Exactly the lines the shipment was dispatched with, each once.'),
  })
  .strict();
export type ReceiveReturnShipmentDto = z.infer<typeof receiveReturnShipmentSchema>;

export const listReturnShipmentsQuerySchema = cursorPaginationSchema
  .extend({
    side: z
      .enum(RETURN_SHIPMENT_SIDES)
      .optional()
      .describe(
        '`destination`: return shipments coming to the warehouses of the organization the ' +
          'request acts for; `sender`: those it sent. Without it, both — as far as the caller’s ' +
          'roles open each side.',
      ),
    status: z.enum(RETURN_SHIPMENT_STATES).optional(),
    returnRequestId: returnRequestIdSchema.optional(),
  })
  .strict();
export type ListReturnShipmentsQuery = z.infer<typeof listReturnShipmentsQuerySchema>;

export const returnShipmentLineViewSchema = z
  .object({
    orderLineId: z.string(),
    productId: z.string(),
    expectedQuantity: z.number().int(),
    receivedQuantity: z.number().int().nullable().describe('Null until the shipment is RECEIVED.'),
  })
  .strict();
export type ReturnShipmentLineView = z.infer<typeof returnShipmentLineViewSchema>;

/**
 * A return shipment as both of its organizations read it. No user id: the sender is another
 * organization, and who in the owner did what is the owner's audit trail (the events).
 */
export const returnShipmentViewSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().describe('The owner of the destination warehouse.'),
    destinationWarehouseId: z.string(),
    buyerOrganizationId: z.string().describe('The organization the goods come from.'),
    returnRequestId: z.string(),
    orderId: z.string(),
    status: z.enum(RETURN_SHIPMENT_STATES),
    lines: z.array(returnShipmentLineViewSchema),
    carrierName: z.string().nullable(),
    carrierReference: z.string().nullable(),
    createdAt: z.string().describe('When the goods were recorded as on their way.'),
    receivedAt: z.string().nullable(),
    updatedAt: z.string(),
    version: z.number().int().describe('1 while IN_TRANSIT, 2 once RECEIVED.'),
  })
  .strict();
export type ReturnShipmentView = z.infer<typeof returnShipmentViewSchema>;

export const returnTrackingEventViewSchema = z
  .object({
    id: z.string(),
    type: z.enum(RETURN_SHIPMENT_STATES).describe('The status the return shipment reached.'),
    occurredAt: z.string(),
    recordedAt: z.string(),
  })
  .strict();
export type ReturnTrackingEventView = z.infer<typeof returnTrackingEventViewSchema>;

/** `GET /v1/return-shipments/{id}/tracking`. */
export const returnTrackingViewSchema = z
  .object({
    returnShipmentId: z.string(),
    status: z.enum(RETURN_SHIPMENT_STATES),
    destinationWarehouseId: z.string(),
    buyerOrganizationId: z.string(),
    events: z
      .array(returnTrackingEventViewSchema)
      .describe('What happened, in lifecycle order: IN_TRANSIT, then RECEIVED.'),
  })
  .strict();
export type ReturnTrackingView = z.infer<typeof returnTrackingViewSchema>;
