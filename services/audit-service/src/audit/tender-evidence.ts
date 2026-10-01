import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EventEnvelope } from '@rasta/contracts';

/**
 * The tender-evidence projection's rules, pure (CON-002 PR 6, ADR-066 § 2-3, § 5).
 *
 * audit-service holds, outside construction-service's database, two things the
 * bid path needs to be trusted: the **receipt chain** of each tender, as announced
 * when each bid was made, and the **record of every read** of a bid. It is built from
 * `BID_SUBMITTED` / `BID_REVISED` / `BID_ACCESSED` on `rasta.construction.v1`, by a
 * consumer of its own, with identifiers and digests only.
 */

export const TENDER_EVIDENCE_CONSUMER = 'audit-service.tender-evidence';
export const CONSTRUCTION_TOPIC = 'rasta.construction.v1';

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const identifier = z.string().min(1).max(128);
const instant = z.string().datetime();

/**
 * Not `.strict()` on the way in, unlike the producer's own schema: this consumer
 * reads what it needs and keeps nothing else, so a field a later producer version
 * adds must not make audit-service refuse the receipt it exists to hold.
 */
export const receiptPayloadSchema = z
  .object({
    bidId: identifier,
    tenderId: identifier,
    organizationId: identifier,
    bidderOrganizationId: identifier,
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
  });

export type ReceiptPayload = z.infer<typeof receiptPayloadSchema>;

export const accessPayloadSchema = z.object({
  bidId: identifier.nullable(),
  tenderId: identifier,
  organizationId: identifier,
  accessorOrganizationId: identifier,
  accessedBy: identifier,
  purpose: z.string().min(1).max(64),
  outcome: z.enum(['GRANTED', 'REFUSED']),
  accessedAt: instant,
});

export type AccessPayload = z.infer<typeof accessPayloadSchema>;

/** Which of the three events this projection reads, if any. */
export type TenderEvidenceEvent =
  | { kind: 'RECEIPT'; eventId: string; payload: ReceiptPayload }
  | { kind: 'ACCESS'; eventId: string; payload: AccessPayload };

/** An envelope whose payload is not the contract; the delivery is refused (retried, then dead-lettered). */
export class TenderEvidenceUnmappableError extends Error {
  constructor(eventName: string, eventId: string) {
    super(`${eventName} ${eventId} does not match the tender-evidence contract`);
    this.name = 'TenderEvidenceUnmappableError';
  }
}

/**
 * The link the projection could not accept: it names a predecessor this service has
 * not (yet) seen (`GAP` — an out-of-order delivery is retried and resolves; one that
 * never does is dead-lettered), or one that already has a successor, or a receipt
 * already recorded under another event (`FORK`) — a chain that splits is evidence of
 * tampering or a producer fault, and is never silently accepted.
 */
export class TenderEvidenceContinuityError extends Error {
  constructor(
    readonly reason: 'GAP' | 'FORK',
    eventId: string,
  ) {
    super(`receipt link of ${eventId} breaks the tender's chain (${reason})`);
    this.name = 'TenderEvidenceContinuityError';
  }
}

export function toTenderEvidenceEvent(envelope: EventEnvelope): TenderEvidenceEvent | undefined {
  if (envelope.eventName === 'BID_SUBMITTED' || envelope.eventName === 'BID_REVISED') {
    const parsed = receiptPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success)
      throw new TenderEvidenceUnmappableError(envelope.eventName, envelope.eventId);
    return { kind: 'RECEIPT', eventId: envelope.eventId, payload: parsed.data };
  }
  if (envelope.eventName === 'BID_ACCESSED') {
    const parsed = accessPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success)
      throw new TenderEvidenceUnmappableError(envelope.eventName, envelope.eventId);
    return { kind: 'ACCESS', eventId: envelope.eventId, payload: parsed.data };
  }
  return undefined;
}

/**
 * The receipt a tender's chain starts from. **Independent of construction-service**
 * (no cross-service import): the same construction, so that the first link's
 * predecessor can be checked here without taking the producer's word for it —
 * `SHA-256` over a domain label and the tender id, each length-prefixed.
 */
export function genesisReceipt(tenderId: string): string {
  const chunks: Buffer[] = [];
  for (const part of ['rasta.bid.receipt.genesis.v1', tenderId]) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    chunks.push(length, bytes);
  }
  return createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
}
