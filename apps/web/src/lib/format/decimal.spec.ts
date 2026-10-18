import { formatScaledDecimal, parseScaledDecimalInput } from './decimal';

/** Points carried as scaled integers: said in Persian, read from either alphabet, never a float. */

it('says a scaled integer in Persian digits with the Persian decimal mark, no trailing zeros', () => {
  expect(formatScaledDecimal('850', 2)).toBe('۸٫۵');
  expect(formatScaledDecimal('1000', 2)).toBe('۱۰');
  expect(formatScaledDecimal('5', 2)).toBe('۰٫۰۵');
  expect(formatScaledDecimal('6250000', 6)).toBe('۶٫۲۵');
  expect(formatScaledDecimal('0', 6)).toBe('۰');
  expect(formatScaledDecimal('7', 0)).toBe('۷');
  // A total past `Number.MAX_SAFE_INTEGER` keeps every digit.
  expect(formatScaledDecimal('90071992547409930000001', 6)).toBe('۹۰۰۷۱۹۹۲۵۴۷۴۰۹۹۳۰٫۰۰۰۰۰۱');
});

it('refuses what is not a Latin integer string', () => {
  expect(() => formatScaledDecimal('8.5', 2)).toThrow(RangeError);
  expect(() => formatScaledDecimal('۸۵', 2)).toThrow(RangeError);
});

it('reads Persian, Arabic-Indic and Latin digits and both decimal marks', () => {
  expect(parseScaledDecimalInput('۸٫۵', 2)).toBe(850);
  expect(parseScaledDecimalInput('٨.٢٥', 2)).toBe(825);
  expect(parseScaledDecimalInput(' 10 ', 2)).toBe(1000);
  expect(parseScaledDecimalInput('0', 2)).toBe(0);
});

it('refuses a sign, a third decimal, a grouping mark and words', () => {
  for (const raw of ['-1', '1.234', '1,000', 'هشت', '', '.5', '1.']) {
    expect(parseScaledDecimalInput(raw, 2)).toBeNull();
  }
});
