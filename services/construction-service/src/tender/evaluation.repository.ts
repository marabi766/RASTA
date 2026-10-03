import { Injectable } from '@nestjs/common';
import type {
  BidEvaluation,
  BidEvaluationRecusal,
  BidEvaluationScore,
  BidQualification,
  TenderCriterion,
} from '../generated/prisma';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import type { StoredIdentity } from '../shared/stable-actor';
import type { TenderStateName } from './tender.state-machine';

/**
 * What evaluating a tender's opened bids reads and writes (ADR-067 § 2).
 *
 * This is the **owner's** side: every statement runs in the tender owner's tenant through the
 * ordinary guard, and the raw locks name the organization in their predicate. The tender is
 * found by id alone, for the refusal log, by `TenderOpenRepository.findOwnership` (a reasoned
 * `runUnscoped`); the contractor's reads of its own evaluation are `OwnBidRepository`'s.
 * Every table here is append-only and refuses a write once the tender is not EVALUATING (the
 * database says so too); nothing here updates a row but the bid's status and the tender's.
 */

/** The tender row under the evaluation lock: enough to decide, nothing more. */
export interface TenderForEvaluation {
  id: string;
  organizationId: string;
  projectId: string;
  status: TenderStateName;
  version: number;
  openedAt: Date | null;
  evaluatedAt: Date | null;
  evaluatedBy: string | null;
  createdBy: string;
  publishedBy: string | null;
  /**
   * The stable identities (#188) beside `evaluatedBy`, `createdBy` and `publishedBy`: both or
   * neither of each pair; NULL on a tender written before they were recorded (unknown).
   */
  evaluatedByIssuer: string | null;
  evaluatedBySubject: string | null;
  createdByIssuer: string | null;
  createdBySubject: string | null;
  publishedByIssuer: string | null;
  publishedBySubject: string | null;
}

interface LockRow {
  id: string;
  organization_id: string;
  project_id: string;
  status: TenderStateName;
  version: number;
  opened_at: Date | null;
  evaluated_at: Date | null;
  evaluated_by: string | null;
  created_by: string;
  published_by: string | null;
  evaluated_by_issuer: string | null;
  evaluated_by_subject: string | null;
  created_by_issuer: string | null;
  created_by_subject: string | null;
  published_by_issuer: string | null;
  published_by_subject: string | null;
}

const toLocked = (row: LockRow): TenderForEvaluation => ({
  id: row.id,
  organizationId: row.organization_id,
  projectId: row.project_id,
  status: row.status,
  version: row.version,
  openedAt: row.opened_at,
  evaluatedAt: row.evaluated_at,
  evaluatedBy: row.evaluated_by,
  createdBy: row.created_by,
  publishedBy: row.published_by,
  evaluatedByIssuer: row.evaluated_by_issuer,
  evaluatedBySubject: row.evaluated_by_subject,
  createdByIssuer: row.created_by_issuer,
  createdBySubject: row.created_by_subject,
  publishedByIssuer: row.published_by_issuer,
  publishedBySubject: row.published_by_subject,
});

/** An evaluator of a bid as a row names them: the user id and the stable identity (#188). */
export interface BidEvaluatorRow {
  evaluatorId: string;
  evaluatorIssuer: string | null;
  evaluatorSubject: string | null;
}

/** A bid as evaluation needs it: who bid and how far it has got — never the sealed bytes. */
export interface BidSummary {
  id: string;
  bidderOrganizationId: string;
  status: string;
}

@Injectable()
export class EvaluationRepository {
  /**
   * Locks the tender row `FOR UPDATE` for the rest of the transaction — the lock `close`,
   * `open-bids` and every owner command take — so a decision, a score and the completion of
   * the evaluation queue behind one another and each order has one outcome.
   */
  async lockForEvaluation(
    tx: ExtendedPrismaClient,
    organizationId: string,
    tenderId: string,
  ): Promise<TenderForEvaluation | null> {
    const rows = await tx.$queryRaw<LockRow[]>`
      SELECT "id", "organization_id", "project_id", "status"::text AS "status", "version",
             "opened_at", "evaluated_at", "evaluated_by", "created_by", "published_by",
             "evaluated_by_issuer", "evaluated_by_subject", "created_by_issuer",
             "created_by_subject", "published_by_issuer", "published_by_subject"
        FROM "tender"
       WHERE "organization_id" = ${organizationId} AND "id" = ${tenderId}
       FOR UPDATE`;
    return rows[0] ? toLocked(rows[0]) : null;
  }

