import { z } from 'zod';
import { isoDateTime } from '../common/iso-datetime';
import { ID_PREFIXES, organizationIdSchema } from '../common/identifiers';

/**
 * The RFQ events of procurement-service on `rasta.procurement.v1` (ADR-070 § 3, § 9; COM-007
 * plan PR 6) — `docs/events/README.md` § Procurement.
 *
 * **Contract only (A-03).** Names, wire shapes and their bounds; who may issue, close or cancel an
 * RFQ and when is procurement-service's, decided there and nowhere else. audit-service's RFQ
 * evidence consumer (plan PR 7) validates what it reads with the same schemas the producer
 * validates with before the event reaches its outbox.
 *
 * ## One stream per RFQ
 *
 * Every event here is keyed by `rfqId` (ADR-070 § 9: the RFQ and its quotations are one stream);
 * `rfqVersion` is the RFQ's position in its own history (1 at issue, one more per change). Like
 * every stream of the platform today, delivery order is not guaranteed (D-027, open): a consumer
 * orders by the envelope's `streamSeq` (`streamKey` = `rfqId`), never by arrival.
 *
 * ## What these payloads never carry
 *
 * **Identifiers, a quantity, closed codes, a digest and instants only** (ADR-070 § 9). No criterion
 * label, no cancellation text, no amount, no personal data: the topic is read by every service that
 * declares a subscription, and by audit-service in full. The criteria are named by their digest
 * (`criteriaDigest`); the buyer reads them through the API. The invited suppliers are named — the
 * envelope names the actor anyway, so the identities of the organizations in a procurement are
 * visible on the topic by decision (D-044 (b), D-055).
 */

export const PROCUREMENT_RFQ_EVENTS = {
  RFQ_ISSUED: 'RFQ_ISSUED',
  RFQ_CLOSED: 'RFQ_CLOSED',
  RFQ_CANCELLED: 'RFQ_CANCELLED',
} as const;

export type ProcurementRfqEventName = keyof typeof PROCUREMENT_RFQ_EVENTS;

/** The aggregate every RFQ event is about, and its stream key's name. */
export const RFQ_AGGREGATE = 'Rfq';

/** ADR-023, Q-03: required on every RFQ, with no default. */
export const PROCUREMENT_NATURES = ['FORMAL_TENDER', 'INQUIRY', 'RFP', 'MARKETPLACE_DEAL'] as const;

/** Every status of the RFQ lifecycle (ADR-070 § 3), the later plan PRs' included. */
export const RFQ_STATES = [
  'PUBLISHED',
  'CLOSED',
  'EVALUATING',
  'EVALUATED',
  'AWARDED',
  'CANCELLED',
] as const;

/**
 * The form of a reason code an RFQ is cancelled for: upper-case words, 2 to 64 characters. Which
 * codes are accepted is procurement-service's configuration (`PROCUREMENT_RFQ_CANCELLATION_CODES`,
 * a closed list, `BUYER_REQUEST` by default — the planned `CancelRfq`), so a consumer reads the
 * code as data and never as a closed enum of its own.
 */
export const RFQ_CANCELLATION_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

/** The codes procurement-service accepts when its configuration names none. */
export const DEFAULT_RFQ_CANCELLATION_CODES = ['BUYER_REQUEST'] as const;

/**
 * Codes ADR-070 § 3 names whose fact the service must check itself, so no configuration may offer
 * them before that check exists: `NO_QUALIFIED_QUOTATION` arrives with evaluation (plan PR 10).
 */
export const RESERVED_RFQ_CANCELLATION_CODES = ['NO_QUALIFIED_QUOTATION'] as const;

/** How an RFQ was closed: by the close sweeper at its deadline, or by a person after it. */
export const RFQ_CLOSE_TRIGGERS = ['SWEEPER', 'MANUAL'] as const;

/** `<PREFIX>_<ULID>`, the form of every identifier procurement-service mints. */
const prefixed = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));

