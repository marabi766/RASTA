import { z } from 'zod';

/**
 * zod 3's ISO datetime rule, kept after the move to zod 4 (GHSA-mrhx-c7xc-m3w5).
 *
 * zod 4 rewrote the datetime validator: seconds are required wherever a `Z` or
 * an offset follows (`2026-10-24T12:00Z` is refused), and an offset needs its
 * colon (`+0330` is refused). zod 3 accepted both, so a client, a stored value
 * or a signed form written today could stop parsing after the bump, with no
 * type error to notice. The zod 3 pattern below is copied from zod 3.25.76
 * (`src/v3/types.ts`, `datetimeRegex`), and the golden fixtures in
 * `zod-golden.spec.ts` (recorded under zod 3) pin it.
 *
 * Use it where `.datetime()` was: `z.string().check(isoDateTime())`,
 * `z.string().check(isoDateTime({ offset: true }))`. It is zod 4's own datetime
 * format with the pattern swapped, so the issue (`invalid_format`, format
 * `datetime`, zod 3's "Invalid datetime") and the OpenAPI `format: date-time`
 * are unchanged.
 */

const DATE_SOURCE = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;

function timeSource(precision: number | null | undefined): string {
  let seconds = `[0-5]\\d`;
  if (precision) seconds = `${seconds}\\.\\d{${precision}}`;
  else if (precision == null) seconds = `${seconds}(\\.\\d+)?`;
  const quantifier = precision ? '+' : '?'; // seconds required when a precision is given
  return `([01]\\d|2[0-3]):[0-5]\\d(:${seconds})${quantifier}`;
}

export interface IsoDateTimeOptions {
  /** Accept a numeric offset (`+03:30`, `+0330`) as well as `Z`. */
  offset?: boolean;
  /** Accept no zone at all as well. */
  local?: boolean;
  /** Exactly this many fraction digits (zod 3's `precision`). */
  precision?: number | null;
  /** A schema message in place of the default. */
  message?: string;
}

/** zod 3's `datetimeRegex`. */
export function legacyDatetimeRegex(options: IsoDateTimeOptions = {}): RegExp {
  const zones = [options.local ? 'Z?' : 'Z'];
  if (options.offset) zones.push(`([+-]\\d{2}:?\\d{2})`);
  return new RegExp(`^${DATE_SOURCE}T${timeSource(options.precision)}(${zones.join('|')})$`);
}

/** zod 3's `.datetime()` as a zod 4 check: `z.string().check(isoDateTime())`. */
export function isoDateTime(options: IsoDateTimeOptions = {}): z.core.$ZodCheck<string> {
  const { message, ...rule } = options;
  // The params type leaves `pattern` out (zod derives it from the options); the
  // constructor keeps a pattern it is given (`def.pattern ??= …`).
  const params = {
    ...rule,
    ...(message === undefined ? {} : { message }),
    pattern: legacyDatetimeRegex(rule),
  } as z.core.$ZodISODateTimeParams;
  return z.core._isoDateTime(z.ZodISODateTime, params);
}
