import { MAX_JUSTIFICATION_LENGTH, awardTenderSchema, tenderAwardViewSchema } from './award.dto';

/**
 * The owner's side of the contract (ADR-067 § 3): the person names the bid, and says why when the
 * choice is not the matrix's own. `.strict()`: who awards, when, and under which organization are
 * the token's, the database clock's and the tender's, never the body's — and a winner is never
 * left for the platform to pick.
 */

describe('awarding a tender', () => {
  it('accepts a bid alone, and a bid with its justification', () => {
    expect(awardTenderSchema.safeParse({ bidId: 'BID_1' }).success).toBe(true);
    expect(
      awardTenderSchema.safeParse({
        bidId: 'BID_1',
        justification: 'The first rank is not responsive',
      }).success,
    ).toBe(true);
  });

  it('trims the justification', () => {
    const parsed = awardTenderSchema.parse({ bidId: 'BID_1', justification: '  because  ' });
    expect(parsed.justification).toBe('because');
  });

  it.each([
    [{}],
    [{ bidId: '' }],
    [{ bidId: 'x'.repeat(65) }],
    [{ bidId: 7 }],
    [{ bidId: 'BID_1', justification: '' }],
    [{ bidId: 'BID_1', justification: '   ' }],
    [{ bidId: 'BID_1', justification: 42 }],
    [{ winner: 'BID_1' }],
  ])('refuses %j', (body) => {
    expect(awardTenderSchema.safeParse(body).success).toBe(false);
  });

  it('bounds the justification', () => {
    const body = (justification: string) => ({ bidId: 'BID_1', justification });
    expect(awardTenderSchema.safeParse(body('x'.repeat(MAX_JUSTIFICATION_LENGTH))).success).toBe(
      true,
    );
    expect(
      awardTenderSchema.safeParse(body('x'.repeat(MAX_JUSTIFICATION_LENGTH + 1))).success,
    ).toBe(false);
  });

  it('refuses a field the caller does not decide', () => {
    for (const field of [
      'awardedBy',
      'awardedAt',
      'organizationId',
      'status',
      'amountMinor',
      'rank',
      'bidderOrganizationId',
      'matrixDigest',
      'expectedVersion',
    ]) {
      expect(awardTenderSchema.safeParse({ bidId: 'BID_1', [field]: 'x' }).success).toBe(false);
    }
  });
});

describe('the award as it is shown', () => {
  const view = {
    tenderId: 'TND_1',
    projectId: 'PRJ_1',
    status: 'AWARDED',
    bidId: 'BID_1',
    bidderOrganizationId: 'ORG_B',
    amountMinor: '1250000000',
    rank: 1,
    tied: false,
    justification: null,
    matrixDigest: 'c'.repeat(64),
    standingAsOf: '2026-10-03T08:00:00.000Z',
    awardedAt: '2026-10-03T08:00:01.000Z',
    awardedBy: 'USR_1',
    alreadyAwarded: false,
  };

  it('accepts the documented shape', () => {
    expect(tenderAwardViewSchema.safeParse(view).success).toBe(true);
  });

  it('shows the price as a string, never a number', () => {
    expect(tenderAwardViewSchema.safeParse({ ...view, amountMinor: 1250000000 }).success).toBe(
      false,
    );
  });

  it('requires the project', () => {
    const { projectId: _omitted, ...without } = view;
    expect(tenderAwardViewSchema.safeParse(without).success).toBe(false);
  });

  it('refuses a field it does not document', () => {
    expect(tenderAwardViewSchema.safeParse({ ...view, evaluators: [] }).success).toBe(false);
  });
});
