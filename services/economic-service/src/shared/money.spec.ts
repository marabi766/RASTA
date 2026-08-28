import {
  clampCommission,
  commissionFor,
  formatMinor,
  opposite,
  parseMinor,
  signedValue,
  toMoney,
} from './money';

/**
 * The money boundary (ADR-022).
 *
 * `parseMinor` is the only place a string from outside becomes arithmetic, so
 * every way a malformed amount could slip through has to fail here — loudly.
 * `BigInt('12.5')` throws a `SyntaxError` a caller cannot interpret, and
 * `Number('12.5')` would put a fraction of a rial into a ledger.
 */

describe('parseMinor', () => {
  it('parses a plain integer string', () => {
    expect(parseMinor('10000000')).toBe(10_000_000n);
  });

  it('parses zero', () => {
    expect(parseMinor('0')).toBe(0n);
  });

  it('parses an amount beyond Number.MAX_SAFE_INTEGER exactly', () => {
    // The reason amounts cross the wire as strings at all.
    expect(parseMinor('9007199254740993')).toBe(9_007_199_254_740_993n);
  });

  it.each([
    ['a decimal', '12.5'],
    ['a negative', '-100'],
    ['a plus sign', '+100'],
    ['scientific notation', '1e5'],
    ['whitespace', ' 100 '],
    ['an empty string', ''],
    ['a thousands separator', '1,000'],
    ['a Persian digit', '۱۰۰'],
    ['letters', 'abc'],
    ['hexadecimal', '0x64'],
  ])('refuses %s', (_label, value) => {
    expect(() => parseMinor(value)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('names the field so a client can point at the right input', () => {
    try {
      parseMinor('12.5', 'grossAmountMinor');
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as { details?: { path: string }[] }).details?.[0]?.path).toBe(
        'grossAmountMinor',
      );
    }
  });
});

describe('formatMinor', () => {
  it('emits a decimal string, never a number', () => {
    expect(formatMinor(10_000_000n)).toBe('10000000');
    expect(typeof formatMinor(1n)).toBe('string');
  });

  it('survives a round trip at an amount a double would lose', () => {
    const value = 9_007_199_254_740_993n;
    expect(parseMinor(formatMinor(value))).toBe(value);
  });
});

describe('toMoney', () => {
  it('produces the platform money shape', () => {
    expect(toMoney(250_000n, 'IRR')).toEqual({ amountMinor: '250000', currency: 'IRR' });
  });
});

describe('signedValue', () => {
  it('makes a debit positive and a credit negative', () => {
    // The convention the balance check rests on — and the same expression the
    // database trigger uses, deliberately, so the two cannot drift.
    expect(signedValue('DEBIT', 100n)).toBe(100n);
    expect(signedValue('CREDIT', 100n)).toBe(-100n);
  });
});

describe('opposite', () => {
  it('flips a direction', () => {
    expect(opposite('DEBIT')).toBe('CREDIT');
    expect(opposite('CREDIT')).toBe('DEBIT');
  });

  it('is its own inverse', () => {
    expect(opposite(opposite('DEBIT'))).toBe('DEBIT');
  });
});

describe('commissionFor', () => {
  it('delegates to the platform-wide basis-point function', () => {
    // One rounding rule for the whole platform: a commission computed here and
    // re-checked in analytics must agree to the rial (docs/10 § 10.11).
    expect(commissionFor(10_000_000n, 'IRR', 200)).toBe(200_000n);
  });

  it('returns nothing for a zero rate', () => {
    expect(commissionFor(10_000_000n, 'IRR', 0)).toBe(0n);
  });

  it('refuses a negative rate', () => {
    expect(() => commissionFor(1000n, 'IRR', -1)).toThrow(RangeError);
  });

  it('refuses a fractional rate', () => {
    // Basis points are integers by construction (ADR-022).
    expect(() => commissionFor(1000n, 'IRR', 2.5)).toThrow(RangeError);
  });
});

describe('clampCommission', () => {
  const gross = 1_000_000n;

  it('leaves an in-range figure alone', () => {
    expect(clampCommission(25_000n, gross, { minMinor: 1000n, maxMinor: 100_000n })).toBe(25_000n);
  });

  it('lifts a figure to the floor', () => {
    expect(clampCommission(500n, gross, { minMinor: 1000n, maxMinor: null })).toBe(1000n);
  });

  it('holds a figure at the ceiling', () => {
    expect(clampCommission(500_000n, gross, { minMinor: null, maxMinor: 100_000n })).toBe(100_000n);
  });

  it('applies the floor before the ceiling', () => {
    // So a rule whose minimum exceeds its maximum cannot produce a figure
    // above the maximum. `ck_commission_rule_bounds` already refuses that
    // combination; this is what the code does if the constraint is relaxed.
    expect(clampCommission(10n, gross, { minMinor: 5000n, maxMinor: 1000n })).toBe(1000n);
  });

  it('never charges more than the transaction is worth', () => {
    // `ck_commission_amounts` refuses `amount > gross`, so capping here turns
    // a constraint violation into a sane charge.
    expect(clampCommission(0n, 500n, { minMinor: 900n, maxMinor: null })).toBe(500n);
  });

  it('treats absent bounds as no bounds', () => {
    expect(clampCommission(25_000n, gross, {})).toBe(25_000n);
    expect(clampCommission(25_000n, gross, { minMinor: null, maxMinor: null })).toBe(25_000n);
  });
});
