import { z } from 'zod';

/**
 * zod 3's ISO datetime rule, kept after the move to zod 4 (GHSA-mrhx-c7xc-m3w5).
 *
 * zod 4 rewrote the datetime validator: seconds are required wherever a `Z` or
 * an offset follows (`2026-10-24T12:00Z` is refused), and an offset needs its
 * colon (`+0330` is refused). zod 3 accepted both, so a client, a stored value
 * or a signed form written today could stop parsing after the bump, with no
 * type error to notice. The zod 3 pattern below is copied from zod 3.25.76
 * (`src/v3/types.ts`, `datetimeRegex`) with bounded offsets and a finite parse check; the golden fixtures in
 * `zod-golden.spec.ts` (recorded under zod 3) pin it.
 *
 * Use it where `.datetime()` was: `z.string().check(isoDateTime())`,
 * `z.string().check(isoDateTime({ offset: true }))`. It is zod 4's own datetime
 * format with the pattern swapped, so the issue (`invalid_format`, format
 * `datetime`, zod 3's "Invalid datetime") and the OpenAPI `format: date-time`
 * are unchanged. Invalid numeric offsets and unparseable instants are refused.
 *
 * `format: date-time` alone (RFC 3339) admits offsets up to ±23:59 and, for the
 * UTC-only form, any offset at all, so a client reading only the format would be
 * refused with no published reason (FU-035). Each check is therefore registered
 * with the zone it accepts ({@link publishedIsoDateTimeZone}), and the OpenAPI
 * converter (`@rasta/nest-common`) publishes it as a `pattern` and a description.
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

/** The zone suffix a check accepts, as published beside `format: date-time` (FU-035). */
export interface IsoDateTimeZone {
  /** Unanchored at the start, so it reads with the format: the value must end like this. */
  pattern: string;
  description: string;
}

const OFFSET_SOURCE = `[+-](?:(?:0\\d|1[0-3]):?[0-5]\\d|14:?00)`;

function zoneOf(options: IsoDateTimeOptions): IsoDateTimeZone {
  const zone = options.offset ? `(?:Z|${OFFSET_SOURCE})` : 'Z';
  const pattern = options.local ? `(?:${zone}|\\d)$` : `${zone}$`;
  // Direction-neutral: the same schema describes request fields (refused with 400) and responses.
  const accepted = options.offset
    ? 'ends in `Z` or a numeric offset within ±14:00 (`+03:30`, `+0330`); an offset beyond ±14:00, which RFC 3339 allows, is invalid here'
    : 'ends in `Z` (UTC); a numeric offset (`+03:30`) is invalid here';
  return {
    pattern,
    description: `ISO 8601 instant that ${accepted}${options.local ? ', or carries no zone' : ''}.`,
  };
}

const ZONES = new WeakMap<object, IsoDateTimeZone>();

/** The zone an `isoDateTime()` check accepts, or `undefined` for any other check. */
export function publishedIsoDateTimeZone(check: object): IsoDateTimeZone | undefined {
  return ZONES.get(check);
}

/** The legacy datetime syntax, with numeric offsets bounded to ±14:00. */
export function legacyDatetimeRegex(options: IsoDateTimeOptions = {}): RegExp {
  const zones = [options.local ? 'Z?' : 'Z'];
  if (options.offset) zones.push(`([+-](?:(?:0\\d|1[0-3]):?[0-5]\\d|14:?00))`);
  return new RegExp(`^${DATE_SOURCE}T${timeSource(options.precision)}(${zones.join('|')})$`);
}

/** zod 3's `.datetime()` as a zod 4 check: `z.string().check(isoDateTime())`. */
export function isoDateTime(options: IsoDateTimeOptions = {}): z.core.$ZodCheck<string> {
  // The params type leaves `pattern` out (zod derives it from the options); the
  // constructor keeps a pattern it is given (`def.pattern ??= …`).
  const params = {
    offset: options.offset ?? false,
    local: options.local ?? false,
    precision: options.precision ?? null,
    message: options.message,
    pattern: legacyDatetimeRegex(options),
  } as z.core.$ZodISODateTimeParams;
  const check = z.core._isoDateTime(z.ZodISODateTime, params);
  const pattern = legacyDatetimeRegex(options);
  check._zod.check = (payload) => {
    if (pattern.test(payload.value) && Number.isFinite(Date.parse(payload.value))) return;
    payload.issues.push({
      code: 'invalid_format',
      format: 'datetime',
      input: payload.value,
      inst: check,
      continue: true,
    });
  };
  ZONES.set(check, zoneOf(options));
  return check;
}
