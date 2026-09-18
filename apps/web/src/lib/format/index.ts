/**
 * The Persian presentation layer.
 *
 * Everything that turns platform data into something a Persian reader sees —
 * digits, money, dates, text — is exported from here and implemented nowhere
 * else. The boundary is the point: data and the API stay Latin, Gregorian and
 * UTC (CLAUDE.md, docs/16 § 16.3), and a component that wants to show a number
 * or a date asks this module rather than formatting it in place.
 */

export {
  MINUS_SIGN,
  PERSIAN_DECIMAL_SEPARATOR,
  PERSIAN_THOUSANDS_SEPARATOR,
  ZWNJ,
} from './codepoints';

export { groupDigits, toLatinDigits, toPersianDigits } from './digits';

export {
  DISPLAY_TIME_ZONE,
  formatGregorianUtc,
  formatJalaliDate,
  formatJalaliDateLong,
  formatJalaliDateTime,
} from './datetime';
export type { DateFormatOptions } from './datetime';

export { IRR, MoneyInputError, formatMoney, parseMoneyInput } from './money';
export type { CurrencyFormat, FormatMoneyOptions } from './money';

export {
  collapseWhitespace,
  containsLatin,
  joinWithZwnj,
  normalizePersianLetters,
  normalizePersianText,
} from './text';