const rfqId = prefixed(ID_PREFIXES.rfq);
const aggregationId = prefixed('AGG');
const productId = prefixed('PRD');
/** A platform identifier of a person or an organization, as every other event carries one. */
const id = z.string().min(1).max(128);
/** ISO 8601 in UTC, the form every event of the platform carries a time in. */
const instant = z.string().check(isoDateTime({ offset: false }));
/** Lowercase hex SHA-256. */
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** The most suppliers one RFQ invites: the bound of `PROCUREMENT_RFQ_MAX_INVITEES` (Q-121 (1)). */
export const RFQ_MAX_INVITEES_LIMIT = 500;

/** What every RFQ event says about the RFQ: which, of whom, from which aggregation, where in its history. */
const rfqFacts = {
  rfqId,
  /** The buyer — the tenant of the RFQ. */
  organizationId: id,
  aggregationId,
  rfqVersion: z.number().int().min(1),
};

/**
 * An RFQ was issued from a READY aggregation, PUBLISHED, in one transaction with the aggregation's
 * READY → RFQ_ISSUED (ADR-070 § 3). `totalQuantity` is the aggregation's, frozen; `criteriaDigest`
 * names the frozen criteria; `keyId` the RFQ's sealing key (its public half is read through the
 * API by the invited suppliers).
 */
export const rfqIssuedPayloadSchema = z
  .object({
    ...rfqFacts,
    rfqVersion: z.literal(1),
    productId,
    totalQuantity: z.number().int().min(1).max(2_147_483_647),
    procurementNature: z.enum(PROCUREMENT_NATURES),
    quotationClosingAt: instant,
    invitedSupplierOrganizationIds: z
      .array(organizationIdSchema)
      .min(1)
      .max(RFQ_MAX_INVITEES_LIMIT)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'Invitees are distinct' }),
    criteriaCount: z.number().int().min(1),
    criteriaDigest: sha256,
    keyId: id,
    issuedBy: id,
    issuedAt: instant,
  })
  .strict();

/**
 * PUBLISHED → CLOSED, at or after `quotationClosingAt` by the database clock: by the close sweeper
 * (`closedBy` null) or by a person of the buyer (`MANUAL`). `quotationCount` is the count ADR-070
 * § 9 promises: the sealed quotations the RFQ holds at its close — 0 until quotations arrive (plan
 * PR 8).
 */
export const rfqClosedPayloadSchema = z
  .object({
    ...rfqFacts,
    quotationClosingAt: instant,
    trigger: z.enum(RFQ_CLOSE_TRIGGERS),
    closedBy: id.nullable(),
    closedAt: instant,
    quotationCount: z.number().int().min(0),
  })
  .strict()
  .refine((payload) => (payload.trigger === 'SWEEPER') === (payload.closedBy === null), {
    message: 'A person closes MANUAL; the sweeper closes with no person',
  });

/**
 * Any status but AWARDED → CANCELLED, with a reason code from the producer's closed list
 * (`RFQ_CANCELLATION_CODE_PATTERN`). The aggregation stays RFQ_ISSUED (Q-121 (4)). The text the
 * buyer may give stays in procurement-service.
 */
export const rfqCancelledPayloadSchema = z
  .object({
    ...rfqFacts,
    previousStatus: z.enum(['PUBLISHED', 'CLOSED', 'EVALUATING', 'EVALUATED']),
    reasonCode: z.string().regex(RFQ_CANCELLATION_CODE_PATTERN),
    cancelledBy: id,
    cancelledAt: instant,
  })
  .strict();

export const PROCUREMENT_RFQ_EVENT_SCHEMAS = {
  RFQ_ISSUED: rfqIssuedPayloadSchema,
  RFQ_CLOSED: rfqClosedPayloadSchema,
  RFQ_CANCELLED: rfqCancelledPayloadSchema,
} as const satisfies Record<ProcurementRfqEventName, z.ZodTypeAny>;

export type RfqIssuedPayload = z.infer<typeof rfqIssuedPayloadSchema>;
export type RfqClosedPayload = z.infer<typeof rfqClosedPayloadSchema>;
export type RfqCancelledPayload = z.infer<typeof rfqCancelledPayloadSchema>;
