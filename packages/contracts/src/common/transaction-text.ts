import { z } from 'zod';

/**
 * The length bounds of the free text economic-service's transaction commands
 * carry, as one table: economic-service validates its request bodies with
 * them, and a service that forwards its own users' text into those bodies
 * validates that text with them **when it accepts it** (FU-134).
 *
 * A wire contract, like `amountMinorSchema`'s bound — not a business decision
 * (ADR-018). Each service keeps its own character policy (`plainText()`,
 * `z.string()`); only the lengths are shared, because a length the forwarding
 * service accepts and economic-service refuses is not discovered until the
 * money path runs. marketplace-service accepted a dispute's REFUND resolution
 * up to 1000 characters and the saga sent it as the refund's `reason`, which
 * economic-service bounds at 500: the refund was refused, the saga ended with
 * the funds held and the order stayed `CANCELLING`. Copied numbers drift; one
 * table cannot.
 *
 * Lengths are counted the way zod's `.min()`/`.max()` count them — code
 * points of the trimmed string (zod 4; PostgreSQL's `char_length` agrees) —
 * on both sides, since both validate with the one catalog zod (checklist H-17).
 */
export interface TextBounds {
  readonly min: number;
  readonly max: number;
}

export const TRANSACTION_TEXT_BOUNDS = {
  /** `POST /v1/transactions/{id}/dispute` — `reason`. */
  disputeReason: { min: 10, max: 1000 },
  /** `POST /v1/transactions/{id}/resolve-dispute` — `resolution`. */
  disputeResolution: { min: 10, max: 1000 },
  /** `POST /v1/transactions/{id}/refund` and `/cancel` — `reason`. */
  closingReason: { min: 3, max: 500 },
} as const satisfies Record<string, TextBounds>;

/**
 * `schema` bounded to `bounds`: `textWithin(plainText(), TRANSACTION_TEXT_BOUNDS.closingReason)`.
 * Chain it on a trimming schema, so the trimmed text is what is counted.
 */
export function textWithin(schema: z.ZodString, bounds: TextBounds): z.ZodString {
  return schema.min(bounds.min).max(bounds.max);
}

/**
 * The bounds of a text that is forwarded into every one of `bounds`: the
 * largest minimum and the smallest maximum. Throws when they leave no length
 * at all — a field that can be sent nowhere is a contract error, found when
 * the schema module loads rather than by a caller.
 */
export function boundsForAll(...bounds: readonly TextBounds[]): TextBounds {
  if (bounds.length === 0) throw new Error('boundsForAll needs at least one bound');
  const min = Math.max(...bounds.map((bound) => bound.min));
  const max = Math.min(...bounds.map((bound) => bound.max));
  if (min > max) throw new Error(`No length satisfies every bound (min ${min} > max ${max})`);
  return { min, max };
}

/**
 * Whether `text`, as it will be sent, is within `bounds`. Asks zod's own check
 * rather than `text.length`, which counts UTF-16 units: one counting, the one
 * {@link textWithin} applies on the receiving side, by construction.
 */
export function isWithin(text: string, bounds: TextBounds): boolean {
  return textWithin(z.string(), bounds).safeParse(text).success;
}
