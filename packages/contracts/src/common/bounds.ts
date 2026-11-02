import { z } from 'zod';

/**
 * Caps how many keys a free-form object (a `z.record`) may carry, and refuses
 * an object over the cap **before a single entry is parsed**.
 *
 * Why before: a record parses every entry and collects one issue per failing
 * one, so the cost of a refusal grows with what the caller sent
 * (GHSA-mrhx-c7xc-m3w5 is the same flaw for arrays). zod has no key-count
 * check of its own (zod 4.6.6+ caps arrays, sets and maps, not records), and a
 * `.refine` runs only after every entry was parsed. A preprocess step runs
 * first, and a zod 4 pipe stops at any issue from its input side, so the
 * record is never reached.
 *
 * Only the keys are counted — no value is read. Anything that is not a plain
 * object passes through untouched, so the record's own `invalid_type` refusal
 * is unchanged. The message names the cap and nothing the caller sent (S-09).
 *
 * Wrap the record itself, inside any refinement over the whole value:
 * `withoutBidiControlDeep(withMaxKeys(z.record(z.unknown()), 100))`.
 */
export function withMaxKeys<T extends z.ZodTypeAny>(
  schema: T,
  max: number,
): z.ZodPreprocess<T, unknown> {
  return z.preprocess((value, ctx) => {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      if (Object.keys(value).length > max) {
        ctx.addIssue({
          code: 'custom',
          message: `Expected at most ${max} keys`,
          continue: false,
        });
      }
    }
    return value;
  }, schema);
}
