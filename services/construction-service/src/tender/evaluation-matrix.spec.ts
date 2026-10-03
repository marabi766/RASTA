import {
  buildMatrix,
  matrixDigest,
  maxTotalScaled,
  rankEntries,
  weightedTotal,
  type MatrixCriterion,
  type MatrixInput,
} from './evaluation-matrix';

/**
 * The evaluation arithmetic (ADR-067 § 2): integers only, nothing divided, nothing rounded; the
 * matrix is the latest revision of each cell; ranking is exact and a tie shares a rank.
 */

const AT = new Date('2026-10-02T09:00:00.000Z');

const criterion = (
  code: string,
  weightBp: number,
  maxScore: number,
  position: number,
  scoringMethod = 'MANUAL_SCORE',
): MatrixCriterion => ({ code, label: code, weightBp, scoringMethod, maxScore, position });

/** The input with its lists open, so a test can add a row. */
type Open<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? U[] : T[K] };

const CRITERIA = [criterion('PRICE', 6000, 100, 1), criterion('LICENCE', 4000, 1, 2, 'PASS_FAIL')];

describe('the weighted total', () => {
  it('is Σ weightBp × scoreScaled, an integer', () => {
    expect(
      weightedTotal(
        CRITERIA,
        new Map([
          ['PRICE', 8_550],
          ['LICENCE', 100],
        ]),
      ),
    ).toBe(6000n * 8_550n + 4000n * 100n);
  });

  it('is null while any criterion has no score', () => {
    expect(weightedTotal(CRITERIA, new Map([['PRICE', 8_550]]))).toBeNull();
    expect(weightedTotal(CRITERIA, new Map())).toBeNull();
  });

  it('is exact beyond 2^53, where a float would round', () => {
    const big = [criterion('A', 10_000, 1_000_000, 1)];
    const total = weightedTotal(big, new Map([['A', 99_999_999]]));
    expect(total).toBe(10_000n * 99_999_999n);
    expect(10_000 * 99_999_999).toBeLessThan(Number.MAX_SAFE_INTEGER); // one criterion still fits…
    // …fifty do not: the total of the largest legal tender is a bigint and is shown as a string.
    const fifty = Array.from({ length: 50 }, (_, i) => criterion(`C${i}`, 200, 1_000_000, i + 1));
    const cells = new Map(fifty.map((c) => [c.code, 100_000_000]));
    const full = weightedTotal(fifty, cells)!;
    expect(full).toBe(50n * 200n * 100_000_000n);
    expect(maxTotalScaled(fifty)).toBe(full);
    // 2^53 + 1 is the first integer a float cannot hold: prove a bigint can tell it from its neighbours.
    const edge = [criterion('E', 1, 1_000_000, 1)];
    expect(weightedTotal(edge, new Map([['E', 2 ** 53 - 1]]))! + 2n).toBe(2n ** 53n + 1n);
  });

  it('has a maximum of Σ weightBp × maxScore × 100', () => {
    expect(maxTotalScaled(CRITERIA)).toBe(6000n * 100n * 100n + 4000n * 1n * 100n);
  });
});

