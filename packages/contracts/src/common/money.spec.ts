import {
  MAX_AMOUNT_MINOR,
  MIN_SIGNED_AMOUNT_MINOR,
  amountMinorSchema,
  moneySchema,
  signedAmountMinorSchema,
} from './money';

/**
 * The money schemas stop at what a `BIGINT` column holds (economic batch 2,
 * item d).
 *
 * The change is a narrowing only: every amount accepted before and storable
 * is still accepted, the pattern and its message are unchanged, and the only
 * newly refused strings are amounts no service could ever have stored.
 */

const MAX = MAX_AMOUNT_MINOR.toString();
const PAST_MAX = (MAX_AMOUNT_MINOR + 1n).toString();

describe('amountMinorSchema', () => {
  it('accepts every storable amount, up to and including 2^63 - 1', () => {
    for (const value of ['0', '1', '9007199254740993', MAX, `000${MAX}`]) {
      expect(amountMinorSchema.safeParse(value).success).toBe(true);
    }
    expect(MAX).toBe('9223372036854775807');
  });

  it('refuses one past the largest storable amount, and a thirty-digit one', () => {
    for (const value of [PAST_MAX, '9'.repeat(30)]) {
      const result = amountMinorSchema.safeParse(value);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toMatch(/largest storable amount/);
    }
  });

  it('still refuses a malformed amount with the pattern message, without throwing', () => {
    for (const value of ['12.5', '-1', '1e3', '', 'abc', '9'.repeat(31)]) {
      const result = amountMinorSchema.safeParse(value);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.message)).toContain(
        'Amount must be a non-negative integer string in minor units',
      );
    }
  });

  it('applies inside moneySchema too', () => {
    expect(moneySchema.safeParse({ amountMinor: PAST_MAX, currency: 'IRR' }).success).toBe(false);
    expect(moneySchema.safeParse({ amountMinor: MAX, currency: 'IRR' }).success).toBe(true);
  });
});

describe('signedAmountMinorSchema', () => {
  it('accepts the whole BIGINT range', () => {
    for (const value of [MIN_SIGNED_AMOUNT_MINOR.toString(), '-1', '0', MAX]) {
      expect(signedAmountMinorSchema.safeParse(value).success).toBe(true);
    }
  });

  it('refuses just outside it on either side', () => {
    for (const value of [(MIN_SIGNED_AMOUNT_MINOR - 1n).toString(), PAST_MAX]) {
      const result = signedAmountMinorSchema.safeParse(value);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toMatch(/storable range/);
    }
  });

  it('still refuses a malformed amount without throwing', () => {
    expect(signedAmountMinorSchema.safeParse('--1').success).toBe(false);
    expect(signedAmountMinorSchema.safeParse('1.0').success).toBe(false);
  });
});
