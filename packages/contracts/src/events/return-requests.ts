import { z } from 'zod';
import { ID_PREFIXES, organizationIdSchema } from '../common/identifiers';

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
 * `marketplace` owns the return request and the commercial decision about it: these four events
 * are its. The physical half — the return shipment, its receipt, inspection and disposition — is
 * `inventory-service`'s and has its own events (`inventory-returns.ts`). `economic` owns every
 * Hold, Refund and Reversal; no event here moves money or asks for it to move.
 *
 * ## One stream per return request, in order
 *
 * Every event is keyed by `returnRequestId`. `returnVersion` is the request's position in its own
 * history (1 = REQUESTED, 2 = its second status, 3 = its third). Like the shipment stream (D-027),
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

export const RETURN_REQUEST_EVENT_SCHEMAS = {
  RETURN_REQUESTED: returnRequestedPayloadSchema,
  RETURN_AUTHORIZED: returnAuthorizedPayloadSchema,
  RETURN_REJECTED: returnRejectedPayloadSchema,
  RETURN_CANCELLED: returnCancelledPayloadSchema,
} as const satisfies Record<ReturnRequestEventName, z.ZodTypeAny>;

export type ReturnLine = z.infer<typeof returnLineSchema>;
export type ReturnRequestedPayload = z.infer<typeof returnRequestedPayloadSchema>;
export type ReturnAuthorizedPayload = z.infer<typeof returnAuthorizedPayloadSchema>;
export type ReturnRejectedPayload = z.infer<typeof returnRejectedPayloadSchema>;
export type ReturnCancelledPayload = z.infer<typeof returnCancelledPayloadSchema>;