describe('ranking', () => {
  const entry = (id: string, sum: bigint, count = 1) => ({ id, sum, count });

  it('ranks by total, highest first', () => {
    const ranked = rankEntries([entry('a', 10n), entry('b', 30n), entry('c', 20n)]);
    expect(ranked.map((r) => [r.id, r.rank, r.tied])).toEqual([
      ['a', 3, false],
      ['b', 1, false],
      ['c', 2, false],
    ]);
  });

  it('shares a rank among equal totals and skips the next: a tie makes no winner', () => {
    const ranked = rankEntries([entry('a', 30n), entry('b', 30n), entry('c', 10n)]);
    expect(ranked.map((r) => [r.id, r.rank, r.tied])).toEqual([
      ['a', 1, true],
      ['b', 1, true],
      ['c', 3, false],
    ]);
  });

  it('compares means exactly when bids have different numbers of evaluators, with no rounding', () => {
    // 7 / 2 = 3.5 against 10 / 3 = 3.333…: the first is better, and no division was needed.
    const ranked = rankEntries([entry('two', 7n, 2), entry('three', 10n, 3)]);
    expect(ranked.map((r) => [r.id, r.rank])).toEqual([
      ['two', 1],
      ['three', 2],
    ]);
    // 6 / 2 = 3 against 9 / 3 = 3: equal.
    expect(
      rankEntries([entry('two', 6n, 2), entry('three', 9n, 3)]).map((r) => [r.rank, r.tied]),
    ).toEqual([
      [1, true],
      [1, true],
    ]);
  });

  it('ranks a single bid first, untied', () => {
    expect(rankEntries([entry('only', 5n)])).toEqual([
      { id: 'only', sum: 5n, count: 1, rank: 1, tied: false },
    ]);
  });
});

