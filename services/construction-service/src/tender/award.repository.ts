import { Injectable } from '@nestjs/common';
import type { TenderAward } from '../generated/prisma';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';

/** The workflow whose active approval policy would gate an award (Q-84); none can be written yet (PR 11). */
export const AWARD_WORKFLOW_KEY = 'tender.award';

/**
 * What awarding a tender reads and writes (ADR-067 § 3).
 *
 * The **owner's** side: every statement runs in the tender owner's tenant through the ordinary
 * guard. The lock on the tender, the bids and the matrix are `EvaluationRepository`'s; the sealed
 * bid is `BidRepository`'s. Nothing here updates a row but the tender's status and the bids'
 * (both compare-and-set, in the lock the caller holds); the award itself is append-only, and the
 * database accepts it only for an EVALUATED tender and a QUALIFIED bid of it.
 */
@Injectable()
export class AwardRepository {
  findAward(tx: ExtendedPrismaClient, tenderId: string): Promise<TenderAward | null> {
    return tx.tenderAward.findFirst({ where: { tenderId } });
  }

  /** Whether the organization in context has an ACTIVE `tender.award` approval policy (Q-84). Only ACTIVE counts. */
  async hasActiveAwardPolicy(tx: ExtendedPrismaClient): Promise<boolean> {
    const count = await tx.approvalPolicy.count({
      where: { workflowKey: AWARD_WORKFLOW_KEY, status: 'ACTIVE' },
    });
    return count > 0;
  }

  async insertAward(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      tenderId: string;
      bidId: string;
      bidderOrganizationId: string;
      amountMinor: bigint;
      rank: number;
      tied: boolean;
      matrixDigest: string;
      justification: string | null;
      standingAsOf: Date;
      actor: string;
      actorIssuer: string | null;
      actorSubject: string | null;
      at: Date;
    },
  ): Promise<void> {
    await tx.tenderAward.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        tenderId: input.tenderId,
        bidId: input.bidId,
        bidderOrganizationId: input.bidderOrganizationId,
        amountMinor: input.amountMinor,
        rank: input.rank,
        tied: input.tied,
        matrixDigest: input.matrixDigest,
        justification: input.justification,
        standingAsOf: input.standingAsOf,
        awardedAt: input.at,
        awardedBy: input.actor,
        awardedByIssuer: input.actorIssuer,
        awardedBySubject: input.actorSubject,
      },
    });
  }

  /**
   * EVALUATED → AWARDED: compare-and-set on status and version, who and when. Returns the rows
   * matched: 0 or 1. The database lets it through only with the award recorded.
   */
  async markTenderAwarded(
    tx: ExtendedPrismaClient,
    input: { tenderId: string; expectedVersion: number; actor: string; at: Date },
  ): Promise<number> {
    const result = await tx.tender.updateMany({
      where: { id: input.tenderId, status: 'EVALUATED', version: input.expectedVersion },
      data: {
        status: 'AWARDED',
        statusChangedAt: input.at,
        statusChangedBy: input.actor,
        updatedAt: input.at,
        updatedBy: input.actor,
        version: { increment: 1 },
      },
    });
    return result.count;
  }

  /** QUALIFIED → AWARDED for the winning bid, compare-and-set on the status. Returns the rows matched: 0 or 1. */
  async markBidAwarded(
    tx: ExtendedPrismaClient,
    input: { bidId: string; actor: string; at: Date },
  ): Promise<number> {
    const result = await tx.bid.updateMany({
      where: { id: input.bidId, status: 'QUALIFIED' },
      data: { status: 'AWARDED', updatedAt: input.at, updatedBy: input.actor },
    });
    return result.count;
  }

  /**
   * QUALIFIED → NOT_AWARDED for every other qualified bid of the tender, and which they were (for
   * the event each is told by), in a stable order. Disqualified and withdrawn bids stay as they are.
   */
  async markOthersNotAwarded(
    tx: ExtendedPrismaClient,
    input: { tenderId: string; winnerBidId: string; actor: string; at: Date },
  ): Promise<{ id: string; bidderOrganizationId: string }[]> {
    const losers = await tx.bid.findMany({
      where: { tenderId: input.tenderId, status: 'QUALIFIED', id: { not: input.winnerBidId } },
      orderBy: { id: 'asc' },
      select: { id: true, bidderOrganizationId: true },
    });
    if (losers.length === 0) return [];
    const result = await tx.bid.updateMany({
      where: { id: { in: losers.map((bid) => bid.id) }, status: 'QUALIFIED' },
      data: { status: 'NOT_AWARDED', updatedAt: input.at, updatedBy: input.actor },
    });
    if (result.count !== losers.length) {
      // Cannot happen under the tender lock; if it does, nothing of the award may commit.
      throw new Error('a qualified bid changed state while the tender was locked for its award');
    }
    return losers;
  }
}
