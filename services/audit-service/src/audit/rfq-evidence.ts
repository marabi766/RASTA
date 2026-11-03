import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DLQ_REASONS, isoDateTime, type EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError } from '@rasta/nest-common';

/**
 * The RFQ-evidence projection's rules, pure (COM-007 PR 7, ADR-070 § 4, ADR-066 § 2-3).
 *
 * The same rules `tender-evidence.ts` keeps for bids, for quotations. audit-service holds,
 * outside procurement-service's database, the **receipt chain** of each RFQ as announced when
 * each quotation was made — what opening the quotations is checked against, because
 * procurement-service cannot rewrite it. Built from `QUOTATION_SUBMITTED` /
 * `QUOTATION_REVISED` on `rasta.procurement.v1`, by a consumer of its own, with identifiers
 * and digests only.
 *
 * ## The wire shape, until `@rasta/contracts` carries it
 *
 * The `QUOTATION_*` events are produced by plan PR 8; `@rasta/contracts` holds only the RFQ
 * lifecycle events today (`events/procurement-rfq.ts`). The payload read here is the one
 * ADR-070 § 9 fixes — `rfqId`, `quotationId`, `revision`, `receipt`, `previousReceipt`,
 * `ciphertextSha256`, with the commitment and the instant the receipt chain is made of
 * (ADR-066 § 3) and the two organizations — shaped like `BID_SUBMITTED`. When the producer's
 * schema lands in the contracts package, this schema is checked against it (the producer's
 * `.strict()` shape is a superset of what is read here).
 */

export const RFQ_EVIDENCE_CONSUMER = 'audit-service.rfq-evidence';
export const PROCUREMENT_TOPIC = 'rasta.procurement.v1';
/** The only producer whose receipts extend an RFQ's chain. */
export const RFQ_EVIDENCE_PRODUCER = 'procurement-service';

/** The receipt-chain events of a quotation (ADR-070 § 9). `QUOTATION_WITHDRAWN` extends no chain. */
export const RFQ_RECEIPT_EVENTS = ['QUOTATION_SUBMITTED', 'QUOTATION_REVISED'] as const;

/**
 * The `(eventName, eventVersion)` pairs this projection understands — an explicit table, not "any
 * positive version". The shared envelope permits any positive version, and this mapper is not
 * `.strict()`, so without a boundary a v999 event with the v1 field names would be stored as if
 * it were v1. A pair that is not here is refused before anything is persisted (dead-lettered
 * with `SCHEMA_VERSION_UNSUPPORTED`, like the other evidence projections). A new version is a
 * deliberate entry, together with the mapping it needs.
 */
export const RFQ_RECEIPT_EVENT_VERSIONS: Readonly<
  Record<(typeof RFQ_RECEIPT_EVENTS)[number], readonly number[]>
> = {
  QUOTATION_SUBMITTED: [1],
  QUOTATION_REVISED: [1],
};

/**
 * The domain-separation label of an RFQ chain's genesis: the quotation twin of
 * `rasta.bid.receipt.genesis.v1`. Part of the bytes — procurement-service's
 * `SealingLabels.receiptGenesis` (plan PR 8) must be exactly this, or its first receipt does
 * not continue the chain held here; `rfq-evidence.spec.ts` pins the bytes.
 */
export const RFQ_RECEIPT_GENESIS_LABEL = 'rasta.quotation.receipt.genesis.v1';

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const identifier = z.string().min(1).max(128);
const instant = z.string().check(isoDateTime());

/**
 * Not `.strict()` on the way in, unlike the producer's own schema: this consumer reads what it
 * needs and keeps nothing else, so a field a later producer version adds must not make
 * audit-service refuse the receipt it exists to hold.
 */
export const quotationReceiptPayloadSchema = z
  .object({
    rfqId: identifier,
    quotationId: identifier,
    /** The buyer: the RFQ's owner, and the tenant the envelope is signed for. */
    organizationId: identifier,
    supplierOrganizationId: identifier,
    revision: z.number().int().positive(),
    receivedAt: instant,
    contentCommitment: sha256Hex,
    ciphertextSha256: sha256Hex,
    previousReceipt: sha256Hex,
    receipt: sha256Hex,
  })
  // A link that is its own predecessor is no link.
  .refine((link) => link.receipt !== link.previousReceipt, {
    message: 'a receipt is not its own predecessor',
  })
  // The genesis is where a chain starts, never a link in it: a receipt equal to it would let
  // `genesis -> A` followed by `A -> genesis` commit a cycle.
  .refine((link) => link.receipt !== genesisReceipt(link.rfqId), {
    message: 'a receipt is not the genesis',
  });

export type QuotationReceiptPayload = z.infer<typeof quotationReceiptPayloadSchema>;