  /** The same row `FOR SHARE`, for reads: they see an evaluation whole or not at all, and do not queue behind each other. */
  async lockSharedForRead(
    tx: ExtendedPrismaClient,
    organizationId: string,
    tenderId: string,
  ): Promise<TenderForEvaluation | null> {
    const rows = await tx.$queryRaw<LockRow[]>`
      SELECT "id", "organization_id", "project_id", "status"::text AS "status", "version",
             "opened_at", "evaluated_at", "evaluated_by", "created_by", "published_by",
             "evaluated_by_issuer", "evaluated_by_subject", "created_by_issuer",
             "created_by_subject", "published_by_issuer", "published_by_subject"
        FROM "tender"
       WHERE "organization_id" = ${organizationId} AND "id" = ${tenderId}
       FOR SHARE`;
    return rows[0] ? toLocked(rows[0]) : null;
  }

  /** Every bid of the tender — withdrawn ones too — as a summary, in a stable order. */
  listBidSummaries(tx: ExtendedPrismaClient, tenderId: string): Promise<BidSummary[]> {
    return tx.bid.findMany({
      where: { tenderId },
      orderBy: { id: 'asc' },
      select: { id: true, bidderOrganizationId: true, status: true },
    });
  }

  async findBidSummary(
    tx: ExtendedPrismaClient,
    tenderId: string,
    bidId: string,
  ): Promise<BidSummary | null> {
    return tx.bid.findFirst({
      where: { tenderId, id: bidId },
      select: { id: true, bidderOrganizationId: true, status: true },
    });
  }

  /** The tender's frozen criteria, in order. */
  listCriteria(tx: ExtendedPrismaClient, tenderId: string): Promise<TenderCriterion[]> {
    return tx.tenderCriterion.findMany({ where: { tenderId }, orderBy: { position: 'asc' } });
  }

  // -- decisions ------------------------------------------------------------------------

  findQualification(
    tx: ExtendedPrismaClient,
    tenderId: string,
    bidId: string,
  ): Promise<BidQualification | null> {
    return tx.bidQualification.findFirst({ where: { tenderId, bidId } });
  }

  listQualifications(tx: ExtendedPrismaClient, tenderId: string): Promise<BidQualification[]> {
    return tx.bidQualification.findMany({ where: { tenderId }, orderBy: { bidId: 'asc' } });
  }

