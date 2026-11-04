import { z } from 'zod';
import { isoDateTime } from '../common/iso-datetime';
import { ID_PREFIXES, organizationIdSchema } from '../common/identifiers';

/**
 * The quotation events of procurement-service on `rasta.procurement.v1` (ADR-070 § 4, § 9; COM-007
 * plan PR 8) — `docs/events/README.md` § Procurement.
 *
 * **Contract only (A-03).** Who may quote, revise or withdraw and when is procurement-service's.
 * audit-service's RFQ-evidence consumer (plan PR 7, `audit/rfq-evidence.ts`) reads
 * `QUOTATION_SUBMITTED` / `QUOTATION_REVISED` with its own non-strict schema, whose field names and
 * types are exactly these: its fixtures are parsed by these schemas in both packages' specs, so a
 * field renamed or retyped on either side fails a build.
 *
 * ## One stream per RFQ
 *
 * Keyed by `rfqId`, aggregate `Rfq` (ADR-070 § 9: an RFQ and its quotations are one stream; the
 * consumer refuses an envelope whose `aggregateId` is not the payload's `rfqId`).
 *
 * ## What these payloads never carry
 *
 * **No price, no answer, no note, no ciphertext** (ADR-066 § 6, ADR-070 § 8-9): a quotation is
 * named by its commitment and the digest of its sealed bytes, and the receipt chain links them.
 * The supplier is named — the envelope names the actor anyway (D-044 (b), D-055).
 */

export const PROCUREMENT_QUOTATION_EVENTS = {
  QUOTATION_SUBMITTED: 'QUOTATION_SUBMITTED',
  QUOTATION_REVISED: 'QUOTATION_REVISED',
  QUOTATION_WITHDRAWN: 'QUOTATION_WITHDRAWN',
} as const;

export type ProcurementQuotationEventName = keyof typeof PROCUREMENT_QUOTATION_EVENTS;

/**
 * The domain-separation label of an RFQ receipt chain's genesis. procurement-service seals with it
 * (`SealingLabels.receiptGenesis`) and audit-service recomputes the genesis with it independently
 * (`RFQ_RECEIPT_GENESIS_LABEL`, bytes pinned in `rfq-evidence.spec.ts`): part of every receipt
 * already issued — never change it.
 */
export const QUOTATION_RECEIPT_GENESIS_LABEL = 'rasta.quotation.receipt.genesis.v1';

const prefixed = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));

const rfqId = prefixed(ID_PREFIXES.rfq);
const quotationId = prefixed(ID_PREFIXES.quotation);
/** A platform identifier of a person or an organization, as every other event carries one. */
const id = z.string().min(1).max(128);
/** ISO 8601 in UTC, the form every event of the platform carries a time in. */
const instant = z.string().check(isoDateTime({ offset: false }));
/** Lowercase hex SHA-256. */
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const quotationFacts = {
  rfqId,
  quotationId,
  /** The buyer — the tenant of the RFQ, and the tenant the envelope is signed for. */
  organizationId: id,
  /** The invited supplier whose quotation this is. */
  supplierOrganizationId: organizationIdSchema,
};

const receiptFields = {
  ...quotationFacts,
  /** When the database clock received this revision. */
  receivedAt: instant,
  /** The salted commitment to the canonical content (ADR-066 § 3). */
  contentCommitment: sha256,
  /** SHA-256 of the sealed bytes as stored. */
  ciphertextSha256: sha256,
  /** The RFQ chain's head before this link: its genesis for the first. */
  previousReceipt: sha256,
  /** The new head of the RFQ's chain. */
  receipt: sha256,
  submittedBy: id,
};

const notOwnPredecessor = {
  message: 'a receipt is not its own predecessor',
};

/** A quotation was sealed and its first receipt issued (revision 1). */
export const quotationSubmittedPayloadSchema = z
  .object({ ...receiptFields, revision: z.literal(1) })
  .strict()
  .refine((link) => link.receipt !== link.previousReceipt, notOwnPredecessor);

/** A quotation was sealed again under its next revision, and that revision's receipt issued. */
export const quotationRevisedPayloadSchema = z
  .object({ ...receiptFields, revision: z.number().int().min(2).max(2_147_483_647) })
  .strict()
  .refine((link) => link.receipt !== link.previousReceipt, notOwnPredecessor);

/**
 * SUBMITTED → WITHDRAWN before the deadline, at the revision the supplier last sealed. Extends no
 * chain: no receipt is issued (`docs/adr/ADR-070-implementation-plan.md` PR 7 note 3).
 */
export const quotationWithdrawnPayloadSchema = z
  .object({
    ...quotationFacts,
    revision: z.number().int().min(1).max(2_147_483_647),
    withdrawnBy: id,
    withdrawnAt: instant,
  })
  .strict();

export const PROCUREMENT_QUOTATION_EVENT_SCHEMAS = {
  QUOTATION_SUBMITTED: quotationSubmittedPayloadSchema,
  QUOTATION_REVISED: quotationRevisedPayloadSchema,
  QUOTATION_WITHDRAWN: quotationWithdrawnPayloadSchema,
} as const satisfies Record<ProcurementQuotationEventName, z.ZodTypeAny>;

export type QuotationSubmittedPayload = z.infer<typeof quotationSubmittedPayloadSchema>;
export type QuotationRevisedPayload = z.infer<typeof quotationRevisedPayloadSchema>;
export type QuotationWithdrawnPayload = z.infer<typeof quotationWithdrawnPayloadSchema>;
