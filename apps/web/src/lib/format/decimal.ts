import { PERSIAN_DECIMAL_SEPARATOR } from './codepoints';
import { toLatinDigits, toPersianDigits } from './digits';

/**
 * Fixed-point numbers that are not money — an evaluation's points, carried by
 * the API as an integer scaled by a power of ten (a score is the points × 100;
 * a weighted total is Σ weightBp × score, so the points × 10⁶). Never a
 * `number` on the way through: a total is a bigint string, and a float would
 * round it.
 */

/**
 * `value` (Latin digits, an integer scaled by 10^`scale`) as a Persian reader
 * reads it: Persian digits, the Persian decimal mark, no trailing zeros.
 */
export function formatScaledDecimal(value: string, scale: number): string {
  if (!/^-?\d+$/.test(value) || !Number.isInteger(scale) || scale < 0) {
    throw new RangeError('formatScaledDecimal expects a Latin integer string and a scale');
  }
  const negative = value.startsWith('-');
  const digits = (negative ? value.slice(1) : value).padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale).replace(/^0+(?=\d)/, '');
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  const text = fraction ? `${whole}${PERSIAN_DECIMAL_SEPARATOR}${fraction}` : whole;
  return toPersianDigits(negative ? `-${text}` : text);
}

/**
 * What a person typed, as an integer scaled by 10^`scale`, or null when it is
 * not a non-negative number with at most `scale` decimals. Persian,
 * Arabic-Indic and Latin digits and both decimal marks are read; nothing else
 * is guessed at.
 */
export function parseScaledDecimalInput(input: string, scale: number): number | null {
  const normalised = toLatinDigits(input).split(PERSIAN_DECIMAL_SEPARATOR).join('.').trim();
  const match = /^(\d{1,9})(?:\.(\d+))?$/.exec(normalised);
  if (!match) return null;
  const [, whole, fraction = ''] = match;
  if (fraction.length > scale) return null;
  const scaled = Number(`${whole}${fraction.padEnd(scale, '0')}`);
  return Number.isSafeInteger(scaled) ? scaled : null;
}
