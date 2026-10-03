import { createHash } from 'node:crypto';
import { SCORE_SCALE, type DisqualificationReason, type MatrixView } from './evaluation.dto';

/**
 * The evaluation matrix and its arithmetic (ADR-067 § 2), as pure functions over rows.
 *
 * ## Integers only
 *
 * A score is the points × 100 (`scoreScaled`, an integer); a criterion's weight is basis points
 * (an integer); an evaluator's total is `Σ weightBp × scoreScaled` — a **bigint**, never a float
 * (AGENTS.md § 3), so nothing is divided and no rounding rule exists to be argued about: only a
 * display divides. A tender with 50 criteria of 10 000 bp and 100 000 000 scaled points per
 * criterion stays far inside a bigint and is shown as a string.
 *
 * ## One matrix, from the latest revisions
 *
 * Scores are appended, never edited (a revision is a new row); the matrix is the **latest
 * revision of each cell**, and every revision stays in the database. An evaluator's evaluation
 * of a bid is *complete* when every criterion of the tender has a cell; an incomplete one, and
 * one by an evaluator who stood down from the bid, is not counted.
 *
 * ## Several evaluators (Q-88, Q-92: provisional, off by default)
 *
 * With one evaluator per bid (the default) a bid's score is that evaluator's total. With more,
 * the bid's `totalScaled` is the **sum** of its complete evaluators' totals and bids are
 * compared by the **mean** — exactly: `sumA × countB` against `sumB × countA`, in bigints, so
 * bids with different numbers of evaluators still compare and nothing is rounded.
 *
 * ## Ranking
 *
 * A rank is `1 + the number of bids strictly better`; equal bids share it. The system ranks and
 * shows; **a tie makes no winner and the first rank is not an award** (ADR-067 § 3).
 */

export interface MatrixCriterion {
  code: string;
  label: string;
  weightBp: number;
  scoringMethod: string;
  maxScore: number;
  position: number;
}

export interface MatrixBid {
  id: string;
  bidderOrganizationId: string;
  status: string;
}

export interface MatrixQualification {
  bidId: string;
  decision: 'QUALIFIED' | 'DISQUALIFIED';
  reasonCode: string | null;
  reasonText: string | null;
  decidedBy: string;
  decidedAt: Date;
}

export interface MatrixEvaluation {
  id: string;
  bidId: string;
  evaluatorId: string;
}

export interface MatrixRecusal {
  bidId: string;
  evaluatorId: string;
  reasonCode: string;
  recusedAt: Date;
}

export interface MatrixScore {
  evaluationId: string;
  criterionCode: string;
  revision: number;
  scoreScaled: number;
  scoredAt: Date;
}

export interface MatrixInput {
  tenderId: string;
  status: string;
  frozen: boolean;
  criteria: readonly MatrixCriterion[];
  bids: readonly MatrixBid[];
  qualifications: readonly MatrixQualification[];
  evaluations: readonly MatrixEvaluation[];
  recusals: readonly MatrixRecusal[];
  scores: readonly MatrixScore[];
  minEvaluators: number;
  maxEvaluators: number;
}

/** The most one evaluator can give: Σ weightBp × maxScore × 100. */
export function maxTotalScaled(criteria: readonly MatrixCriterion[]): bigint {
  return criteria.reduce(
    (sum, criterion) =>
      sum + BigInt(criterion.weightBp) * BigInt(criterion.maxScore) * BigInt(SCORE_SCALE),
    0n,
  );
}

/** `Σ weightBp × scoreScaled`, or null while any criterion has no score. */
export function weightedTotal(
  criteria: readonly Pick<MatrixCriterion, 'code' | 'weightBp'>[],
  cells: ReadonlyMap<string, number>,
): bigint | null {
  let total = 0n;
  for (const criterion of criteria) {
    const scaled = cells.get(criterion.code);
    if (scaled === undefined) return null;
    total += BigInt(criterion.weightBp) * BigInt(scaled);
  }
  return total;
}

/** Whether `a` (sum over `na` evaluators) is strictly better than `b`: compared as means, exactly. */
function better(a: { sum: bigint; count: number }, b: { sum: bigint; count: number }): boolean {
  return a.sum * BigInt(b.count) > b.sum * BigInt(a.count);
}

/** Competition ranking: `1 + the number strictly better`; equal entries share a rank and are `tied`. */
export function rankEntries<T extends { sum: bigint; count: number }>(
  entries: readonly T[],
): (T & { rank: number; tied: boolean })[] {
  return entries.map((entry) => {
    const rank = 1 + entries.filter((other) => other !== entry && better(other, entry)).length;
    const tied = entries.some(
      (other) => other !== entry && !better(other, entry) && !better(entry, other),
    );
    return { ...entry, rank, tied };
  });
}

const iso = (date: Date): string => date.toISOString();

