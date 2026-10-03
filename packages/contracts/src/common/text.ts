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
