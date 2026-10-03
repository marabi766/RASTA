import {
  DISQUALIFICATION_REASONS,
  RECUSAL_REASONS,
  qualifyBidSchema,
  recuseSchema,
  scoreBidSchema,
} from './evaluation.dto';

/**
 * The evaluator's side of the contract (ADR-067 § 2): the decision, the stand-down and the scores.
 * `.strict()` everywhere: who, when and which organization are the token's, the database clock's
 * and the tender's, never the body's.
 */

describe('deciding on a bid', () => {
  it('accepts a qualification that gives no reason', () => {
    expect(qualifyBidSchema.safeParse({ decision: 'QUALIFIED' }).success).toBe(true);
  });

  it('accepts a disqualification with a closed code and the reason in words', () => {
    for (const reasonCode of DISQUALIFICATION_REASONS) {
      expect(
        qualifyBidSchema.safeParse({ decision: 'DISQUALIFIED', reasonCode, reasonText: 'Why' })
          .success,
      ).toBe(true);
    }
  });

  it.each([
    [{ decision: 'DISQUALIFIED' }],
    [{ decision: 'DISQUALIFIED', reasonCode: 'OTHER' }],
    [{ decision: 'DISQUALIFIED', reasonText: 'Why' }],
    [{ decision: 'QUALIFIED', reasonCode: 'OTHER', reasonText: 'Why' }],
    [{ decision: 'QUALIFIED', reasonText: 'Why' }],
    [{ decision: 'DISQUALIFIED', reasonCode: 'BAD_FEELING', reasonText: 'Why' }],
    [{ decision: 'DISQUALIFIED', reasonCode: 'OTHER', reasonText: '   ' }],
    [{ decision: 'AWARDED' }],
  ])('refuses %j', (body) => {
    expect(qualifyBidSchema.safeParse(body).success).toBe(false);
  });

  it('refuses a field the caller does not decide', () => {
    for (const field of ['decidedBy', 'organizationId', 'decidedAt', 'status']) {
      expect(qualifyBidSchema.safeParse({ decision: 'QUALIFIED', [field]: 'x' }).success).toBe(
        false,
      );
    }
  });

  it('bounds the reason in words', () => {
    const body = (reasonText: string) => ({
      decision: 'DISQUALIFIED',
      reasonCode: 'OTHER',
      reasonText,
    });
    expect(qualifyBidSchema.safeParse(body('x'.repeat(2000))).success).toBe(true);
    expect(qualifyBidSchema.safeParse(body('x'.repeat(2001))).success).toBe(false);
  });
});

describe('standing down', () => {
  it('takes a closed code and nothing else', () => {
    for (const reasonCode of RECUSAL_REASONS) {
      expect(recuseSchema.safeParse({ reasonCode }).success).toBe(true);
    }
    expect(recuseSchema.safeParse({}).success).toBe(false);
    expect(recuseSchema.safeParse({ reasonCode: 'BORED' }).success).toBe(false);
    expect(recuseSchema.safeParse({ reasonCode: 'OTHER', reasonText: 'prose' }).success).toBe(
      false,
    );
    expect(recuseSchema.safeParse({ reasonCode: 'OTHER', evaluatorId: 'USR_9' }).success).toBe(
      false,
    );
  });
});

describe('scoring a bid', () => {
  const one = (scoreScaled: unknown) => ({ scores: [{ criterionCode: 'PRICE', scoreScaled }] });

  it('takes integers, the points × 100', () => {
    expect(scoreBidSchema.safeParse(one(0)).success).toBe(true);
    expect(scoreBidSchema.safeParse(one(8_550)).success).toBe(true);
    expect(scoreBidSchema.safeParse(one(100_000_000)).success).toBe(true);
  });

  it.each([[-1], [100_000_001], [85.5], [1e21], ['8550'], [null], [Number.NaN]])(
    'refuses %j: a score is an integer in range, never a float',
    (value) => {
      expect(scoreBidSchema.safeParse(one(value)).success).toBe(false);
    },
  );

  it('needs at least one score and at most one per criterion', () => {
    expect(scoreBidSchema.safeParse({ scores: [] }).success).toBe(false);
    expect(
      scoreBidSchema.safeParse({
        scores: [
          { criterionCode: 'PRICE', scoreScaled: 1 },
          { criterionCode: 'PRICE', scoreScaled: 2 },
        ],
      }).success,
    ).toBe(false);
    expect(
      scoreBidSchema.safeParse({
        scores: Array.from({ length: 51 }, (_, i) => ({ criterionCode: `C${i}`, scoreScaled: 1 })),
      }).success,
    ).toBe(false);
  });

  it('refuses a field the caller does not decide: the evaluator, the revision, the time', () => {
    for (const field of ['evaluatorId', 'revision', 'scoredAt', 'organizationId']) {
      expect(scoreBidSchema.safeParse({ ...one(1), [field]: 'x' }).success).toBe(false);
      expect(
        scoreBidSchema.safeParse({
          scores: [{ criterionCode: 'PRICE', scoreScaled: 1, [field]: 'x' }],
        }).success,
      ).toBe(false);
    }
  });
});
