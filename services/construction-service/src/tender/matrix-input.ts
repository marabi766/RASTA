import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import type { BidSummary, EvaluationRepository } from './evaluation.repository';
import type { MatrixInput } from './evaluation-matrix';

/** The tender, as far as the matrix is concerned. */
export interface MatrixTender {
  id: string;
  status: string;
  evaluatedAt: Date | null;
}

/**
 * Everything the matrix is made of, read in the caller's transaction: the one reading evaluation
 * (`evaluate`, the matrix read) and the award share, so the award ranks the very rows the
 * evaluation froze and pins the very digest `BIDS_EVALUATED` carried.
 */
export async function readMatrixInput(
  repo: EvaluationRepository,
  tx: ExtendedPrismaClient,
  tender: MatrixTender,
  bids: readonly BidSummary[],
  limits: { minEvaluators: number; maxEvaluators: number },
): Promise<MatrixInput> {
  const [criteria, qualifications, evaluations, recusals, scores] = await Promise.all([
    repo.listCriteria(tx, tender.id),
    repo.listQualifications(tx, tender.id),
    repo.listEvaluations(tx, tender.id),
    repo.listRecusals(tx, tender.id),
    repo.listScores(tx, tender.id),
  ]);
  return {
    tenderId: tender.id,
    status: tender.status,
    frozen: tender.evaluatedAt !== null,
    criteria,
    bids,
    qualifications: qualifications.map((row) => ({
      bidId: row.bidId,
      decision: row.decision,
      reasonCode: row.reasonCode,
      reasonText: row.reasonText,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt,
    })),
    evaluations,
    recusals,
    scores,
    minEvaluators: limits.minEvaluators,
    maxEvaluators: limits.maxEvaluators,
  };
}
