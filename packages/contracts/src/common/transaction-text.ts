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
 * on both sides, since both validate with the one catalog zod (checklist H-17),
 * and **with LF line endings** (checklist H-16, PR-806 r1 F1): a browser sends
 * a textarea's line breaks as CRLF, and the same words counted with CRLF were
 * refused at a length their LF form fits, and hashed as another request.
 * {@link textWithin} — the service that accepts a person's text — makes the
 * text LF, so what it counts, hashes, stores and forwards is that form;
 * {@link keptTextWithin} — economic-service, which keeps the text as sent until
 * FU-115 — counts the LF form and keeps the value.
 *
 * Each service compiles the table in, so a change rolls out in order: a bound
 * raised ships to economic-service first, a bound lowered to the forwarding
 * services first — never a window in which one accepts what the other refuses.
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

/** `text` with every CRLF and lone CR made LF — the one form transaction text is counted in. */
export function withLfLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * `schema` bounded to `bounds`, **its value made LF** first:
 * `textWithin(plainText(), TRANSACTION_TEXT_BOUNDS.closingReason)`. The text a
 * service accepts from a person and forwards: what it counts, hashes, stores
 * and sends on is the LF form, so CRLF and LF spellings of the same words are
 * one request with one length. Chain it on a trimming schema, so the trimmed
 * text is what is counted.
 */
export function textWithin(schema: z.ZodString, bounds: TextBounds): z.ZodString {
  return schema.overwrite(withLfLineEndings).min(bounds.min).max(bounds.max);
}

/** Whether `text`, counted as sent (no line-ending change), passes `schema`. */
const passesAsSent = (schema: z.ZodString, text: string) => schema.safeParse(text).success;

/**
 * `schema` bounded to `bounds` with **its value kept as sent**, for the
 * receiving service that stores the text as sent (economic-service, until
 * FU-115's readers-first rollout lets it store LF; docs/06 § 6.8). Accepted
 * when the text is within `bounds` counted with LF line endings, as
 * {@link textWithin} counts what the forwarding service sends — or counted as
 * sent, the previous release's count: a text that release accepted is never
 * refused now, so a dispute marketplace committed with a CRLF reason of
 * exactly the minimum (one unit shorter with LF) is never a permanent 400 on
 * its saga's retry. Refused only when both counts refuse, with the previous
 * release's own refusal (`too_small`/`too_big`, same message). The idempotency
 * hash of the LF form is economic-service's `canonicalBodyPipe` (#747).
 */
export function keptTextWithin(schema: z.ZodString, bounds: TextBounds): z.ZodString {
  const atLeast = z.string().min(bounds.min);
  const atMost = z.string().max(bounds.max);
  // A custom check publishes no `minLength`/`maxLength`, and a raw bound would
  // be false here (a CRLF text one unit over is accepted; FU-120 drops bounds a
  // transform makes unprovable): the description states the rule instead.
  const rule =
    `${bounds.min} to ${bounds.max} characters (code points) after trimming, ` +
    'line endings counted as LF.';
  return schema
    .superRefine((text, ctx) => {
      if (isWithin(text, bounds)) return;
      // The issue `.min()`/`.max()` raise, without reading a zod error (the
      // legacy-refusal boundary, PR #444): zod's own message fills it in.
      if (!passesAsSent(atLeast, text)) {
        ctx.addIssue({
          code: 'too_small',
          origin: 'string',
          minimum: bounds.min,
          inclusive: true,
          input: text,
        });
      } else if (!passesAsSent(atMost, text)) {
        ctx.addIssue({
          code: 'too_big',
          origin: 'string',
          maximum: bounds.max,
          inclusive: true,
          input: text,
        });
      }
    })
    .describe(rule);
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
 * Whether `text`, counted as {@link textWithin} counts it — LF line endings,
 * code points — is within `bounds`. Asks zod's own check rather than
 * `text.length`, which counts UTF-16 units: one counting, by construction.
 */
export function isWithin(text: string, bounds: TextBounds): boolean {
  return textWithin(z.string(), bounds).safeParse(text).success;
}
