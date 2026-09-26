import { MINUS_SIGN, PERSIAN_DECIMAL_SEPARATOR, PERSIAN_THOUSANDS_SEPARATOR } from './codepoints';
import { IRR, MoneyInputError, formatMoney, parseMoneyInput } from './money';
import type { CurrencyFormat } from './money';

/** A two-decimal currency, so the scaling path is exercised as well as IRR. */
const TWO_DECIMAL: CurrencyFormat = { code: 'XXX', label: 'واحد', fractionDigits: 2 };

const sep = PERSIAN_THOUSANDS_SEPARATOR;
const dec = PERSIAN_DECIMAL_SEPARATOR;

/** `0123` in Arabic-Indic digits, built from code points rather than pasted. */
const ARABIC_INDIC_0123 = [0x0660, 0x0661, 0x0662, 0x0663]
  .map((code) => String.fromCodePoint(code))
  .join('');

describe('formatMoney', () => {
  // The worked example from docs/16 § 16.5, character for character.
  it('renders the documented example', () => {
    expect(formatMoney('10000000')).toBe(`۱۰${sep}۰۰۰${sep}۰۰۰ ریال`);
  });

  it('omits the label on request', () => {
    expect(formatMoney('10000000', IRR, { withLabel: false })).toBe(`۱۰${sep}۰۰۰${sep}۰۰۰`);
  });

  it('can stay in Latin digits, for a value about to be copied', () => {
    expect(formatMoney('10000000', IRR, { persianDigits: false, withLabel: false })).toBe(
      `10${sep}000${sep}000`,
    );
  });

  it('uses a true minus sign rather than a hyphen', () => {
    expect(formatMoney('-5000', IRR, { withLabel: false })).toBe(`${MINUS_SIGN}۵${sep}۰۰۰`);
  });

  it('renders zero', () => {
    expect(formatMoney('0', IRR, { withLabel: false })).toBe('۰');
  });

  // The reason money is a string end to end: this amount is past
  // Number.MAX_SAFE_INTEGER, and a float would have lost the last digits
  // before it ever reached a formatter.
  it('is exact beyond the safe integer range', () => {
    expect(
      formatMoney('9007199254740993000', IRR, { withLabel: false, persianDigits: false }),
    ).toBe(`9${sep}007${sep}199${sep}254${sep}740${sep}993${sep}000`);
  });

  it('accepts a bigint as readily as a string', () => {
    expect(formatMoney(10000000n, IRR, { withLabel: false })).toBe(`۱۰${sep}۰۰۰${sep}۰۰۰`);
  });

  it('places the decimal separator for a currency that has one', () => {
    expect(formatMoney('123456', TWO_DECIMAL, { withLabel: false })).toBe(`۱${sep}۲۳۴${dec}۵۶`);
  });

  it('pads a sub-unit amount rather than dropping the leading zero', () => {
    expect(formatMoney('7', TWO_DECIMAL, { withLabel: false })).toBe(`۰${dec}۰۷`);
  });

  it('refuses a value that is not whole minor units', () => {
    expect(() => formatMoney('12.5')).toThrow(RangeError);
    expect(() => formatMoney('۱۲')).toThrow(RangeError);
  });
});

describe('parseMoneyInput', () => {
  it.each([
    ['plain Latin', '10000000', 10000000n],
    ['Persian digits', '۱۰۰۰۰۰۰۰', 10000000n],
    ['Persian digits and grouping', `۱۰${sep}۰۰۰${sep}۰۰۰`, 10000000n],
    ['ASCII commas', '10,000,000', 10000000n],
    ['spaces as grouping', '10 000 000', 10000000n],
    ['Arabic-Indic digits', ARABIC_INDIC_0123, 123n],
    ['an ASCII hyphen', '-5000', -5000n],
    ['a true minus sign', `${MINUS_SIGN}5000`, -5000n],
    ['zero', '0', 0n],
  ])('reads %s', (_label, input, expected) => {
    expect(parseMoneyInput(input)).toBe(expected);
  });

  it('scales to minor units for a currency with decimals', () => {
    expect(parseMoneyInput(`1${sep}234${dec}56`, TWO_DECIMAL)).toBe(123456n);
    expect(parseMoneyInput('1.2', TWO_DECIMAL)).toBe(120n);
    expect(parseMoneyInput('.07', TWO_DECIMAL)).toBe(7n);
  });

  it('keeps every digit of an amount past the safe integer range', () => {
    expect(parseMoneyInput('9007199254740993000')).toBe(9007199254740993000n);
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['only a sign', '-'],
    ['letters', 'abc'],
    ['digits and letters', '12abc'],
    ['two decimal points', '1.2.3'],
  ])('refuses %s', (_label, input) => {
    expect(() => parseMoneyInput(input)).toThrow(MoneyInputError);
  });

  // The rial is quoted whole. Accepting "1.5" would silently make it 1 or 2.
  it('refuses a decimal for a currency that has none', () => {
    expect(() => parseMoneyInput('1.5')).toThrow(MoneyInputError);
  });

  it('refuses more decimals than the currency carries', () => {
    expect(() => parseMoneyInput('1.234', TWO_DECIMAL)).toThrow(MoneyInputError);
  });

  it('names the decimal limit in Persian digits (L5-09)', () => {
    expect(() => parseMoneyInput('1.234', TWO_DECIMAL)).toThrow(
      'حداکثر ۲ رقم اعشار پذیرفته می‌شود',
    );
  });

  it('round-trips with formatMoney', () => {
    const minor = parseMoneyInput(`۱۲${sep}۳۴۵${sep}۶۷۸`);
    expect(formatMoney(minor, IRR, { withLabel: false })).toBe(`۱۲${sep}۳۴۵${sep}۶۷۸`);
  });
});
