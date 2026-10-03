import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import type {
  Bid,
  BidEvaluation,
  BidEvaluationRecusal,
  BidEvaluationScore,
  BidQualification,
  Tender,
  TenderCriterion,
  TenderKey,
} from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { SealedBid } from './sealing/sealing';

/**
 * Every read and write of a bid, its receipt chain, its access log, and the
 * tenders a bidder may see.
 *
 * ## Where the tenant guard is crossed, and how
 *
 * A bid is stored under the **tender owner's** organization (`organization_id`),
 * and the caller of every method here is the **bidder**, another tenant. So each
 * statement is a reasoned `runUnscoped` with the predicate written out: the bidder
 * (`bidder_organization_id`) on anything of a bid, the tender's id on anything of a
 * tender. Nothing here lists across tenders without a predicate that names the
 * caller's organization. The owner's side (PR 8) goes through the ordinary guard.
 */

export interface LockedTenderForBid {
  id: string;
  organizationId: string;
  status: string;
  visibility: string | null;
  bidOpeningAt: Date | null;
  bidClosingAt: Date | null;
}

export interface LockedBid {
  id: string;
  organizationId: string;
  tenderId: string;
  bidderOrganizationId: string;
  status: string;
  revision: number;
}

export interface ReceiptSlot {
  seq: number;
  previousReceipt: string | null;
}

const BIDDER_REASON =
  'a bidder acts on the bid it owns under the tender owners tenant: the bidder is in the predicate (ADR-065 § 4)';

