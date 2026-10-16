import { z } from 'zod';
import {
  RETURN_DISPOSITIONS,
  cursorPaginationSchema,
  plainText,
  referenceId,
} from '@rasta/contracts';
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

/** The physical half of `REQUESTED → … → RESOLVED` (ADR-048 § 3). */
export const RETURN_SHIPMENT_STATES = ['IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'RESOLVED'] as const;
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

/** `POST /v1/return-shipments/{id}/inspection`: the received goods were examined. */
export const inspectReturnShipmentSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    note: plainText()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        'Optional: what the inspector found, in words. Trimmed, 1 to 1000 characters. Shown to ' +
          'the return shipment’s readers; kept here and never on an event.',
      ),
    reportDocumentId: z
      .string()
      .regex(new RegExp(`^DOC_${ULID}$`))
      .optional()
      .describe(
        'Optional: the inspection report, a file in document-service (`DOC_<ULID>`), referenced ' +
          'by id and never resolved here. Files and images are stored only there (ADR-048).',
      ),
  })
  .strict();
export type InspectReturnShipmentDto = z.infer<typeof inspectReturnShipmentSchema>;

/**
 * `POST /v1/return-shipments/{id}/resolution`: what becomes of every received unit. Which
 * dispositions an organization may choose is configuration (INVENTORY_RETURN_DISPOSITIONS_ALLOWED,
 * Q-133) and is checked by the service, not by this shape.
 */
export const resolveReturnShipmentSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    dispositions: z
      .array(
        z
          .object({
            orderLineId: orderLineIdSchema,
            disposition: z.enum(RETURN_DISPOSITIONS),
            quantity: quantitySchema.describe('How many units of this line go this way.'),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_RETURN_SHIPMENT_LINES * RETURN_DISPOSITIONS.length)
      .superRefine((rows, context) => {
        const seen = new Set<string>();
        for (const [index, row] of rows.entries()) {
          const pair = `${row.orderLineId}|${row.disposition}`;
          if (seen.has(pair)) {
            context.addIssue({
              code: 'custom',
              path: [index, 'disposition'],
              message: 'A line has one row per disposition',
            });
          }
          seen.add(pair);
        }
      })
      .describe(
        'Per line, its units by disposition; for every line the quantities add up to exactly ' +
          'what was received (a line that received none needs no row). This records an outcome ' +
          'for the goods. It moves no stock and asks for no money.',
      ),
  })
  .strict();
export type ResolveReturnShipmentDto = z.infer<typeof resolveReturnShipmentSchema>;

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

export const returnDispositionViewSchema = z
  .object({
    orderLineId: z.string(),
    disposition: z.enum(RETURN_DISPOSITIONS),
    quantity: z.number().int(),
  })
  .strict();
export type ReturnDispositionView = z.infer<typeof returnDispositionViewSchema>;

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
    inspectedAt: z.string().nullable(),
    inspectionNote: z.string().nullable(),
    inspectionReportDocumentId: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    dispositions: z
      .array(returnDispositionViewSchema)
      .describe('Empty until RESOLVED; then every received unit, by line and disposition.'),
    updatedAt: z.string(),
    version: z
      .number()
      .int()
      .describe('1 while IN_TRANSIT, 2 once RECEIVED, 3 once INSPECTED, 4 once RESOLVED.'),
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
      .describe(
        'What happened, in lifecycle order: IN_TRANSIT, RECEIVED, INSPECTED, RESOLVED — as far as it got.',
      ),
  })
  .strict();
export type ReturnTrackingView = z.infer<typeof returnTrackingViewSchema>;
