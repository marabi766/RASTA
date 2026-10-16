import { MAX_AMOUNT_MINOR } from '@rasta/contracts';
import { computeStatementAmounts, type ConfiguredDeduction } from './amounts';

const rule = (id: string, rateBp: number): ConfiguredDeduction => ({
  id,
  name: `rule ${id}`,
  rateBp,
  base: 'GROSS',
});

describe('computeStatementAmounts', () => {
  it('with no configured deduction the net is the gross (Q-96 (6))', () => {
    expect(computeStatementAmounts([1_000n, 2_500n], [])).toEqual({
      grossMinor: 3_500n,
      deductions: [],
      deductionsMinor: 0n,
      netMinor: 3_500n,
    });
  });

  it('applies each rule’s rate to the gross, half up, and subtracts the sum once', () => {
    // 1001 × 5% = 50.05 → 50; 1001 × 0.5% = 5.005 → 5; 1010 × 0.5% = 5.05 → 5; half up at .5.
    const result = computeStatementAmounts([1_001n], [rule('A', 500), rule('B', 50)]);
    expect(result).toMatchObject({ grossMinor: 1_001n, deductionsMinor: 55n, netMinor: 946n });
    expect(computeStatementAmounts([1_000n], [rule('C', 5)])).toMatchObject({
      deductionsMinor: 1n, // 0.5 rounds up
      netMinor: 999n,
    });
    expect(computeStatementAmounts([999n], [rule('C', 5)])).toMatchObject({
      deductionsMinor: 0n, // 0.4995 rounds down
      netMinor: 999n,
    });
  });

  it('is exact past Number.MAX_SAFE_INTEGER: bigint throughout, never a float', () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    const result = computeStatementAmounts([big, big], [rule('A', 1_000)]);
    expect(result).toMatchObject({
      grossMinor: 18_014_398_509_481_986n,
      deductionsMinor: 1_801_439_850_948_199n,
      netMinor: 16_212_958_658_533_787n,
    });
  });

  it('a whole-gross deduction leaves a zero net; more than the gross is refused', () => {
    expect(computeStatementAmounts([700n], [rule('A', 10_000)])).toMatchObject({ netMinor: 0n });
    expect(computeStatementAmounts([700n], [rule('A', 6_000), rule('B', 5_000)])).toBe(
      'STATEMENT_NET_NEGATIVE',
    );
  });

  it('refuses a gross past the largest bigint', () => {
    expect(computeStatementAmounts([MAX_AMOUNT_MINOR], [])).toMatchObject({
      grossMinor: MAX_AMOUNT_MINOR,
    });
    expect(computeStatementAmounts([MAX_AMOUNT_MINOR, 1n], [])).toBe('STATEMENT_EXCEEDS_LIMIT');
  });

  it('computes on no other base than the gross', () => {
    expect(() => computeStatementAmounts([1n], [{ ...rule('X', 1), base: 'NET' }])).toThrow(
      /base this service does not compute/,
    );
  });
});