describe('the matrix', () => {
  const base = (): Open<MatrixInput> => ({
    tenderId: 'TND_1',
    status: 'EVALUATING',
    frozen: false,
    criteria: CRITERIA,
    bids: [
      { id: 'BID_1', bidderOrganizationId: 'ORG_B', status: 'QUALIFIED' },
      { id: 'BID_2', bidderOrganizationId: 'ORG_C', status: 'QUALIFIED' },
      { id: 'BID_3', bidderOrganizationId: 'ORG_D', status: 'DISQUALIFIED' },
    ],
    qualifications: [
      q('BID_1', 'QUALIFIED'),
      q('BID_2', 'QUALIFIED'),
      q('BID_3', 'DISQUALIFIED', 'NON_RESPONSIVE'),
    ],
    evaluations: [
      { id: 'EV_1', bidId: 'BID_1', evaluatorId: 'USR_1' },
      { id: 'EV_2', bidId: 'BID_2', evaluatorId: 'USR_1' },
    ],
    recusals: [],
    scores: [
      s('EV_1', 'PRICE', 1, 9_000),
      s('EV_1', 'LICENCE', 1, 100),
      s('EV_2', 'PRICE', 1, 7_000),
      s('EV_2', 'LICENCE', 1, 100),
    ],
    minEvaluators: 1,
    maxEvaluators: 1,
  });

  function q(
    bidId: string,
    decision: 'QUALIFIED' | 'DISQUALIFIED',
    reasonCode: string | null = null,
  ) {
    return {
      bidId,
      decision,
      reasonCode,
      reasonText: reasonCode ? 'in words' : null,
      decidedBy: 'USR_9',
      decidedAt: AT,
    };
  }
  function s(evaluationId: string, criterionCode: string, revision: number, scoreScaled: number) {
    return { evaluationId, criterionCode, revision, scoreScaled, scoredAt: AT };
  }

  it('totals, ranks and says the evaluation may be completed', () => {
    const matrix = buildMatrix(base());
    const [first, second, third] = matrix.bids;
    expect(first).toMatchObject({
      bidId: 'BID_1',
      totalScaled: (6000n * 9_000n + 4000n * 100n).toString(),
      rank: 1,
      tied: false,
      evaluatorCount: 1,
    });
    expect(second).toMatchObject({ bidId: 'BID_2', rank: 2 });
    // A disqualified bid is shown with its decision and is not ranked.
    expect(third).toMatchObject({ bidId: 'BID_3', rank: null, totalScaled: null });
    expect(third?.qualification).toMatchObject({
      decision: 'DISQUALIFIED',
      reasonCode: 'NON_RESPONSIVE',
    });
    expect(matrix).toMatchObject({
      ready: true,
      blockers: [],
      undecidedBidCount: 0,
      frozen: false,
      maxTotalScaled: maxTotalScaled(CRITERIA).toString(),
    });
  });

  it('shows the criteria in their order, with their weights from the frozen data', () => {
    const input = base();
    input.criteria = [...CRITERIA].reverse();
    expect(buildMatrix(input).criteria.map((c) => [c.code, c.weightBp])).toEqual([
      ['PRICE', 6000],
      ['LICENCE', 4000],
    ]);
  });

  it('takes the latest revision of a cell and keeps none of the earlier ones in the total', () => {
    const input = base();
    input.scores.push(s('EV_2', 'PRICE', 2, 9_500));
    const matrix = buildMatrix(input);
    const second = matrix.bids.find((b) => b.bidId === 'BID_2')!;
    expect(second.evaluations[0]?.cells.find((c) => c.criterionCode === 'PRICE')).toMatchObject({
      revision: 2,
      scoreScaled: 9_500,
    });
    expect(second.totalScaled).toBe((6000n * 9_500n + 4000n * 100n).toString());
    expect(matrix.bids.find((b) => b.bidId === 'BID_2')?.rank).toBe(1);
  });

  it('shares rank 1 between equal bids and says so', () => {
    const input = base();
    input.scores = [
      s('EV_1', 'PRICE', 1, 8_000),
      s('EV_1', 'LICENCE', 1, 100),
      s('EV_2', 'PRICE', 1, 8_000),
      s('EV_2', 'LICENCE', 1, 100),
    ];
    const matrix = buildMatrix(input);
    expect(
      matrix.bids
        .filter((b) => b.qualification?.decision === 'QUALIFIED')
        .map((b) => [b.rank, b.tied]),
    ).toEqual([
      [1, true],
      [1, true],
    ]);
  });

  it('does not count an evaluation that is not complete, and says which bid is blocking', () => {
    const input = base();
    input.scores = input.scores.filter(
      (row) => !(row.evaluationId === 'EV_2' && row.criterionCode === 'LICENCE'),
    );
    const matrix = buildMatrix(input);
    const second = matrix.bids.find((b) => b.bidId === 'BID_2')!;
    expect(second.evaluations[0]).toMatchObject({ complete: false, totalScaled: null });
    expect(second).toMatchObject({ evaluatorCount: 0, totalScaled: null, rank: null });
    expect(matrix.ready).toBe(false);
    expect(matrix.blockers).toEqual([{ bidId: 'BID_2', completeEvaluators: 0, required: 1 }]);
  });

  it('removes an evaluator who stood down from the matrix, and keeps the stand-down on record', () => {
    const input = base();
    input.recusals = [
      { bidId: 'BID_2', evaluatorId: 'USR_1', reasonCode: 'CONFLICT_OF_INTEREST', recusedAt: AT },
    ];
    const matrix = buildMatrix(input);
    const second = matrix.bids.find((b) => b.bidId === 'BID_2')!;
    expect(second).toMatchObject({ evaluatorCount: 0, totalScaled: null, rank: null });
    expect(second.recusals).toEqual([
      { evaluatorId: 'USR_1', reasonCode: 'CONFLICT_OF_INTEREST', recusedAt: AT.toISOString() },
    ]);
    expect(matrix.ready).toBe(false);
  });

  it('needs the configured number of complete evaluators on every qualified bid', () => {
    const input = base();
    input.minEvaluators = 2;
    input.maxEvaluators = 2;
    expect(
      buildMatrix(input).blockers.map((b) => [b.bidId, b.completeEvaluators, b.required]),
    ).toEqual([
      ['BID_1', 1, 2],
      ['BID_2', 1, 2],
    ]);
    input.evaluations.push(
      { id: 'EV_1B', bidId: 'BID_1', evaluatorId: 'USR_2' },
      { id: 'EV_2B', bidId: 'BID_2', evaluatorId: 'USR_2' },
    );
    input.scores.push(
      s('EV_1B', 'PRICE', 1, 7_000),
      s('EV_1B', 'LICENCE', 1, 100),
      s('EV_2B', 'PRICE', 1, 9_000),
      s('EV_2B', 'LICENCE', 1, 100),
    );
    const matrix = buildMatrix(input);
    expect(matrix.ready).toBe(true);
    // The bid's score is the sum of its evaluators' totals; the two means are compared exactly.
    const a = 6000n * 9_000n + 4000n * 100n + (6000n * 7_000n + 4000n * 100n);
    const b = 6000n * 7_000n + 4000n * 100n + (6000n * 9_000n + 4000n * 100n);
    expect(a).toBe(b);
    expect(
      matrix.bids.filter((x) => x.rank !== null).map((x) => [x.totalScaled, x.rank, x.tied]),
    ).toEqual([
      [a.toString(), 1, true],
      [b.toString(), 1, true],
    ]);
  });

  it('is not ready while an opened bid is undecided, or while nothing is qualified', () => {
    const undecided = base();
    undecided.bids.push({ id: 'BID_4', bidderOrganizationId: 'ORG_E', status: 'OPENED' });
    expect(buildMatrix(undecided)).toMatchObject({ ready: false, undecidedBidCount: 1 });

    const none = base();
    none.bids = [{ id: 'BID_3', bidderOrganizationId: 'ORG_D', status: 'DISQUALIFIED' }];
    none.qualifications = [q('BID_3', 'DISQUALIFIED', 'OTHER')];
    none.evaluations = [];
    none.scores = [];
    expect(buildMatrix(none)).toMatchObject({ ready: false, blockers: [] });
  });

  it('carries no float anywhere: totals are strings of integers and every cell an integer', () => {
    const matrix = buildMatrix(base());
    expect(matrix.maxTotalScaled).toMatch(/^\d+$/);
    for (const bid of matrix.bids) {
      if (bid.totalScaled !== null) expect(bid.totalScaled).toMatch(/^\d+$/);
      for (const evaluation of bid.evaluations) {
        if (evaluation.totalScaled !== null) expect(evaluation.totalScaled).toMatch(/^\d+$/);
        for (const cell of evaluation.cells) expect(Number.isInteger(cell.scoreScaled)).toBe(true);
      }
    }
  });
});

