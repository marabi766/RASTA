import { z } from 'zod';
import { ID_PREFIXES, organizationIdSchema } from '../common/identifiers';
import { RETURN_DISPOSITIONS } from './inventory-returns';

/**
 * The return-request events of marketplace-service on `rasta.marketplace.v1` (ADR-048 § 2, § 3;
 * RUN-005) — `docs/events/README.md` § Reverse Logistics.
 *
 * **Contract only (A-03).** Names, wire shapes and their bounds. Who may cause these events and
 * when is marketplace-service's, decided there. A consumer validates what it reads with the same
 * schemas the producer validates with before the event reaches its outbox.
 *
 * ## Who owns what (ADR-048 § 2)
 *
 * `marketplace` owns the return request and the commercial decision about it: the first four events
 * are its. The physical half — the return shipment, its receipt, inspection and disposition — is
 * `inventory-service`'s and has its own events (`inventory-returns.ts`); the last four are
 * marketplace stating, on its own request, a physical step it has checked against that request
 * (RUN-005 PR 3). `economic` owns every Hold, Refund and Reversal; no event here moves money or
 * asks for it to move.
 *
 * ## One stream per return request, in order
 *
 * Every event is keyed by `returnRequestId`. `returnVersion` is the request's position in its own
 * history (1 = REQUESTED, 2 = its second status, and so on to 6 = RESOLVED). Like the shipment stream (D-027),
 * delivery order is not guaranteed: a consumer orders and de-duplicates by the envelope's
 * `streamSeq` and never reads arrival order as the order things happened in.
 *
 * ## What these payloads never carry
 *
 * **Identifiers, integer quantities and instants only.** The buyer's free-text reason stays in
 * marketplace-service and is read through its API; no address, no amount, no personal data.
 * People are named by user id.
 */

export const RETURN_REQUEST_EVENTS = {
  RETURN_REQUESTED: 'RETURN_REQUESTED',
  RETURN_AUTHORIZED: 'RETURN_AUTHORIZED',
  RETURN_REJECTED: 'RETURN_REJECTED',
  RETURN_CANCELLED: 'RETURN_CANCELLED',
  // The physical half, mirrored from inventory-service once marketplace has checked it against
  // this request (ADR-048 § 3; RUN-005 PR 3). Marketplace states these; it moved no goods.
  RETURN_IN_TRANSIT: 'RETURN_IN_TRANSIT',
  RETURN_RECEIVED: 'RETURN_RECEIVED',
  RETURN_INSPECTED: 'RETURN_INSPECTED',
  RETURN_RESOLVED: 'RETURN_RESOLVED',
} as const;

export type ReturnRequestEventName = keyof typeof RETURN_REQUEST_EVENTS;

/** The aggregate every return-request event is about, and its stream key's name. */
export const RETURN_REQUEST_AGGREGATE = 'ReturnRequest';

const ulid = '[0-9A-HJKMNP-TV-Z]{26}';
const returnRequestId = z.string().regex(new RegExp(`^${ID_PREFIXES.returnRequest}_${ulid}$`));
const orderId = z.string().regex(new RegExp(`^${ID_PREFIXES.order}_${ulid}$`));
const orderLineId = z.string().min(1).max(128);
/** A platform identifier of a person, as every other event carries one. */
const id = z.string().min(1).max(128);
/** ISO 8601 in UTC, the form every event of the platform carries a time in. */
const instant = z.string().datetime({ offset: false });

/** One order line being returned, and how many of it. Never a price. */
export const returnLineSchema = z
  .object({
    orderLineId,
    productId: z.string().min(1).max(128),
    quantity: z.number().int().min(1),
  })
  .strict();

/** What every return-request event says: which request, for which order, between whom. */
const returnFacts = {
  returnRequestId,
  orderId,
  /** The buyer — the tenant that owns the request. */
  buyerOrganizationId: organizationIdSchema,
  /** The seller who decides it and receives the goods back. */
  supplierOrganizationId: organizationIdSchema,
  lines: z.array(returnLineSchema).min(1).max(100),
};

/** A buyer asked to return goods of a completed order. */
export const returnRequestedPayloadSchema = z
  .object({
    ...returnFacts,
    returnVersion: z.literal(1),
    requestedBy: id,
    requestedAt: instant,
  })
  .strict();

/** The supplier authorized it: REQUESTED → AUTHORIZED. Nothing physical has happened yet. */
export const returnAuthorizedPayloadSchema = z
  .object({
    ...returnFacts,
    returnVersion: z.literal(2),
    authorizedBy: id,
    authorizedAt: instant,
  })
  .strict();

/** The supplier refused it: REQUESTED → REJECTED. */
export const returnRejectedPayloadSchema = z
  .object({
    ...returnFacts,
    returnVersion: z.literal(2),
    rejectedBy: id,
    rejectedAt: instant,
  })
  .strict();

