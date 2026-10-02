import { bidContentSchema, reviseBidSchema, submitBidSchema, withdrawBidSchema } from './bid.dto';

const content = (overrides: object = {}) => ({
  priceMinor: '1250000000',
  answers: [{ criterionCode: 'PRICE', response: 'Fixed price' }],
  ...overrides,
});

describe('a bid’s content', () => {
  it('takes a price as whole minor units in a string, up to the largest bigint a column holds', () => {
    for (const price of ['0', '1', '1250000000', '9223372036854775807']) {
      expect(bidContentSchema.safeParse(content({ priceMinor: price })).success).toBe(true);
    }
  });

  it.each([
    ['a number', 1250],
    ['a decimal', '12.5'],
    ['a negative', '-1'],
    ['a leading zero', '007'],
    ['blank', ''],
    ['text', 'cheap'],
    ['too large', '9223372036854775808'],
    ['twenty digits', '99999999999999999999'],
  ])('refuses a price that is %s without throwing', (_label, price) => {
    expect(() => bidContentSchema.safeParse(content({ priceMinor: price }))).not.toThrow();
    expect(bidContentSchema.safeParse(content({ priceMinor: price })).success).toBe(false);
  });

  it('answers each criterion at most once and carries nothing it was not told to', () => {
    const twice = content({
      answers: [
        { criterionCode: 'PRICE', response: 'a' },
        { criterionCode: 'PRICE', response: 'b' },
      ],
    });
    expect(bidContentSchema.safeParse(twice).success).toBe(false);
    expect(bidContentSchema.safeParse(content({ receipt: 'x' })).success).toBe(false);
    expect(
      bidContentSchema.safeParse(
        content({ answers: [{ criterionCode: 'P', response: 'a', x: 1 }] }),
      ).success,
    ).toBe(false);
  });
});

describe('the bid commands', () => {
  it('decide neither the bidder, the revision on a first bid, nor any status', () => {
    expect(submitBidSchema.safeParse({ content: content(), revision: 1 }).success).toBe(false);
    expect(submitBidSchema.safeParse({ content: content(), status: 'OPENED' }).success).toBe(false);
    expect(submitBidSchema.safeParse({ content: content() }).success).toBe(true);
  });

  it('carry the revision they are made against, and it is a positive integer', () => {
    expect(reviseBidSchema.safeParse({ content: content() }).success).toBe(false);
    expect(reviseBidSchema.safeParse({ expectedRevision: 0, content: content() }).success).toBe(
      false,
    );
    expect(reviseBidSchema.safeParse({ expectedRevision: 1, content: content() }).success).toBe(
      true,
    );
    expect(withdrawBidSchema.safeParse({}).success).toBe(false);
    expect(withdrawBidSchema.safeParse({ expectedRevision: 2 }).success).toBe(true);
    expect(withdrawBidSchema.safeParse({ expectedRevision: 2, reason: 'x' }).success).toBe(false);
  });
});
