import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import type { SealedEnvelope } from '@rasta/sealing';
import type { Quotation } from '../generated/prisma';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';

/** The RFQ as a quotation needs it, share-locked through the caller's own invitation. */
export interface LockedRfqForQuotation {
  id: string;
  /** The buyer: the tenant every quotation row of this RFQ is stored under. */
  organizationId: string;
  status: string;
  quotationClosingAt: Date;
  totalQuantity: number;
  keyId: string;
  publicKeyPem: string;
}

export interface ReceiptSlot {
  seq: number;
  previousReceipt: string | null;
}

/**
 * Every write of a quotation and its receipt chain (ADR-070 § 4, § 10; plan PR 8).
 *
 * ## Where the tenant guard is crossed, and how
 *
 * A quotation is stored under the **buyer's** organization, and the caller of every method here is
 * the **invited supplier**, another tenant. So each statement is a reasoned `runUnscoped` whose
 * predicate is written out: the RFQ is reached only through an invitation of the organization the
 * token names, and every quotation row through the buyer that invitation names **and** that
 * supplier. Nothing here reads a row the caller's own invitation does not lead to.
 *
 * ## The lock order
 *
 * The RFQ `FOR SHARE` (quotations share it; the close and the cancel take it `FOR UPDATE`, so a
 * quotation and a close queue behind one another), then the supplier's own quotation `FOR UPDATE`,
 * then the chain's advisory lock — the order every quotation command takes.
 */
@Injectable()
export class QuotationRepository {
  /**
   * The RFQ `FOR SHARE`, found through the caller organization's invitation — or null: no
   * invitation, no RFQ (404, ADR-070 § 10).
   */
  async lockInvitedRfq(
    tx: ExtendedPrismaClient,
    supplierOrganizationId: string,
    rfqId: string,
  ): Promise<LockedRfqForQuotation | null> {
    const rows = await tx.$queryRaw<LockedRfqForQuotation[]>`
      SELECT r.id, r.organization_id AS "organizationId", r.status,
             r.quotation_closing_at AS "quotationClosingAt", r.total_quantity AS "totalQuantity",
             r.key_id AS "keyId", r.public_key_pem AS "publicKeyPem"
        FROM rfq r
        JOIN rfq_invitation i ON i.organization_id = r.organization_id AND i.rfq_id = r.id
       WHERE r.id = ${rfqId} AND i.supplier_organization_id = ${supplierOrganizationId}
         FOR SHARE OF r`;
    return rows[0] ?? null;
  }

  /** The supplier's own quotation on the RFQ, `FOR UPDATE`, or null. */
  async lockOwnQuotation(
    tx: ExtendedPrismaClient,
    rfq: { organizationId: string; id: string },
    supplierOrganizationId: string,
  ): Promise<Quotation | null> {
    await tx.$queryRaw`
      SELECT 1 FROM quotation
       WHERE organization_id = ${rfq.organizationId} AND rfq_id = ${rfq.id}
         AND supplier_organization_id = ${supplierOrganizationId}
         FOR UPDATE`;
    return this.findOwn(tx, rfq, supplierOrganizationId);
  }

  findOwn(
    tx: ExtendedPrismaClient,
    rfq: { organizationId: string; id: string },
    supplierOrganizationId: string,
  ): Promise<Quotation | null> {
    return runUnscoped(OWN_QUOTATION, () =>
      tx.quotation.findFirst({
        where: { organizationId: rfq.organizationId, rfqId: rfq.id, supplierOrganizationId },
      }),
    );
  }

