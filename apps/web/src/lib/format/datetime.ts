import { tz } from '@date-fns/tz';
import { format } from 'date-fns-jalali';
import { faIR } from 'date-fns-jalali/locale';

import { toPersianDigits } from './digits';

/**
 * Dates, on the browser side.
 *
 * The rule (CLAUDE.md, docs/16 § 16.3) is that storage and the API are always
 * Gregorian UTC, and the Jalali conversion happens at render. This file is
 * where that conversion happens, and nowhere else.
 *
 * The part that is easy to get wrong is the time zone, so it is explicit here
 * rather than inherited. An instant such as `2026-09-18T21:30:00Z` falls on
 * 27 Shahrivar in UTC and on 28 Shahrivar in Tehran. If the formatter used the
 * runtime's own zone, the server would render one date and the browser would
 * render the other — a hydration mismatch that shows up as a flicker and, for
 * a deadline or a due date, as a wrong answer. Passing the zone in makes the
 * output identical wherever it runs.
 */

/**
 * The zone the portal presents dates in.
 *
 * A constant with a name, not a literal scattered through call sites, so a
 * deployment that has to present another zone changes one value. It is not
 * read from the environment here: a module-level environment read would give
 * the server and the browser two different answers, which is the exact failure
 * this module exists to avoid.
 */
export const DISPLAY_TIME_ZONE = 'Asia/Tehran';

export interface DateFormatOptions {
  /** IANA zone the instant is presented in. Defaults to {@link DISPLAY_TIME_ZONE}. */
  readonly timeZone?: string;
  /** Render the digits in Persian. Default `true`. */
  readonly persianDigits?: boolean;
}

/**
 * Turns whatever the caller holds into an instant, or refuses.
 *
 * It throws rather than returning a placeholder. A placeholder would make a
 * malformed timestamp look exactly like an absent one, and the two need
 * different fixes: an absent date is a branch the caller writes, a malformed
 * one is a bug somewhere upstream that should not be allowed to hide.
 */
function toInstant(value: string | number | Date): Date {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError(`Not a valid instant: ${String(value)}`);
  }
  return instant;
}

function render(
  value: string | number | Date,
  pattern: string,
  options: DateFormatOptions,
  withLocale: boolean,
): string {
  const { timeZone = DISPLAY_TIME_ZONE, persianDigits = true } = options;
  const out = format(toInstant(value), pattern, {
    in: tz(timeZone),
    ...(withLocale ? { locale: faIR } : {}),
  });
  return persianDigits ? toPersianDigits(out) : out;
}

/**
 * `۱۴۰۵/۰۶/۲۸` — the compact form, for tables and dense layouts.
 */
export function formatJalaliDate(
  value: string | number | Date,
  options: DateFormatOptions = {},
): string {
  return render(value, 'yyyy/MM/dd', options, false);
}

/**
 * `۲۸ شهریور ۱۴۰۵` — the long form, for headings and single records where the
 * month name removes any doubt about the order of the numbers.
 */
export function formatJalaliDateLong(
  value: string | number | Date,
  options: DateFormatOptions = {},
): string {
  return render(value, 'd MMMM yyyy', options, true);
}

/**
 * `۱۴۰۵/۰۶/۲۸ ۰۱:۰۰` — date and time of day, in 24-hour form.
 */
export function formatJalaliDateTime(
  value: string | number | Date,
  options: DateFormatOptions = {},
): string {
  return render(value, 'yyyy/MM/dd HH:mm', options, false);
}

/**
 * The same instant written the way the API writes it.
 *
 * docs/16 § 16.5 asks for a dual display in the tooltip of a date, so that a
 * user comparing a screen against an exported file or a support ticket can see
 * both readings of one instant. This is the other half of that pair.
 */
export function formatGregorianUtc(value: string | number | Date): string {
  return toInstant(value).toISOString();
}