/** The buyer withdrew it before any goods moved: REQUESTED|AUTHORIZED → CANCELLED. */
export const returnCancelledPayloadSchema = z
  .object({
    ...returnFacts,
    returnVersion: z.union([z.literal(2), z.literal(3)]),
    cancelledFrom: z.enum(['REQUESTED', 'AUTHORIZED']),
    cancelledBy: id,
    cancelledAt: instant,
  })
  .strict()
  .refine((p) => p.returnVersion === (p.cancelledFrom === 'REQUESTED' ? 2 : 3), {
    message: 'returnVersion must be 2 from REQUESTED and 3 from AUTHORIZED',
  });

// ---------------------------------------------------------------------------
// The physical half, as the request states it (RUN-005 PR 3)
//
// Each of these is emitted only after marketplace verified the inventory-service event it mirrors
// against its own request (it exists, it was AUTHORIZED, the supplier is the event's tenant, the
// lines are the request's). `returnShipmentId` links the two aggregates; the version continues the
// request's own history (3 IN_TRANSIT, 4 RECEIVED, 5 INSPECTED, 6 RESOLVED). None of them moves
// goods, stock or money, and none asks for any.
// ---------------------------------------------------------------------------

const returnShipmentId = z.string().regex(new RegExp(`^${ID_PREFIXES.returnShipment}_${ulid}$`));

const distinctLines = (lines: readonly { orderLineId: string }[]) =>
  new Set(lines.map((line) => line.orderLineId)).size === lines.length;

/** The goods left the buyer: AUTHORIZED → IN_TRANSIT. From here the buyer cannot cancel. */
export const returnInTransitPayloadSchema = z
  .object({
    ...returnFacts,
    returnVersion: z.literal(3),
    returnShipmentId,
    inTransitAt: instant,
  })
  .strict();

/** What arrived, per line, as the supplier's warehouse recorded it: IN_TRANSIT → RECEIVED. */
export const returnReceivedPayloadSchema = z
  .object({
    ...returnFacts,
    returnVersion: z.literal(4),
    returnShipmentId,
    receivedLines: z
      .array(z.object({ orderLineId, receivedQuantity: z.number().int().min(0) }).strict())
      .min(1)
      .max(100)
      .refine(distinctLines, { message: 'an order line appears once' }),
    receivedAt: instant,
  })
  .strict();

/** The received goods were examined: RECEIVED → INSPECTED. Still no refund, still not stock. */
export const returnInspectedPayloadSchema = z
  .object({
    ...returnFacts,
    returnVersion: z.literal(5),
    returnShipmentId,
    reportDocumentId: z
      .string()
      .regex(new RegExp(`^${ID_PREFIXES.document}_${ulid}$`))
      .nullable(),
    inspectedAt: instant,
  })
  .strict();

/** What became of every received unit: INSPECTED → RESOLVED. The end of the physical half. */
export const returnResolvedPayloadSchema = z
  .object({
    ...returnFacts,
    returnVersion: z.literal(6),
    returnShipmentId,
    // Empty exactly when nothing arrived and the deployment resolves such a return (Q-133 (4)):
    // the same list `RETURN_SHIPMENT_RESOLVED` carries, which may be empty for that one case.
    outcomes: z
      .array(
        z
          .object({
            orderLineId,
            disposition: z.enum(RETURN_DISPOSITIONS),
            quantity: z.number().int().min(1),
          })
          .strict(),
      )
      .max(300)
      .refine(
        (rows) =>
          new Set(rows.map((row) => `${row.orderLineId}|${row.disposition}`)).size === rows.length,
        { message: 'a line has one row per disposition' },
      ),
    resolvedAt: instant,
  })
  .strict();

export const RETURN_REQUEST_EVENT_SCHEMAS = {
  RETURN_REQUESTED: returnRequestedPayloadSchema,
  RETURN_AUTHORIZED: returnAuthorizedPayloadSchema,
  RETURN_REJECTED: returnRejectedPayloadSchema,
  RETURN_CANCELLED: returnCancelledPayloadSchema,
  RETURN_IN_TRANSIT: returnInTransitPayloadSchema,
  RETURN_RECEIVED: returnReceivedPayloadSchema,
  RETURN_INSPECTED: returnInspectedPayloadSchema,
  RETURN_RESOLVED: returnResolvedPayloadSchema,
} as const satisfies Record<ReturnRequestEventName, z.ZodTypeAny>;

export type ReturnLine = z.infer<typeof returnLineSchema>;
export type ReturnRequestedPayload = z.infer<typeof returnRequestedPayloadSchema>;
export type ReturnAuthorizedPayload = z.infer<typeof returnAuthorizedPayloadSchema>;
export type ReturnRejectedPayload = z.infer<typeof returnRejectedPayloadSchema>;
export type ReturnCancelledPayload = z.infer<typeof returnCancelledPayloadSchema>;
export type ReturnInTransitPayload = z.infer<typeof returnInTransitPayloadSchema>;
export type ReturnReceivedPayload = z.infer<typeof returnReceivedPayloadSchema>;
export type ReturnInspectedPayload = z.infer<typeof returnInspectedPayloadSchema>;
export type ReturnResolvedPayload = z.infer<typeof returnResolvedPayloadSchema>;