  async insert(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      rfq: LockedRfqForQuotation;
      supplierOrganizationId: string;
      sealed: SealedEnvelope;
      actor: string;
      at: Date;
    },
  ): Promise<void> {
    await runUnscoped(OWN_QUOTATION, () =>
      tx.quotation.create({
        data: {
          id: input.id,
          organizationId: input.rfq.organizationId,
          rfqId: input.rfq.id,
          supplierOrganizationId: input.supplierOrganizationId,
          status: 'SUBMITTED',
          revision: 1,
          ...sealedColumns(input.sealed),
          submittedAt: input.at,
          submittedBy: input.actor,
          receivedAt: input.at,
          updatedAt: input.at,
          updatedBy: input.actor,
        },
      }),
    );
  }

  /** The next revision's seal: compare-and-set on the revision it read; 0 or 1. */
  async reseal(
    tx: ExtendedPrismaClient,
    quotation: Quotation,
    input: { sealed: SealedEnvelope; actor: string; at: Date },
  ): Promise<number> {
    const { count } = await runUnscoped(OWN_QUOTATION, () =>
      tx.quotation.updateMany({
        where: {
          organizationId: quotation.organizationId,
          id: quotation.id,
          supplierOrganizationId: quotation.supplierOrganizationId,
          status: 'SUBMITTED',
          revision: quotation.revision,
        },
        data: {
          revision: quotation.revision + 1,
          ...sealedColumns(input.sealed),
          receivedAt: input.at,
          updatedAt: input.at,
          updatedBy: input.actor,
        },
      }),
    );
    return count;
  }

  /** SUBMITTED → WITHDRAWN, compare-and-set on the revision it read; 0 or 1. */
  async withdraw(
    tx: ExtendedPrismaClient,
    quotation: Quotation,
    input: { actor: string; at: Date },
  ): Promise<number> {
    const { count } = await runUnscoped(OWN_QUOTATION, () =>
      tx.quotation.updateMany({
        where: {
          organizationId: quotation.organizationId,
          id: quotation.id,
          supplierOrganizationId: quotation.supplierOrganizationId,
          status: 'SUBMITTED',
          revision: quotation.revision,
        },
        data: {
          status: 'WITHDRAWN',
          withdrawnAt: input.at,
          updatedAt: input.at,
          updatedBy: input.actor,
        },
      }),
    );
    return count;
  }

  // -- the receipt chain ---------------------------------------------------------------------

  /**
   * The next place in the RFQ's chain. A transaction-scoped advisory lock keyed by the RFQ
   * serialises every append (the RFQ row is only shared among suppliers), and the newest link is
   * read once it is held, so two quotations never take the same place or predecessor. Released at
   * commit.
   */
  async nextReceiptSlot(
    tx: ExtendedPrismaClient,
    rfq: LockedRfqForQuotation,
  ): Promise<ReceiptSlot> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`quotation_receipt:${rfq.id}`}, 0))`;
    const last = await runUnscoped(CHAIN, () =>
      tx.quotationReceipt.findFirst({
        where: { organizationId: rfq.organizationId, rfqId: rfq.id },
        orderBy: { seq: 'desc' },
        select: { seq: true, receipt: true },
      }),
    );
    return { seq: (last?.seq ?? 0) + 1, previousReceipt: last?.receipt ?? null };
  }

  async insertReceipt(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      rfqId: string;
      seq: number;
      quotationId: string;
      revision: number;
      receivedAt: Date;
      ciphertextSha256: string;
      contentCommitment: string;
      previousReceipt: string;
      receipt: string;
      eligibleAsOf: Date;
    },
  ): Promise<void> {
    await runUnscoped(CHAIN, () => tx.quotationReceipt.create({ data: input }));
  }

  /** The receipt issued for one revision of the supplier's own quotation, or null. */
  async receiptOf(tx: ExtendedPrismaClient, quotation: Quotation): Promise<string | null> {
    const link = await runUnscoped(OWN_QUOTATION, () =>
      tx.quotationReceipt.findFirst({
        where: {
          organizationId: quotation.organizationId,
          quotationId: quotation.id,
          revision: quotation.revision,
        },
        select: { receipt: true },
      }),
    );
    return link?.receipt ?? null;
  }
}

const OWN_QUOTATION =
  'an invited supplier acts on its own quotation, stored under the buyer named by its own invitation; the buyer and the supplier the token names are both in the predicate (ADR-070 § 10)';
const CHAIN =
  'a quotation appends one link to its RFQ’s receipt chain, under the buyer named by the supplier’s own invitation, the RFQ share-locked (ADR-066 § 3)';

function sealedColumns(sealed: SealedEnvelope) {
  return {
    sealVersion: sealed.version,
    keyId: sealed.keyId,
    // A copy into a plain `ArrayBuffer`: the client's byte columns do not take a Buffer, whose
    // backing store may be shared.
    nonce: new Uint8Array(sealed.nonce),
    ciphertext: new Uint8Array(sealed.ciphertext),
    tag: new Uint8Array(sealed.tag),
    wrappedContentKey: new Uint8Array(sealed.wrappedContentKey),
    contentCommitment: sealed.contentCommitment,
    ciphertextSha256: sealed.ciphertextSha256,
  };
}
