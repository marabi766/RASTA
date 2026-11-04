import {
  MINUS_SIGN,
  PERSIAN_DECIMAL_SEPARATOR,
  PERSIAN_THOUSANDS_SEPARATOR,
  ZERO_WIDTH_SPACE,
  ZWNJ,
} from './codepoints';
import { formMessage } from '../form-issues';

import { groupDigits, toLatinDigits, toPersianDigits } from './digits';

/**
 * Money, on the browser side.
 *
 * The platform rule (CLAUDE.md, docs/16 § 16.5) is short and absolute: money
 * is a `bigint` of minor units, it crosses the API as a **string**, and it is
 * never a `float`. `parseFloat` does not appear in this file and must not
 * appear anywhere that handles an amount — `0.1 + 0.2` is the reason, and a
 * ledger that is out by a rial is a ledger nobody can reconcile.
 *
 * So: strings in, `bigint` in the middle, strings out.
 */

/**
 * How one currency is written.
 *
 * `fractionDigits` is the number of decimal places the *display* carries, and
 * therefore the scale between the stored minor unit and the amount a person
 * reads. The Iranian rial is quoted whole, which is why docs/16 § 16.5 shows
 * `"10000000"` arriving from the API and `۱۰٬۰۰۰٬۰۰۰ ریال` reaching the
 * screen with no shift.
 *
 * It is a value, not a constant in the code, because the platform is
 * organization-agnostic and a second currency must not require an edit here.
 */
export interface CurrencyFormat {
  /** ISO 4217 code, as the API uses it. */
  readonly code: string;
  /** What a Persian reader sees after the amount. */
  readonly label: string;
  /** Decimal places between the stored minor unit and the displayed amount. */
  readonly fractionDigits: number;
}

export const IRR: CurrencyFormat = {
  code: 'IRR',
  label: 'ریال',
  fractionDigits: 0,
};

/** Why a typed amount could not be read: a closed set, so no sentence quotes what was typed. */
export type MoneyInputFailure = 'EMPTY' | 'NOT_NUMERIC' | 'NO_DIGITS' | 'TOO_MANY_DECIMALS';

/**
 * The sentence for a failure: fixed words, parameterised only by the
 * currency (the portal's own constant), never by the input — a typed amount
 * may carry anything, a bidi control included (Codex PR-439 r1 F1). Declared
 * with `formMessage`, so a schema that refuses with it is shown as written.
 */
export function moneyInputMessage(failure: MoneyInputFailure, currency: CurrencyFormat): string {
  switch (failure) {
    case 'EMPTY':
      return formMessage('مبلغ را وارد کنید');
    case 'NOT_NUMERIC':
      return formMessage('مبلغ فقط از رقم تشکیل می‌شود');
    case 'NO_DIGITS':
      return formMessage('مبلغ رقمی ندارد');
    case 'TOO_MANY_DECIMALS':
      return currency.fractionDigits === 0
        ? formMessage(`مبلغ به ${currency.label} جزء اعشاری ندارد`)
        : formMessage(
            `حداکثر ${toPersianDigits(String(currency.fractionDigits))} رقم اعشار پذیرفته می‌شود`,
          );
  }
}

/**
 * Raised when a typed amount cannot be read as one.
 *
 * A distinct type rather than a bare `Error`, so a form can catch exactly this
 * and show the field message, and so an unexpected failure somewhere else in
 * the call is not quietly reported to the user as "invalid amount". It holds
 * the closed `failure` and its fixed sentence only: the input stays out of the
 * exception, so no message, log line or `cause` chain can carry it
 * (AGENTS.md disclosure rule; PR-439 r1 addendum B).
 */
export class MoneyInputError extends Error {
  constructor(
    readonly failure: MoneyInputFailure,
    currency: CurrencyFormat,
  ) {
    super(moneyInputMessage(failure, currency));
    this.name = 'MoneyInputError';
  }
}

export interface FormatMoneyOptions {
  /** Append the currency label. Default `true`. */
  readonly withLabel?: boolean;
  /** Render the digits in Persian. Default `true`. */
  readonly persianDigits?: boolean;
}

/**
 * Formats minor units for display.
 *
 * @param minorUnits the amount exactly as the API sent it — a decimal string,
 *   optionally signed, or a `bigint`. A `number` is not accepted, and that is
 *   the point.
 */
export function formatMoney(
  minorUnits: string | bigint,
  currency: CurrencyFormat = IRR,
  options: FormatMoneyOptions = {},
): string {
  const { withLabel = true, persianDigits = true } = options;

  const raw = typeof minorUnits === 'bigint' ? minorUnits.toString() : minorUnits.trim();
  if (!/^-?\d+$/.test(raw)) {
    throw new RangeError(
      `formatMoney expects a whole number of minor units as a string, received: ${raw}`,
    );
  }

  const negative = raw.startsWith('-');
  const magnitude = negative ? raw.slice(1) : raw;

  let body: string;
  if (currency.fractionDigits === 0) {
    body = groupDigits(magnitude);
  } else {
    const padded = magnitude.padStart(currency.fractionDigits + 1, '0');
    const cut = padded.length - currency.fractionDigits;
    body = groupDigits(padded.slice(0, cut)) + PERSIAN_DECIMAL_SEPARATOR + padded.slice(cut);
  }

  const signed = negative ? `${MINUS_SIGN}${body}` : body;
  const withDigits = persianDigits ? toPersianDigits(signed) : signed;
  return withLabel ? `${withDigits} ${currency.label}` : withDigits;
}

/**
 * Everything a person might type between the digits of an amount: the Persian
 * grouping mark, an ASCII comma, any whitespace, and the zero-width marks that
 * arrive with a paste. All of it is noise, and none of it changes the value.
 */
const GROUPING_NOISE = new RegExp(
  `[${PERSIAN_THOUSANDS_SEPARATOR},\\s${ZWNJ}${ZERO_WIDTH_SPACE}]`,
  'g',
);

/**
 * Reads what a person typed and returns minor units.
 *
 * Accepts Persian, Arabic-Indic and Latin digits; the Persian thousands
 * separator, the ASCII comma and ordinary spaces as grouping; both decimal
 * marks; and either sign character. Rejects everything else rather than
 * guessing — an amount quietly read as something other than what was typed is
 * the worst outcome available here.
 *
 * @throws {MoneyInputError} when the input is not an amount.
 */
export function parseMoneyInput(input: string, currency: CurrencyFormat = IRR): bigint {
  const normalised = toLatinDigits(input)
    .replace(GROUPING_NOISE, '')
    .split(MINUS_SIGN)
    .join('-')
    .split(PERSIAN_DECIMAL_SEPARATOR)
    .join('.')
    .trim();

  if (normalised === '' || normalised === '-') {
    throw new MoneyInputError('EMPTY', currency);
  }

  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(normalised);
  if (!match) {
    throw new MoneyInputError('NOT_NUMERIC', currency);
  }

  const [, sign, wholePart, fractionPart] = match;
  const whole = wholePart === '' ? '0' : wholePart;
  const fraction = fractionPart ?? '';

  if (wholePart === '' && fraction === '') {
    throw new MoneyInputError('NO_DIGITS', currency);
  }

  if (fraction.length > currency.fractionDigits) {
    throw new MoneyInputError('TOO_MANY_DECIMALS', currency);
  }

  const scaled = whole + fraction.padEnd(currency.fractionDigits, '0');
  const value = BigInt(scaled);
  return sign === '-' ? -value : value;
}
