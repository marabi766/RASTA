/**
 * Presentation-layer conversions. Nothing here changes a value; it changes how
 * a value is written.
 *
 * Two platform rules meet in this file:
 *
 *  - **Money never becomes a number** (ADR-022, docs/16 § 16.5). Amounts arrive
 *    as decimal strings of integer minor units precisely so they survive
 *    figures past `Number.MAX_SAFE_INTEGER` — about 9.007e15 rial, a number a
 *    provincial budget reaches. Every function below operates on the string.
 *    There is no `parseFloat`, no `Number()`, no arithmetic.
 *  - **Latin digits in data, Persian digits at the last moment** (docs/16
 *    § 16.3). Conversion happens here, at render time, and never on the way
 *    into a request.
 */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;

/** U+066C ARABIC THOUSANDS SEPARATOR — the correct grouping mark in Persian. */
const GROUP_SEPARATOR = '٬';

const INTEGER_PATTERN = /^-?\d+$/;

export class NotAnIntegerStringError extends Error {
  constructor(value: string) {
    super(`Expected an integer string in minor units, received ${JSON.stringify(value)}`);
    this.name = 'NotAnIntegerStringError';
  }
}

/** Latin digits → Persian digits. Leaves every other character alone. */
export function toPersianDigits(value: string): string {
  let out = '';
  for (const character of value) {
    const index = character.charCodeAt(0) - 48;
    out += index >= 0 && index <= 9 ? PERSIAN_DIGITS[index] : character;
  }
  return out;
}

/** Persian and Arabic-Indic digits → Latin. Used when normalizing user input. */
export function toLatinDigits(value: string): string {
  let out = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code >= 0x06f0 && code <= 0x06f9) out += String.fromCharCode(code - 0x06f0 + 48);
    else if (code >= 0x0660 && code <= 0x0669) out += String.fromCharCode(code - 0x0660 + 48);
    else out += character;
  }
  return out;
}

/**
 * Inserts thousands separators into a decimal integer **string**.
 *
 * Implemented on the string rather than with `toLocaleString`, because the
 * latter needs a `number` and that is the exact conversion this file exists to
 * avoid.
 */
export function groupDigits(integerString: string): string {
  if (!INTEGER_PATTERN.test(integerString)) throw new NotAnIntegerStringError(integerString);

  const negative = integerString.startsWith('-');
  const digits = negative ? integerString.slice(1) : integerString;

  let grouped = '';
  for (let index = 0; index < digits.length; index += 1) {
    const fromEnd = digits.length - index;
    if (index > 0 && fromEnd % 3 === 0) grouped += GROUP_SEPARATOR;
    grouped += digits[index];
  }

  return negative ? `-${grouped}` : grouped;
}

const CURRENCY_LABELS: Record<string, string> = { IRR: 'ریال' };

/**
 * Renders an amount for display.
 *
 * IRR has no subdivision in practice — one minor unit is one rial
 * (`packages/contracts/src/common/money.ts`) — so there is no decimal point to
 * place and no exponent to apply. If a currency with minor units is ever added,
 * this is the function that has to learn about it, and the string stays a
 * string while it does.
 */
export function formatMoneyMinor(amountMinor: string, currency = 'IRR'): string {
  const label = CURRENCY_LABELS[currency] ?? currency;
  return `${toPersianDigits(groupDigits(amountMinor))} ${label}`;
}

/**
 * A year, ungrouped.
 *
 * `formatInteger(2019)` renders «۲٬۰۱۹», which is correct for a quantity and
 * wrong for a year — a thousands separator in a calendar year reads as a count
 * of two thousand and nineteen somethings. Years are identifiers, not amounts.
 */
export function formatYear(year: number): string {
  return toPersianDigits(String(Math.trunc(year)));
}

/** A plain integer for display: counts, days, quantities. */
export function formatInteger(value: number | string): string {
  const asString = typeof value === 'number' ? String(Math.trunc(value)) : value;
  return toPersianDigits(groupDigits(asString));
}

/**
 * Gregorian/UTC in, Persian (Hijri-Shamsi) out.
 *
 * Storage and transport stay ISO-8601 UTC; the calendar conversion happens
 * here and nowhere else (docs/16 § 16.3). `Intl` does the arithmetic, so there
 * is no hand-rolled calendar to get wrong.
 */
export function formatJalaliDate(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

/** Adds the time of day to `formatJalaliDate`, for records precise to the second. */
export function formatJalaliDateTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/**
 * Converts between an ISO-8601 UTC instant and an `<input type="datetime-local">`
 * value, treating the picker as a **UTC** picker rather than the browser's local
 * time.
 *
 * `datetime-local` carries no timezone by design, so the alternative —
 * `new Date(value)`, which the spec defines as local time — would silently
 * shift every audit window by the presenter's UTC offset. Labelling the field
 * "UTC" and converting literally keeps the value a presenter types the exact
 * value the API receives, which matters more here than anywhere else in this
 * application: AGENTS.md requires UTC storage, and a query window that is
 * wrong by a timezone is wrong in a way this screen exists to make impossible.
 */
export function isoToUtcInputValue(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 16);
}

/** The inverse of `isoToUtcInputValue`. `value` is `YYYY-MM-DDTHH:mm`, UTC. */
export function utcInputValueToIso(value: string): string {
  return `${value}:00.000Z`;
}
