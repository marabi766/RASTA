import { z } from 'zod';

/**
 * Free text a caller types and other people read: a note, a reason, a name, a
 * licence or reference number.
 *
 * Such text must not carry the Unicode bidirectional controls
 * (`\p{Bidi_Control}`): the embeddings and overrides U+202A–U+202E, the
 * isolates U+2066–U+2069, LRM/RLM U+200E/U+200F and U+061C ARABIC LETTER MARK.
 * They are invisible, and stored in a field shown to someone else they make
 * the text lie about itself — `12‮34` renders as `1243` — so a licence
 * number, a reference or a reason can be spoofed in every list that shows it.
 * U+061C deserves naming: it belongs to the Arabic script, so a pattern that
 * admits `\p{Script=Arabic}` admits it too, and in a Persian-first platform it
 * is the one most likely to arrive. ZWNJ (U+200C), which Persian needs, is not
 * a bidi control and stays allowed.
 *
 * Validation at the boundary, not a business rule (ADR-018): it says which
 * characters a text field may hold, never what the text may say. The refusal
 * message is closed and never repeats the input (S-09).
 */

/** Matches a string holding no bidirectional control at all. */
export const WITHOUT_BIDI_CONTROL = /^[^\p{Bidi_Control}]*$/u;

/** The one message every text refusal uses; it names no character and no value. */
export const UNSUPPORTED_CHARACTERS = 'Contains unsupported characters';

/**
 * A trimmed string that refuses every bidirectional control. Chain the
 * field's own bounds on it: `plainText().min(3).max(500)`.
 */
export function plainText(): z.ZodString {
  return z.string().trim().regex(WITHOUT_BIDI_CONTROL, UNSUPPORTED_CHARACTERS);
}

/**
 * Matches a string holding no control or format character: no C0/C1 control
 * (`\p{Cc}`), no format character (`\p{Cf}` — every bidi control but one, the
 * zero-width characters, the byte-order mark), no line or paragraph separator
 * (U+2028/U+2029), and no bidi control (`\p{Bidi_Control}`, which also names
 * U+061C). Stricter than {@link WITHOUT_BIDI_CONTROL}: an identifier is not
 * prose, so ZWNJ, which Persian text needs, has no place in it either.
 */
export const WITHOUT_CONTROL_CHARACTER = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Bidi_Control}]*$/u;

/**
 * An opaque reference a caller supplies and the platform stores — another
 * service's document id, a resource id. It is never resolved here, but it is
 * shown and compared, so an invisible character in it would make two
 * references look alike that are not. Trimmed; chain the field's own bounds on
 * it: `referenceId().min(1).max(64)`. Same closed message as {@link plainText}.
 */
export function referenceId(): z.ZodString {
  return z.string().trim().regex(WITHOUT_CONTROL_CHARACTER, UNSUPPORTED_CHARACTERS);
}

const BIDI_CONTROL = /\p{Bidi_Control}/u;

/**
 * Whether any string in a JSON-shaped value — an object key or a value, at any
 * depth, inside arrays too — holds a bidi control.
 *
 * Iterative, not recursive: the depth of a parsed request body is bounded only
 * by the body-size limit, and a recursive walk over `[[[[…]]]]` would overflow
 * the stack and answer 500 instead of 400. Each object is visited once.
 */
export function containsBidiControl(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (BIDI_CONTROL.test(current)) return true;
      continue;
    }
    if (current === null || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    for (const [key, item] of Object.entries(current)) {
      if (BIDI_CONTROL.test(key)) return true;
      pending.push(item);
    }
  }
  return false;
}

/**
 * Free-form JSON a caller supplies (metadata, specifications, a policy value)
 * with no bidi control in any key or string value, at any depth. Wraps the
 * field's own schema, so its shape and bounds are unchanged:
 * `withoutBidiControlDeep(z.record(z.unknown()))`. The refusal is the closed
 * {@link UNSUPPORTED_CHARACTERS} message and names neither the key nor the path
 * into the value (S-09).
 */
export function withoutBidiControlDeep<T extends z.ZodTypeAny>(schema: T): z.ZodEffects<T> {
  return schema.superRefine((value, ctx) => {
    if (containsBidiControl(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: UNSUPPORTED_CHARACTERS });
    }
  });
}
