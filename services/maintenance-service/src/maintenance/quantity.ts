/**
 * Exact arithmetic for the quantities a service schedule is evaluated against.
 *
 * Hours and kilometres are NUMERIC(_, 2) in every database that holds them —
 * here, and in fleet-service where they originate — and they cross the wire as
 * strings for the same reason money does (ADR-022). Converting them to
 * JavaScript numbers to do the comparison would give that up at the one step
 * that matters: `4310.1 + 0.2 !== 4310.3`, and a schedule evaluated against a
 * drifting total is a machine that misses its service.
 *
 * So the arithmetic is done in **hundredths, as bigint**. Two decimal places
 * is not an approximation of the column type, it *is* the column type, and
 * bigint addition and comparison are exact by construction.
 *
 * Everything here is pure and total: no clock, no I/O, no throwing on the
 * happy path. A value that cannot be parsed comes back as `null` rather than
 * as an exception, because the callers are an event consumer and a read model
 * — neither of which should die on one malformed field when the correct
 * behaviour is to treat the quantity as absent.
 */

/** A quantity in hundredths of its unit. `43_1050n` is 4310.50 hours. */
export type Hundredths = bigint;

const HUNDRED = 100n;

/**
 * Parses a decimal string into hundredths.
 *
 * Accepts what the platform actually emits — an optionally signed integer or a
 * decimal with up to two places — and nothing else. Anything with more
 * precision is rejected rather than rounded: silently dropping a digit is how
 * a total drifts, which is the thing this module exists to prevent.
 */
export function parseHundredths(value: string | null | undefined): Hundredths | null {
  if (value === null || value === undefined) return null;

  const trimmed = value.trim();
  const match = /^(-?)(\d{1,18})(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;

  const [, sign, whole, fraction = ''] = match;
  const padded = fraction.padEnd(2, '0');
  const magnitude = BigInt(whole) * HUNDRED + BigInt(padded);

  return sign === '-' ? -magnitude : magnitude;
}

/** Renders hundredths back as the two-decimal string the API and events use. */
export function formatHundredths(value: Hundredths): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / HUNDRED;
  const fraction = magnitude % HUNDRED;
  return `${negative ? '-' : ''}${whole}.${fraction.toString().padStart(2, '0')}`;
}

/**
 * Reads a Prisma `Decimal` — or anything else that stringifies to a decimal —
 * as hundredths.
 *
 * Prisma's Decimal is exact in the database and exact in its own arithmetic,
 * but `toNumber()` is not, and it is the method that autocomplete offers
 * first. Routing every read through here means the unsafe conversion never
 * appears in domain code.
 */
export function decimalToHundredths(value: { toString(): string } | null): Hundredths | null {
  if (value === null || value === undefined) return null;
  return parseHundredths(value.toString());
}

/** Whether a quantity is present and strictly positive — what an interval must be. */
export function isPositive(value: Hundredths | null): value is Hundredths {
  return value !== null && value > 0n;
}

/**
 * Parses a decimal string at an arbitrary scale.
 *
 * Part quantities carry three decimals rather than two — half a litre of oil
 * is 0.5, but an eighth of a metre of hose is a real entry — so the two-place
 * parser above is not general enough for them.
 */
export function parseScaled(value: string, decimals: number): bigint | null {
  // Written against one fixed pattern and checked afterwards, rather than
  // building a RegExp from `decimals`. A constructed pattern needs its
  // backslashes doubled inside the template literal, and `\d` in a template
  // literal is silently just `d` — a pattern that then matches nothing a
  // caller would ever notice until a real quantity was rejected.
  const match = /^(-?)(\d{1,18})(?:\.(\d{1,9}))?$/.exec(value.trim());
  if (!match) return null;

  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > decimals) return null;

  const scale = 10n ** BigInt(decimals);
  const magnitude = BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, '0'));

  return sign === '-' ? -magnitude : magnitude;
}

/**
 * A line total: a quantity times a unit price in minor units.
 *
 * Rounded half-up, once, at the end — never per intermediate step. Both
 * operands are exact integers by the time they are multiplied, so the only
 * approximation in the whole calculation is the single deliberate rounding of
 * a fractional rial, and it is applied in the direction a supplier's invoice
 * would.
 *
 * Returns null for a quantity that does not parse, so the caller refuses the
 * line rather than storing a total it silently invented.
 */
export function lineTotalMinor(
  quantity: string,
  unitCostMinor: bigint,
  decimals: number,
): bigint | null {
  const scaled = parseScaled(quantity, decimals);
  if (scaled === null || scaled < 0n) return null;

  const scale = 10n ** BigInt(decimals);
  const product = scaled * unitCostMinor;
  const half = scale / 2n;

  return (product + half) / scale;
}
