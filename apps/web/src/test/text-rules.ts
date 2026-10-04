import { z } from 'zod';

/**
 * Probes for the two platform text rules a portal form copies — `plainText()`
 * and `referenceId()` from `@rasta/contracts` — so a contract spec can show
 * the form's field refuses exactly the characters the service's does, rather
 * than only that the service's source still names the rule.
 *
 * Every invisible character is built from its number, never written as a
 * literal a reviewer could miss.
 */

/** Every `Bidi_Control` code point in Unicode 15/16. */
export const BIDI_CONTROL_CODE_POINTS = [
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
] as const;

/**
 * Controls and format characters that are not bidi controls: `plainText()`
 * admits them, `referenceId()` does not. ZWNJ is first because Persian prose
 * needs it and an identifier does not.
 */
export const OTHER_INVISIBLE_CODE_POINTS = [
  0x200c, // ZWNJ
  0x200d, // ZWJ
  0xfeff, // byte-order mark
  0x00ad, // soft hyphen
  0x0009, // tab
  0x2028, // line separator
] as const;

/** `sample` with the code point put after its second character. */
export const withCodePoint = (sample: string, codePoint: number): string =>
  `${sample.slice(0, 2)}${String.fromCodePoint(codePoint)}${sample.slice(2)}`;

/** Each code point in `codePoints` inside `sample`, plus `sample` itself. */
export function probesFrom(sample: string, codePoints: readonly number[]): string[] {
  return [sample, ...codePoints.map((codePoint) => withCodePoint(sample, codePoint))];
}

/** The schema of one key of a form schema, through its refinements and transforms. */
export function formField(schema: z.ZodTypeAny, key: string): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  while (current instanceof z.ZodEffects) current = current.innerType();
  const field = (current as z.AnyZodObject).shape?.[key] as z.ZodTypeAny | undefined;
  if (!field) throw new Error(`the form schema has no \`${key}\``);
  return field;
}
