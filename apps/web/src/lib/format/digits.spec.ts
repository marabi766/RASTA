import { PERSIAN_THOUSANDS_SEPARATOR } from './codepoints';
import { groupDigits, toLatinDigits, toPersianDigits } from './digits';

/** The Arabic-Indic digits, built from their code points so the test is not a literal a reader has to trust. */
const ARABIC_INDIC = Array.from({ length: 10 }, (_, i) => String.fromCodePoint(0x0660 + i)).join(
  '',
);

describe('toPersianDigits', () => {
  it('rewrites every Latin digit', () => {
    expect(toPersianDigits('0123456789')).toBe('۰۱۲۳۴۵۶۷۸۹');
  });

  it('leaves Persian letters, punctuation and Latin letters alone', () => {
    expect(toPersianDigits('سفارش ORD-2026 ثبت شد.')).toBe('سفارش ORD-۲۰۲۶ ثبت شد.');
  });

  it('is a no-op on text without digits', () => {
    expect(toPersianDigits('بدون عدد')).toBe('بدون عدد');
  });
});

describe('toLatinDigits', () => {
  it('reads Persian digits', () => {
    expect(toLatinDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
  });

  // An Arabic keyboard produces a different code point for the same-looking
  // digit. A form that rejected these would be rejecting a number the user can
  // see is correct.
  it('reads Arabic-Indic digits', () => {
    expect(toLatinDigits(ARABIC_INDIC)).toBe('0123456789');
  });

  it('reads a string that mixes all three alphabets', () => {
    expect(toLatinDigits(`۱2${ARABIC_INDIC[3]}`)).toBe('123');
  });

  it('round-trips with toPersianDigits', () => {
    expect(toLatinDigits(toPersianDigits('98765'))).toBe('98765');
  });
});

describe('groupDigits', () => {
  const sep = PERSIAN_THOUSANDS_SEPARATOR;

  it.each([
    ['1', '1'],
    ['12', '12'],
    ['123', '123'],
    ['1234', `1${sep}234`],
    ['10000000', `10${sep}000${sep}000`],
  ])('groups %s', (input, expected) => {
    expect(groupDigits(input)).toBe(expected);
  });

  it('leaves an empty string empty', () => {
    expect(groupDigits('')).toBe('');
  });

  it('refuses anything that is not a run of Latin digits', () => {
    expect(() => groupDigits('۱۲۳')).toThrow(RangeError);
    expect(() => groupDigits('-12')).toThrow(RangeError);
  });
});
