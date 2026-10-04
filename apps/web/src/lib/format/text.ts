import {
  ALEF_MAKSURA,
  ARABIC_KAF,
  ARABIC_YEH,
  FARSI_YEH,
  KEHEH,
  ZERO_WIDTH_SPACE,
  ZWNJ,
} from './codepoints';

/**
 * Persian text handling.
 *
 * Two problems live here, and they pull in opposite directions.
 *
 * The first is that Persian and Arabic share a script but not an alphabet. A
 * user typing on an Arabic keyboard produces U+064A ARABIC LETTER YEH and
 * U+0643 ARABIC LETTER KAF where Persian wants U+06CC and U+06A9. The two
 * pairs are drawn nearly identically, so a name stored one way and searched
 * the other never matches, and nobody can see why. Normalising on the way in
 * fixes it once.
 *
 * The second is direction. A Latin identifier inside a Persian sentence —
 * a plate number, an order code, an email — is laid out by the bidirectional
 * algorithm, and without an isolating boundary its trailing punctuation jumps
 * to the wrong end of the run. docs/16 § 16.3 makes `dir="auto"` the rule for
 * exactly this, and `IsolatedText` / `Identifier` in `src/ui/text` is where it
 * is applied — together with {@link withoutBidiControls}.
 */

export { ZWNJ };

const ARABIC_TO_PERSIAN: ReadonlyArray<readonly [string, string]> = [
  [ARABIC_YEH, FARSI_YEH],
  [ALEF_MAKSURA, FARSI_YEH],
  [ARABIC_KAF, KEHEH],
];

/**
 * Rewrites Arabic letter forms as their Persian counterparts.
 *
 * Use it on values arriving from a keyboard, a paste or an import, before they
 * are compared or stored. It does **not** touch digits: those are
 * `toLatinDigits`, and mixing the two would hide which normalisation a caller
 * actually asked for.
 */
export function normalizePersianLetters(value: string): string {
  return ARABIC_TO_PERSIAN.reduce(
    (text, [arabic, persian]) => text.split(arabic).join(persian),
    value,
  );
}

/**
 * Collapses the whitespace a user cannot see.
 *
 * Pasted Persian text routinely carries no-break spaces, zero-width spaces and
 * byte order marks that survive a `trim()` and then break an equality check
 * that looks obviously true.
 *
 * A zero-width **non-joiner** is deliberately kept, and keeping it needs no
 * exception: `\s` does not match U+200C. That matters, because it is a
 * letter-forming mark in Persian rather than whitespace, and removing it turns
 * «می‌شود» into «میشود». U+200B is the one invisible space `\s` also misses,
 * which is why it is handled on its own line.
 */
export function collapseWhitespace(value: string): string {
  return value.split(ZERO_WIDTH_SPACE).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * The normalisation a text input should apply before the value is compared,
 * stored or sent.
 */
export function normalizePersianText(value: string): string {
  return collapseWhitespace(normalizePersianLetters(value));
}

/**
 * Whether a string contains a run of Latin letters or digits.
 *
 * This is what tells a caller that a value needs directional isolation. It is
 * a question about the text, not about the markup, which is why it lives here
 * and the `<bdi>` lives in the component.
 */
export function containsLatin(value: string): boolean {
  return /[A-Za-z0-9]/.test(value);
}

/**
 * The Unicode `Bidi_Control` set: ALM, LRM and RLM, the embeddings and
 * overrides, the isolates. The property rather than a list, so it cannot fall
 * behind the Unicode Character Database (Codex post-merge review of #106).
 * The forms refuse it on the way in (`server/drivers.ts` re-exports this one
 * constant); {@link withoutBidiControls} drops it on the way out.
 */
export const BIDI_CONTROL = /\p{Bidi_Control}/u;

/**
 * Stored text without its bidi controls, for display (L5-06, #220).
 *
 * `<bdi>` isolates a run from the text around it, but an override inside the
 * run still reorders the run itself — `12‮34` still reads `1243`. The services
 * refuse these characters now, but a value stored before that, or written by
 * another client, still holds them; dropped here, it shows the characters in
 * the order they were typed. ZWNJ is not a bidi control and is kept.
 */
export function withoutBidiControls(value: string): string {
  return value.replace(new RegExp(BIDI_CONTROL.source, 'gu'), '');
}

/**
 * Joins Persian word parts with a zero-width non-joiner.
 *
 * «می‌شود», «نیم‌فاصله», «به‌روزرسانی» — docs/16 § 16.3 requires the mark, and
 * a helper is better than an invisible character sitting in a string literal
 * where no reviewer can see it.
 */
export function joinWithZwnj(...parts: readonly string[]): string {
  return parts.filter((part) => part !== '').join(ZWNJ);
}