/** An envelope whose payload is not the contract; the delivery is refused (retried, then dead-lettered). */
export class RfqEvidenceUnmappableError extends Error {
  constructor(eventName: string, eventId: string) {
    super(`${eventName} ${eventId} does not match the rfq-evidence contract`);
    this.name = 'RfqEvidenceUnmappableError';
  }
}

/**
 * The link the projection refuses: its predecessor already has a successor, or its receipt is
 * already recorded under another event (`FORK`) — a chain that splits is evidence of tampering
 * or a producer fault, and is never silently accepted.
 *
 * (A link whose predecessor has simply not arrived yet is **not** an error: it is held and
 * drained in order when the predecessor is appended.)
 */
export class RfqEvidenceContinuityError extends Error {
  constructor(
    /**
     * `FORK`: a second successor, or a receipt/predecessor already recorded (held or placed).
     * `CONFLICTING_REPLAY`: an event id already processed, now claiming other content.
     * `GENESIS_RECEIPT`: a receipt equal to the chain's genesis.
     */
    readonly reason: 'FORK' | 'CONFLICTING_REPLAY' | 'GENESIS_RECEIPT',
    eventId: string,
  ) {
    super(`receipt link of ${eventId} breaks the RFQ's chain (${reason})`);
    this.name = 'RfqEvidenceContinuityError';
  }
}

/**
 * The envelope and the payload disagree about whose record this is (the tenant, or the RFQ the
 * event is about), or the receipt belongs to an RFQ already held under another organization.
 * Neither answer is picked for the producer: the delivery is refused (retried, then
 * dead-lettered with this reason). Names the field, never its value.
 */
export class RfqEvidenceIdentityError extends Error {
  constructor(
    eventName: string,
    eventId: string,
    readonly field: 'tenantId' | 'rfqId' | 'organization' | 'producer',
  ) {
    super(`${eventName} ${eventId}: ${field} disagrees between the envelope and the payload`);
    this.name = 'RfqEvidenceIdentityError';
  }
}

/** An event this projection reads: a quotation's receipt. */
export interface RfqEvidenceEvent {
  eventId: string;
  payload: QuotationReceiptPayload;
}

/**
 * The receipt of a `QUOTATION_SUBMITTED` / `QUOTATION_REVISED`, or `undefined` for any other
 * event (the domain projector records those as audit rows). The envelope must name the same
 * tenant and the same RFQ as the payload: a mismatch is refused, never stored under either.
 */
export function toRfqEvidenceEvent(envelope: EventEnvelope): RfqEvidenceEvent | undefined {
  if (!(RFQ_RECEIPT_EVENTS as readonly string[]).includes(envelope.eventName)) return undefined;
  const eventName = envelope.eventName as (typeof RFQ_RECEIPT_EVENTS)[number];
  // Before the payload is looked at: what a version means is not known for a version not listed.
  const version = envelope.eventVersion ?? 1;
  if (!RFQ_RECEIPT_EVENT_VERSIONS[eventName].includes(version)) {
    throw new UnprocessableEventError(
      DLQ_REASONS.SCHEMA_VERSION_UNSUPPORTED,
      `${eventName} v${String(version)} has no rfq-evidence projection; ` +
        `only v${RFQ_RECEIPT_EVENT_VERSIONS[eventName].join(', v')} is understood`,
    );
  }
  const parsed = quotationReceiptPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) throw new RfqEvidenceUnmappableError(envelope.eventName, envelope.eventId);
  // The chain is a trust anchor: only the service that owns RFQs may extend it. The topic's
  // ACL already says so; this refuses a receipt that names another producer all the same.
  if (envelope.producer !== RFQ_EVIDENCE_PRODUCER) {
    throw new RfqEvidenceIdentityError(envelope.eventName, envelope.eventId, 'producer');
  }
  if (envelope.tenantId !== parsed.data.organizationId) {
    throw new RfqEvidenceIdentityError(envelope.eventName, envelope.eventId, 'tenantId');
  }
  if (envelope.aggregateId !== parsed.data.rfqId) {
    throw new RfqEvidenceIdentityError(envelope.eventName, envelope.eventId, 'rfqId');
  }
  return { eventId: envelope.eventId, payload: parsed.data };
}

/**
 * The receipt an RFQ's chain starts from. **Independent of procurement-service** (no
 * cross-service import): the same construction as `@rasta/sealing`'s `genesisReceipt`, so the
 * first link's predecessor can be checked here without taking the producer's word for it —
 * `SHA-256` over a domain label and the RFQ id, each length-prefixed.
 */
export function genesisReceipt(rfqId: string): string {
  const chunks: Buffer[] = [];
  for (const part of [RFQ_RECEIPT_GENESIS_LABEL, rfqId]) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    chunks.push(length, bytes);
  }
  return createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
}