@Injectable()
export class BidRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Locks the tender row `FOR SHARE` (ADR-065 § 2): submissions share it, `close`
   * and `open-bids` take it `FOR UPDATE`, so a bid and the closing queue behind one
   * another and each order has one outcome. Judged by id alone — the bidder does not
   * know the owner — and the caller decides visibility from what comes back.
   */
  async lockTenderShared(
    tx: ExtendedPrismaClient,
    tenderId: string,
  ): Promise<LockedTenderForBid | null> {
    const rows = await runUnscoped(
      'a bidder takes the share lock of the tender it bids on, found by id (ADR-065 § 2)',
      () =>
        tx.$queryRaw<
          {
            id: string;
            organization_id: string;
            status: string;
            visibility: string | null;
            bid_opening_at: Date | null;
            bid_closing_at: Date | null;
          }[]
        >`
          SELECT "id", "organization_id", "status"::text AS "status", "visibility"::text AS "visibility",
                 "bid_opening_at", "bid_closing_at"
            FROM "tender"
           WHERE "id" = ${tenderId}
           FOR SHARE`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organization_id,
      status: row.status,
      visibility: row.visibility,
      bidOpeningAt: row.bid_opening_at,
      bidClosingAt: row.bid_closing_at,
    };
  }

  /** The tender row without a lock (a read: the audited view of one's own bid). */
  findTenderRow(tx: ExtendedPrismaClient, tenderId: string): Promise<Tender | null> {
    return runUnscoped('a bidder reads the tender row it asks about, found by id', () =>
      tx.tender.findFirst({ where: { id: tenderId } }),
    );
  }

  async isInvited(
    tx: ExtendedPrismaClient,
    ownerOrganizationId: string,
    tenderId: string,
    bidderOrganizationId: string,
  ): Promise<boolean> {
    const count = await runUnscoped(
      'a bidder asks whether it is invited: its own organization is in the predicate',
      () =>
        tx.tenderInvitation.count({
          where: {
            organizationId: ownerOrganizationId,
            tenderId,
            invitedOrganizationId: bidderOrganizationId,
          },
        }),
    );
    return count > 0;
  }

  /** The tender's current key: the public half seals, nothing else is read. */
  async findKey(
    tx: ExtendedPrismaClient,
    tenderId: string,
  ): Promise<{ keyId: string; publicKeyPem: string } | null> {
    const key = await runUnscoped('sealing a bid reads the tenders public key (ADR-066 § 2)', () =>
      tx.tenderKey.findFirst({
        where: { tenderId },
        select: { keyId: true, publicKeyPem: true },
      }),
    );
    return key;
  }

  /**
   * The tender's key row, wrapped (the private half is useless without the KEK): read when a
   * bidder reads its own bid after the opening, which unwraps it for that call only (ADR-066 § 2, § 4).
   */
  findWrappedKey(tx: ExtendedPrismaClient, tenderId: string): Promise<TenderKey | null> {
    return runUnscoped(
      'a bidder reads its own opened bid, which needs the tenders key (ADR-066 § 4)',
      () => tx.tenderKey.findFirst({ where: { tenderId } }),
    );
  }

  /** The decision on the bidder's own bid, if one was made. The bid id is the bidder's own. */
  findQualificationOf(
    tx: ExtendedPrismaClient,
    tenderId: string,
    ownBidId: string,
  ): Promise<BidQualification | null> {
    return runUnscoped('a bidder reads the decision on its own bid (ADR-066 § 4)', () =>
      tx.bidQualification.findFirst({ where: { tenderId, bidId: ownBidId } }),
    );
  }

  /**
   * What the evaluation of the bidder's own bid is made of: the claims on it, those who stood
   * down from it, and every revision of its cells. Only the bidder's own bid id is in any predicate.
   */
  async evaluationOf(
    tx: ExtendedPrismaClient,
    tenderId: string,
    ownBidId: string,
  ): Promise<{
    evaluations: BidEvaluation[];
    recusals: BidEvaluationRecusal[];
    scores: BidEvaluationScore[];
  }> {
    return runUnscoped('a bidder reads the evaluation of its own bid (ADR-066 § 4)', async () => ({
      evaluations: await tx.bidEvaluation.findMany({ where: { tenderId, bidId: ownBidId } }),
      recusals: await tx.bidEvaluationRecusal.findMany({ where: { tenderId, bidId: ownBidId } }),
      scores: await tx.bidEvaluationScore.findMany({ where: { tenderId, bidId: ownBidId } }),
    }));
  }

  listCriteria(tx: ExtendedPrismaClient, tenderId: string): Promise<TenderCriterion[]> {
    return runUnscoped('a bidder reads the frozen criteria of the tender it bids on', () =>
      tx.tenderCriterion.findMany({ where: { tenderId }, orderBy: { position: 'asc' } }),
    );
  }

  // -- the bid ------------------------------------------------------------------

  findBidOf(
    tx: ExtendedPrismaClient,
    tenderId: string,
    bidderOrganizationId: string,
  ): Promise<Bid | null> {
    return runUnscoped(BIDDER_REASON, () =>
      tx.bid.findFirst({ where: { tenderId, bidderOrganizationId } }),
    );
  }

  async insertBid(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      tenderId: string;
      bidderOrganizationId: string;
      sealed: SealedBid;
      actor: string;
      at: Date;
    },
  ): Promise<void> {
    await runUnscoped(BIDDER_REASON, () =>
      tx.bid.create({
        data: {
          id: input.id,
          organizationId: input.organizationId,
          tenderId: input.tenderId,
          bidderOrganizationId: input.bidderOrganizationId,
          status: 'SUBMITTED',
          revision: 1,
          ...sealedColumns(input.sealed),
          submittedAt: input.at,
          receivedAt: input.at,
          submittedBy: input.actor,
          updatedAt: input.at,
          updatedBy: input.actor,
        },
      }),
    );
  }

  /** Locks the bidder's own bid `FOR UPDATE`. Another bidder's bid is not found. */
  async lockBid(
    tx: ExtendedPrismaClient,
    tenderId: string,
    bidId: string,
    bidderOrganizationId: string,
  ): Promise<LockedBid | null> {
    const rows = await runUnscoped(
      BIDDER_REASON,
      () =>
        tx.$queryRaw<
          {
            id: string;
            organization_id: string;
            tender_id: string;
            bidder_organization_id: string;
            status: string;
            revision: number;
          }[]
        >`
        SELECT "id", "organization_id", "tender_id", "bidder_organization_id",
               "status"::text AS "status", "revision"
          FROM "bid"
         WHERE "id" = ${bidId} AND "tender_id" = ${tenderId}
           AND "bidder_organization_id" = ${bidderOrganizationId}
         FOR UPDATE`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organization_id,
      tenderId: row.tender_id,
      bidderOrganizationId: row.bidder_organization_id,
      status: row.status,
      revision: row.revision,
    };
  }

  /** Replaces the seal with the next revision. Compare-and-set on the revision; returns 0 or 1. */
  async replaceSeal(
    tx: ExtendedPrismaClient,
    input: {
      bidId: string;
      bidderOrganizationId: string;
      expectedRevision: number;
      sealed: SealedBid;
      actor: string;
      at: Date;
    },
  ): Promise<number> {
    const result = await runUnscoped(BIDDER_REASON, () =>
      tx.bid.updateMany({
        where: {
          id: input.bidId,
          bidderOrganizationId: input.bidderOrganizationId,
          status: 'SUBMITTED',
          revision: input.expectedRevision,
        },
        data: {
          revision: input.expectedRevision + 1,
          ...sealedColumns(input.sealed),
          receivedAt: input.at,
          updatedAt: input.at,
          updatedBy: input.actor,
        },
      }),
    );
    return result.count;
  }

  /** SUBMITTED to WITHDRAWN, compare-and-set on the revision; returns 0 or 1. */
  async withdraw(
    tx: ExtendedPrismaClient,
    input: {
      bidId: string;
      bidderOrganizationId: string;
      expectedRevision: number;
      actor: string;
      at: Date;
    },
  ): Promise<number> {
    const result = await runUnscoped(BIDDER_REASON, () =>
      tx.bid.updateMany({
        where: {
          id: input.bidId,
          bidderOrganizationId: input.bidderOrganizationId,
          status: 'SUBMITTED',
          revision: input.expectedRevision,
        },
        data: {
          status: 'WITHDRAWN',
          withdrawnAt: input.at,
          updatedAt: input.at,
          updatedBy: input.actor,
        },
      }),
    );
    return result.count;
  }

  // -- the receipt chain ----------------------------------------------------------

  /**
   * The next place in a tender's chain. A transaction-scoped advisory lock keyed by
   * the tender serialises every append (the tender row is only shared among
   * bidders), and the previous link is read after it is held, so two bids can
   * never take the same place or the same predecessor. Released at commit.
   */
  async nextReceiptSlot(tx: ExtendedPrismaClient, tenderId: string): Promise<ReceiptSlot> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`bid_receipt:${tenderId}`}, 0))`;
    const last = await runUnscoped(
      'appending to the tenders receipt chain reads its newest link',
      () =>
        tx.bidReceipt.findFirst({
          where: { tenderId },
          orderBy: { seq: 'desc' },
          select: { seq: true, receipt: true },
        }),
    );
    return { seq: (last?.seq ?? 0) + 1, previousReceipt: last?.receipt ?? null };
  }

  /** The receipt issued for one revision of a bid, or null. */
  async receiptOf(
    tx: ExtendedPrismaClient,
    tenderId: string,
    bidId: string,
    revision: number,
  ): Promise<string | null> {
    const link = await runUnscoped('a bidder reads the receipt issued for its own bid', () =>
      tx.bidReceipt.findFirst({
        where: { tenderId, bidId, revision },
        select: { receipt: true },
      }),
    );
    return link?.receipt ?? null;
  }

  async insertReceipt(
    tx: ExtendedPrismaClient,
    input: {
      tenderId: string;
      organizationId: string;
      seq: number;
      bidId: string;
      revision: number;
      receivedAt: Date;
      ciphertextSha256: string;
      contentCommitment: string;
      previousReceipt: string;
      receipt: string;
      eligibleAsOf: Date;
    },
  ): Promise<void> {
    await runUnscoped('a submission appends one link to the tenders receipt chain', () =>
      tx.bidReceipt.create({ data: input }),
    );
  }

  // -- the access log -----------------------------------------------------------------

  async insertAccess(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      tenderId: string;
      bidId: string | null;
      accessorOrganizationId: string;
      accessorUserId: string;
      purpose: string;
      outcome: 'GRANTED' | 'REFUSED';
      refusalCode: string | null;
      at: Date;
    },
  ): Promise<void> {
    await runUnscoped(
      'every read of a bid is logged under the tender owners tenant (ADR-066 § 5)',
      () =>
        tx.bidAccessLog.create({
          data: {
            id: input.id,
            organizationId: input.organizationId,
            tenderId: input.tenderId,
            bidId: input.bidId,
            accessorOrganizationId: input.accessorOrganizationId,
            accessorUserId: input.accessorUserId,
            purpose: input.purpose,
            outcome: input.outcome,
            refusalCode: input.refusalCode,
            accessedAt: input.at,
          },
        }),
    );
  }

  // -- what a bidder may see ----------------------------------------------------------------

  /**
   * PUBLISHED tenders another organization owns that `bidderOrganizationId` may bid
   * on: public, or one it is invited to. The bidder's own organization is in the
   * predicate twice (excluded as owner, matched as invitee).
   */
  listOpenTenders(
    bidderOrganizationId: string,
    filter: { cursor?: string; limit: number },
  ): Promise<Tender[]> {
    return runUnscoped(
      'a bidder lists the tenders it may bid on: public, or invited, never its own',
      () =>
        this.prisma.client.tender.findMany({
          where: {
            status: 'PUBLISHED',
            organizationId: { not: bidderOrganizationId },
            OR: [
              { visibility: 'PUBLIC' },
              { invitations: { some: { invitedOrganizationId: bidderOrganizationId } } },
            ],
            ...(filter.cursor ? { id: { lt: filter.cursor } } : {}),
          },
          orderBy: { id: 'desc' },
          take: filter.limit + 1,
        }),
    );
  }

  findOpenTender(tenderId: string, bidderOrganizationId: string): Promise<Tender | null> {
    return runUnscoped('a bidder reads one tender it may bid on, or none', () =>
      this.prisma.client.tender.findFirst({
        where: {
          id: tenderId,
          status: 'PUBLISHED',
          organizationId: { not: bidderOrganizationId },
          OR: [
            { visibility: 'PUBLIC' },
            { invitations: { some: { invitedOrganizationId: bidderOrganizationId } } },
          ],
        },
      }),
    );
  }

  listCriteriaOf(tenderId: string): Promise<TenderCriterion[]> {
    return runUnscoped('a bidder reads the frozen criteria of a tender it may bid on', () =>
      this.prisma.client.tenderCriterion.findMany({
        where: { tenderId },
        orderBy: { position: 'asc' },
      }),
    );
  }
}

function sealedColumns(sealed: SealedBid) {
  return {
    sealVersion: sealed.version,
    keyId: sealed.keyId,
    // A copy into a plain `ArrayBuffer`: the client's byte columns do not take a
    // Buffer, whose backing store may be shared.
    nonce: new Uint8Array(sealed.nonce),
    ciphertext: new Uint8Array(sealed.ciphertext),
    tag: new Uint8Array(sealed.tag),
    wrappedContentKey: new Uint8Array(sealed.wrappedContentKey),
    contentCommitment: sealed.contentCommitment,
    ciphertextSha256: sealed.ciphertextSha256,
  };
}