export function buildMatrix(input: MatrixInput): MatrixView {
  const criteria = [...input.criteria].sort((a, b) => a.position - b.position);
  const maxTotal = maxTotalScaled(criteria);

  const latest = new Map<string, Map<string, MatrixScore>>();
  for (const score of input.scores) {
    const cells = latest.get(score.evaluationId) ?? new Map<string, MatrixScore>();
    const current = cells.get(score.criterionCode);
    if (!current || current.revision < score.revision) cells.set(score.criterionCode, score);
    latest.set(score.evaluationId, cells);
  }

  const qualificationOf = new Map(input.qualifications.map((q) => [q.bidId, q]));
  const stoodDown = (bidId: string, evaluatorId: string): boolean =>
    input.recusals.some((r) => r.bidId === bidId && r.evaluatorId === evaluatorId);

  const bids = [...input.bids]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((bid) => {
      const qualification = qualificationOf.get(bid.id) ?? null;
      const evaluations = input.evaluations
        .filter((evaluation) => evaluation.bidId === bid.id)
        .sort((a, b) => (a.evaluatorId < b.evaluatorId ? -1 : 1))
        .map((evaluation) => {
          const cells = latest.get(evaluation.id) ?? new Map<string, MatrixScore>();
          const total = weightedTotal(
            criteria,
            new Map([...cells].map(([code, score]) => [code, score.scoreScaled])),
          );
          return {
            evaluatorId: evaluation.evaluatorId,
            standingDown: stoodDown(bid.id, evaluation.evaluatorId),
            total,
            view: {
              evaluatorId: evaluation.evaluatorId,
              complete: total !== null,
              totalScaled: total === null ? null : total.toString(),
              cells: [...cells.values()]
                .sort((a, b) => (a.criterionCode < b.criterionCode ? -1 : 1))
                .map((score) => ({
                  criterionCode: score.criterionCode,
                  scoreScaled: score.scoreScaled,
                  revision: score.revision,
                  scoredAt: iso(score.scoredAt),
                })),
            },
          };
        });
      const counted = evaluations.filter((e) => !e.standingDown && e.total !== null);
      const qualified = qualification?.decision === 'QUALIFIED';
      const sum = counted.reduce((acc, e) => acc + (e.total ?? 0n), 0n);
      return {
        bid,
        qualification,
        evaluations,
        counted: counted.length,
        sum,
        qualified,
        recusals: input.recusals
          .filter((r) => r.bidId === bid.id)
          .sort((a, b) => (a.evaluatorId < b.evaluatorId ? -1 : 1)),
      };
    });

  const rankable = bids.filter((entry) => entry.qualified && entry.counted > 0);
  const ranked = new Map(
    rankEntries(
      rankable.map((entry) => ({ id: entry.bid.id, sum: entry.sum, count: entry.counted })),
    ).map((r) => [r.id, r] as const),
  );

  const qualifiedBids = bids.filter((entry) => entry.qualified);
  // An opened bid nobody has decided on: the evaluation is not complete while one remains.
  const undecidedBidCount = bids.filter((entry) => entry.bid.status === 'OPENED').length;
  const blockers = qualifiedBids
    .filter((entry) => entry.counted < input.minEvaluators)
    .map((entry) => ({
      bidId: entry.bid.id,
      completeEvaluators: entry.counted,
      required: input.minEvaluators,
    }));

  return {
    tenderId: input.tenderId,
    status: input.status,
    frozen: input.frozen,
    criteria: criteria.map((criterion) => ({
      code: criterion.code,
      label: criterion.label,
      weightBp: criterion.weightBp,
      scoringMethod: criterion.scoringMethod,
      maxScore: criterion.maxScore,
    })),
    maxTotalScaled: maxTotal.toString(),
    minEvaluators: input.minEvaluators,
    maxEvaluators: input.maxEvaluators,
    ready: qualifiedBids.length > 0 && blockers.length === 0 && undecidedBidCount === 0,
    undecidedBidCount,
    blockers,
    bids: bids.map((entry) => {
      const rank = ranked.get(entry.bid.id);
      return {
        bidId: entry.bid.id,
        bidderOrganizationId: entry.bid.bidderOrganizationId,
        bidStatus: entry.bid.status,
        qualification: entry.qualification
          ? {
              decision: entry.qualification.decision,
              reasonCode: entry.qualification.reasonCode as DisqualificationReason | null,
              reasonText: entry.qualification.reasonText,
              decidedBy: entry.qualification.decidedBy,
              decidedAt: iso(entry.qualification.decidedAt),
            }
          : null,
        evaluations: entry.evaluations.map((e) => e.view),
        recusals: entry.recusals.map((r) => ({
          evaluatorId: r.evaluatorId,
          reasonCode: r.reasonCode as 'CONFLICT_OF_INTEREST' | 'OTHER',
          recusedAt: iso(r.recusedAt),
        })),
        evaluatorCount: entry.counted,
        totalScaled: rank ? entry.sum.toString() : null,
        rank: rank?.rank ?? null,
        tied: rank?.tied ?? false,
      };
    }),
  };
}

/**
 * SHA-256 (hex) of what the matrix is made of — every decision, every stand-down and every
 * revision of every cell, one canonical line each, sorted — so `BIDS_EVALUATED` can pin the matrix
 * that was frozen and a later read can show it did not change. Ids and integers only.
 */
export function matrixDigest(
  input: Pick<MatrixInput, 'qualifications' | 'evaluations' | 'recusals' | 'scores'>,
): string {
  const evaluatorOf = new Map(input.evaluations.map((e) => [e.id, e]));
  const lines = [
    ...input.qualifications.map((q) => `Q|${q.bidId}|${q.decision}|${q.reasonCode ?? ''}`),
    ...input.recusals.map((r) => `R|${r.bidId}|${r.evaluatorId}|${r.reasonCode}`),
    ...input.scores.map((s) => {
      const evaluation = evaluatorOf.get(s.evaluationId);
      return `S|${evaluation?.bidId ?? ''}|${evaluation?.evaluatorId ?? ''}|${s.criterionCode}|${s.revision}|${s.scoreScaled}`;
    }),
  ].sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}
