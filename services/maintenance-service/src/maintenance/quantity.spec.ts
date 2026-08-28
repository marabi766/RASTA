import {
  decimalToHundredths,
  formatHundredths,
  isPositive,
  lineTotalMinor,
  parseHundredths,
  parseScaled,
} from './quantity';

/**
 * These functions carry every number in this service that someone is
 * eventually paid for or serviced on, so the tests are about exactness rather
 * than about coverage: the cases below are the ones where a float-based
 * implementation gives a different answer.
 */
describe('quantity arithmetic', () => {
  describe('parseHundredths', () => {
    it('reads integers and two-place decimals exactly', () => {
      expect(parseHundredths('0')).toBe(0n);
      expect(parseHundredths('250')).toBe(25_000n);
      expect(parseHundredths('4310.50')).toBe(431_050n);
      expect(parseHundredths('0.05')).toBe(5n);
    });

    it('adds without drift, where a float would not', () => {
      // 0.1 + 0.2 !== 0.3 in binary floating point. Here it is exact, and that
      // is the whole reason this module exists.
      const sum = (parseHundredths('0.10') ?? 0n) + (parseHundredths('0.20') ?? 0n);
      expect(sum).toBe(parseHundredths('0.30'));
    });

    it('refuses more precision than the column holds, rather than rounding it away', () => {
      // Silently dropping a digit is how a total drifts. Refusing means the
      // caller hears about it at the boundary.
      expect(parseHundredths('1.005')).toBeNull();
    });

    it('refuses anything that is not a number', () => {
      expect(parseHundredths('')).toBeNull();
      expect(parseHundredths('12,50')).toBeNull();
      expect(parseHundredths('1e3')).toBeNull();
      expect(parseHundredths(null)).toBeNull();
      expect(parseHundredths(undefined)).toBeNull();
    });

    it('round-trips through formatHundredths', () => {
      for (const value of ['0.00', '1.05', '4310.50', '99999999.99']) {
        expect(formatHundredths(parseHundredths(value) as bigint)).toBe(value);
      }
    });

    it('formats negatives, which is how "overdue by" is reported', () => {
      expect(formatHundredths(-2050n)).toBe('-20.50');
      expect(formatHundredths(-5n)).toBe('-0.05');
    });
  });

  describe('decimalToHundredths', () => {
    it('reads a Prisma Decimal through toString, never toNumber', () => {
      // `toNumber()` is the method autocomplete offers first and the one that
      // loses precision. Routing every read through here keeps it out of
      // domain code.
      const decimal = { toString: () => '4310.50' };
      expect(decimalToHundredths(decimal)).toBe(431_050n);
      expect(decimalToHundredths(null)).toBeNull();
    });
  });

  describe('isPositive', () => {
    it('rejects zero and null, which is what an interval must not be', () => {
      expect(isPositive(1n)).toBe(true);
      expect(isPositive(0n)).toBe(false);
      expect(isPositive(-1n)).toBe(false);
      expect(isPositive(null)).toBe(false);
    });
  });

  describe('parseScaled', () => {
    it('reads part quantities at three decimals', () => {
      expect(parseScaled('12.5', 3)).toBe(12_500n);
      expect(parseScaled('0.125', 3)).toBe(125n);
      expect(parseScaled('2', 3)).toBe(2_000n);
    });

    it('refuses more precision than the requested scale', () => {
      expect(parseScaled('0.1255', 3)).toBeNull();
      expect(parseScaled('1.005', 2)).toBeNull();
    });
  });

  describe('lineTotalMinor', () => {
    it('multiplies a quantity by a unit price exactly', () => {
      // 12.5 litres at 320 000 rial.
      expect(lineTotalMinor('12.5', 320_000n, 3)).toBe(4_000_000n);
      expect(lineTotalMinor('2', 150_000n, 3)).toBe(300_000n);
      // 6.5 hours at 900 000 rial.
      expect(lineTotalMinor('6.50', 900_000n, 2)).toBe(5_850_000n);
    });

    it('rounds half-up once, at the end', () => {
      // A third of a unit at 10 rial is 3.33 rial. Rounded once, not per step.
      expect(lineTotalMinor('0.333', 10n, 3)).toBe(3n);
      // Exactly half rounds up, the direction an invoice would take.
      expect(lineTotalMinor('0.5', 1n, 3)).toBe(1n);
      expect(lineTotalMinor('0.499', 1n, 3)).toBe(0n);
    });

    it('handles amounts a JSON number could not hold', () => {
      // Beyond Number.MAX_SAFE_INTEGER. This is why money is bigint and
      // crosses the wire as a string (ADR-022).
      const huge = 9_007_199_254_740_993n;
      expect(lineTotalMinor('2', huge, 3)).toBe(huge * 2n);
    });

    it('refuses a quantity it cannot price rather than inventing a total', () => {
      expect(lineTotalMinor('abc', 100n, 3)).toBeNull();
      expect(lineTotalMinor('-1', 100n, 3)).toBeNull();
      expect(lineTotalMinor('1.0001', 100n, 3)).toBeNull();
    });
  });
});