describe('the matrix digest', () => {
  const rows = {
    qualifications: [
      {
        bidId: 'BID_1',
        decision: 'QUALIFIED' as const,
        reasonCode: null,
        reasonText: null,
        decidedBy: 'U',
        decidedAt: AT,
      },
    ],
    evaluations: [{ id: 'EV_1', bidId: 'BID_1', evaluatorId: 'USR_1' }],
    recusals: [],
    scores: [
      { evaluationId: 'EV_1', criterionCode: 'PRICE', revision: 1, scoreScaled: 5, scoredAt: AT },
      { evaluationId: 'EV_1', criterionCode: 'PRICE', revision: 2, scoreScaled: 6, scoredAt: AT },
    ],
  };

  it('is a SHA-256 in hex, the same for the same rows in any order', () => {
    const digest = matrixDigest(rows);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(matrixDigest({ ...rows, scores: [...rows.scores].reverse() })).toBe(digest);
  });

  it('changes with any revision, any decision and any stand-down', () => {
    const digest = matrixDigest(rows);
    expect(
      matrixDigest({
        ...rows,
        scores: [
          ...rows.scores,
          {
            evaluationId: 'EV_1',
            criterionCode: 'PRICE',
            revision: 3,
            scoreScaled: 6,
            scoredAt: AT,
          },
        ],
      }),
    ).not.toBe(digest);
    expect(
      matrixDigest({
        ...rows,
        qualifications: [
          { ...rows.qualifications[0]!, decision: 'DISQUALIFIED', reasonCode: 'OTHER' },
        ],
      }),
    ).not.toBe(digest);
    expect(
      matrixDigest({
        ...rows,
        recusals: [{ bidId: 'BID_1', evaluatorId: 'USR_1', reasonCode: 'OTHER', recusedAt: AT }],
      }),
    ).not.toBe(digest);
  });
});
