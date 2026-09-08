import {
  NotAnIntegerStringError,
  formatInteger,
  formatMoneyMinor,
  groupDigits,
  toLatinDigits,
  toPersianDigits,
} from './format';

/**
 * Money is a string, start to finish (ADR-022).
 *
 * The load-bearing case is the large one. A provincial budget in rial passes
 * `Number.MAX_SAFE_INTEGER`, and the failure mode of getting this wrong is not
 * a crash — it is a page that renders a slightly wrong number, confidently.
 */

describe('money stays a string', () => {
  it('renders an amount beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const amount = '9007199254740993'; // MAX_SAFE_INTEGER + 2
    expect(Number(amount).toString()).not.toBe(amount); // the trap this avoids

    const rendered = formatMoneyMinor(amount);
    expect(toLatinDigits(rendered).replace(/[^0-9]/g, '')).toBe(amount);
  });

  it('renders a thirty-digit amount without loss', () => {
    const amount = '1'.repeat(30);
    expect(toLatinDigits(formatMoneyMinor(amount)).replace(/[^0-9]/g, '')).toBe(amount);
  });

  it('groups thousands and labels the currency', () => {
    expect(formatMoneyMinor('10000000')).toBe('۱۰٬۰۰۰٬۰۰۰ ریال');
  });

  it('falls back to the currency code for an unknown currency', () => {
    expect(formatMoneyMinor('1000', 'XYZ')).toBe('۱٬۰۰۰ XYZ');
  });

  it('refuses anything that is not an integer string', () => {
    expect(() => formatMoneyMinor('1234.56')).toThrow(NotAnIntegerStringError);
    expect(() => formatMoneyMinor('1e6')).toThrow(NotAnIntegerStringError);
    expect(() => formatMoneyMinor('')).toThrow(NotAnIntegerStringError);
    expect(() => formatMoneyMinor('۱۲۳')).toThrow(NotAnIntegerStringError);
  });

  it('never calls a number conversion on the way through', () => {
    // A structural assertion rather than a behavioural one: the module must
    // not contain the conversions that would silently truncate a large amount.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const source: string = require('node:fs').readFileSync(require.resolve('./format.ts'), 'utf8');

    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    expect(code).not.toMatch(/parseFloat|parseInt|toLocaleString|\bNumber\s*\(/);
  });
});

describe('digit grouping', () => {
  it.each([
    ['0', '۰'],
    ['1', '۱'],
    ['999', '۹۹۹'],
    ['1000', '۱٬۰۰۰'],
    ['1234567', '۱٬۲۳۴٬۵۶۷'],
  ])('groups %s', (input, expected) => {
    expect(toPersianDigits(groupDigits(input))).toBe(expected);
  });

  it('keeps the sign in front for a signed ledger amount', () => {
    expect(groupDigits('-1234567')).toBe('-1٬234٬567');
  });
});

describe('digit conversion', () => {
  it('converts Latin to Persian and back', () => {
    expect(toPersianDigits('2026-09-08')).toBe('۲۰۲۶-۰۹-۰۸');
    expect(toLatinDigits('۲۰۲۶-۰۹-۰۸')).toBe('2026-09-08');
  });

  it('normalizes Arabic-Indic input digits to Latin', () => {
    expect(toLatinDigits('١٢٣٤٥٦٧٨٩٠')).toBe('1234567890');
  });

  it('leaves non-digits alone', () => {
    expect(toPersianDigits('ORD-01H9')).toBe('ORD-۰۱H۹');
  });

  it('formats a count', () => {
    expect(formatInteger(1250)).toBe('۱٬۲۵۰');
    expect(formatInteger('7')).toBe('۷');
  });
});