  async insertQualification(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      tenderId: string;
      bidId: string;
      decision: 'QUALIFIED' | 'DISQUALIFIED';
      reasonCode: string | null;
      reasonText: string | null;
      standingAsOf: Date | null;
      actor: string;
      /** The decider's stable identity (#188), both or neither. */
      identity: StoredIdentity;
      at: Date;
    },
  ): Promise<void> {
    await tx.bidQualification.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        tenderId: input.tenderId,
        bidId: input.bidId,
        decision: input.decision,
        reasonCode: input.reasonCode,
        reasonText: input.reasonText,
        standingAsOf: input.standingAsOf,
        decidedAt: input.at,
        decidedBy: input.actor,
        decidedByIssuer: input.identity.issuer,
        decidedBySubject: input.identity.subject,
      },
    });
  }

  /**
   * OPENED → QUALIFIED or DISQUALIFIED, compare-and-set on the status, in the lock the caller
   * holds (the database lets it through only for a recorded decision). Returns the rows matched: 0 or 1.
   */
  async decideBid(
    tx: ExtendedPrismaClient,
    input: { bidId: string; decision: 'QUALIFIED' | 'DISQUALIFIED'; actor: string; at: Date },
  ): Promise<number> {
    const result = await tx.bid.updateMany({
      where: { id: input.bidId, status: 'OPENED' },
      data: { status: input.decision, updatedAt: input.at, updatedBy: input.actor },
    });
    return result.count;
  }

  // -- standing down --------------------------------------------------------------------

  listRecusals(tx: ExtendedPrismaClient, tenderId: string): Promise<BidEvaluationRecusal[]> {
    return tx.bidEvaluationRecusal.findMany({ where: { tenderId }, orderBy: { id: 'asc' } });
  }

  findRecusal(
    tx: ExtendedPrismaClient,
    tenderId: string,
    bidId: string,
    evaluatorId: string,
  ): Promise<BidEvaluationRecusal | null> {
    return tx.bidEvaluationRecusal.findFirst({ where: { tenderId, bidId, evaluatorId } });
  }

  async insertRecusal(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      tenderId: string;
      bidId: string;
      evaluatorId: string;
      /** The evaluator's stable identity (#188), both or neither. */
      identity: StoredIdentity;
      reasonCode: string;
      at: Date;
    },
  ): Promise<void> {
    await tx.bidEvaluationRecusal.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        tenderId: input.tenderId,
        bidId: input.bidId,
        evaluatorId: input.evaluatorId,
        evaluatorIssuer: input.identity.issuer,
        evaluatorSubject: input.identity.subject,
        reasonCode: input.reasonCode,
        recusedAt: input.at,
      },
    });
  }

  // -- evaluations and scores -----------------------------------------------------------

  listEvaluations(tx: ExtendedPrismaClient, tenderId: string): Promise<BidEvaluation[]> {
    return tx.bidEvaluation.findMany({ where: { tenderId }, orderBy: { id: 'asc' } });
  }

  findEvaluation(
    tx: ExtendedPrismaClient,
    tenderId: string,
    bidId: string,
    evaluatorId: string,
  ): Promise<BidEvaluation | null> {
    return tx.bidEvaluation.findFirst({ where: { tenderId, bidId, evaluatorId } });
  }

  /**
   * Everyone on record as an evaluator of one bid — who claimed it and who stood down from it —
   * with their stable identity (#188), so that one person under two user ids is found.
   */
  async listBidEvaluators(
    tx: ExtendedPrismaClient,
    tenderId: string,
    bidId: string,
  ): Promise<{ evaluations: BidEvaluatorRow[]; recusals: BidEvaluatorRow[] }> {
    const select = { evaluatorId: true, evaluatorIssuer: true, evaluatorSubject: true } as const;
    const [evaluations, recusals] = await Promise.all([
      tx.bidEvaluation.findMany({ where: { tenderId, bidId }, select, orderBy: { id: 'asc' } }),
      tx.bidEvaluationRecusal.findMany({
        where: { tenderId, bidId },
        select,
        orderBy: { id: 'asc' },
      }),
    ]);
    return { evaluations, recusals };
  }

  /** The evaluators who hold a claim on the bid and have not stood down: how many may still be added. */
  async countActiveEvaluators(
    tx: ExtendedPrismaClient,
    tenderId: string,
    bidId: string,
  ): Promise<number> {
    const claims = await tx.bidEvaluation.findMany({
      where: { tenderId, bidId },
      select: { evaluatorId: true },
    });
    const recused = new Set(
      (
        await tx.bidEvaluationRecusal.findMany({
          where: { tenderId, bidId },
          select: { evaluatorId: true },
        })
      ).map((row) => row.evaluatorId),
    );
    return claims.filter((claim) => !recused.has(claim.evaluatorId)).length;
  }

  async insertEvaluation(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      tenderId: string;
      bidId: string;
      evaluatorId: string;
      /** The evaluator's stable identity (#188), both or neither. */
      identity: StoredIdentity;
      at: Date;
    },
  ): Promise<void> {
    await tx.bidEvaluation.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        tenderId: input.tenderId,
        bidId: input.bidId,
        evaluatorId: input.evaluatorId,
        evaluatorIssuer: input.identity.issuer,
        evaluatorSubject: input.identity.subject,
        createdAt: input.at,
      },
    });
  }

  /** Every revision of every cell of the tender, oldest first. */
  listScores(tx: ExtendedPrismaClient, tenderId: string): Promise<BidEvaluationScore[]> {
    return tx.bidEvaluationScore.findMany({
      where: { tenderId },
      orderBy: [{ evaluationId: 'asc' }, { criterionCode: 'asc' }, { revision: 'asc' }],
    });
  }

  /** Every revision of one evaluation's cells. */
  listScoresOf(tx: ExtendedPrismaClient, evaluationId: string): Promise<BidEvaluationScore[]> {
    return tx.bidEvaluationScore.findMany({
      where: { evaluationId },
      orderBy: [{ criterionCode: 'asc' }, { revision: 'asc' }],
    });
  }

  async insertScore(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      tenderId: string;
      bidId: string;
      evaluationId: string;
      evaluatorId: string;
      criterionCode: string;
      revision: number;
      scoreScaled: number;
      at: Date;
    },
  ): Promise<void> {
    await tx.bidEvaluationScore.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        tenderId: input.tenderId,
        bidId: input.bidId,
        evaluationId: input.evaluationId,
        evaluatorId: input.evaluatorId,
        criterionCode: input.criterionCode,
        revision: input.revision,
        scoreScaled: input.scoreScaled,
        scoredAt: input.at,
      },
    });
  }

  // -- completing ----------------------------------------------------------------------

  /**
   * EVALUATING → EVALUATED: compare-and-set on status and version, who and when. Returns the
   * rows matched: 0 or 1.
   */
  async completeEvaluation(
    tx: ExtendedPrismaClient,
    input: {
      tenderId: string;
      expectedVersion: number;
      actor: string;
      /** The completer's stable identity (#188), both or neither. */
      identity: StoredIdentity;
      at: Date;
    },
  ): Promise<number> {
    const result = await tx.tender.updateMany({
      where: { id: input.tenderId, status: 'EVALUATING', version: input.expectedVersion },
      data: {
        status: 'EVALUATED',
        evaluatedAt: input.at,
        evaluatedBy: input.actor,
        evaluatedByIssuer: input.identity.issuer,
        evaluatedBySubject: input.identity.subject,
        statusChangedAt: input.at,
        statusChangedBy: input.actor,
        updatedAt: input.at,
        updatedBy: input.actor,
        version: { increment: 1 },
      },
    });
    return result.count;
  }
}
