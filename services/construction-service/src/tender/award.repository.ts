import { Injectable } from '@nestjs/common';
import type { ActorIdentity } from '@rasta/nest-common';
import type { TenderAward } from '../generated/prisma';
import { storedActor } from '../shared/stable-actor';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';

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

  /**
   * Everyone on record as having taken part in the evaluation of the tender's bids — who decided on
   * one, who claimed one, who stood down from one — each with the stable identity the row recorded
   * (#188): the people `AWARDER_NOT_EVALUATOR` compares the awarder with.
   */
  async listParticipants(tx: ExtendedPrismaClient, tenderId: string): Promise<ActorIdentity[]> {
    const [decisions, claims, recusals] = await Promise.all([
      tx.bidQualification.findMany({
        where: { tenderId },
        select: { decidedBy: true, decidedByIssuer: true, decidedBySubject: true },
      }),
      tx.bidEvaluation.findMany({
        where: { tenderId },
        select: { evaluatorId: true, evaluatorIssuer: true, evaluatorSubject: true },
      }),
      tx.bidEvaluationRecusal.findMany({
        where: { tenderId },
        select: { evaluatorId: true, evaluatorIssuer: true, evaluatorSubject: true },
      }),
    ]);
    return [
      ...decisions.map((row) =>
        storedActor(row.decidedBy, row.decidedByIssuer, row.decidedBySubject),
      ),
      ...[...claims, ...recusals].map((row) =>
        storedActor(row.evaluatorId, row.evaluatorIssuer, row.evaluatorSubject),
      ),
    ];
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
   * The standing check that follows the award, PENDING and untried, in the award's own transaction
   * (ADR-067 § 3, residual). `windowStart` is the instant of the standing read the award was made on.
   * The database accepts it only as the check of the award the tender holds.
   */
  async insertStandingCheck(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      tenderId: string;
      projectId: string;
      bidId: string;
      winnerOrganizationId: string;
      awardedBy: string;
      awardedAt: Date;
      windowStart: Date;
      at: Date;
    },
  ): Promise<void> {
    await tx.tenderAwardStandingCheck.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        tenderId: input.tenderId,
        projectId: input.projectId,
        bidId: input.bidId,
        winnerOrganizationId: input.winnerOrganizationId,
        awardedBy: input.awardedBy,
        awardedAt: input.awardedAt,
        windowStart: input.windowStart,
        createdAt: input.at,
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
