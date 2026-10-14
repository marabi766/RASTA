import { z } from 'zod';

/**
 * Timestamps in upstream responses, checked where the response is parsed.
 *
 * `formatJalaliDateLong()` and friends refuse a value `new Date()` cannot read
 * (`lib/format/datetime.ts`), and they throw. A reader whose schema said only
 * `z.string()` therefore let a malformed timestamp through as `OK`, and the
 * page crashed at render instead of showing the fixed malformed-response text —
 * with the upstream value in the exception message. A schema that refuses the
 * value turns the same input into the `MALFORMED` outcome every screen already
 * renders.
 */

function isReadable(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * A full ISO-8601 instant with a zone (`Z` or an offset), that the formatter
 * can also read. A date-only value or a local time without a zone is refused:
 * the contract is an instant, and a zone-less time has no UTC meaning.
 *
 * For services that emit `Date#toISOString()`.
 */
export const utcInstant = z
  .string()
  .datetime({ offset: true })
  .refine(isReadable, 'not a valid instant');

/**
 * Any string the date formatter can render — an instant, or a date-only value
 * (`2026-09-18`) from a field the service types as a date.
 *
 * Exactly the formatter's own test, so a value this accepts cannot make a
 * render throw. Use it where a field may legitimately be date-only; use
 * {@link utcInstant} where the contract is an instant.
 */
export const renderableDate = z.string().refine(isReadable, 'not a valid date');
