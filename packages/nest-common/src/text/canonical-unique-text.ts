import { z } from 'zod';

/**
 * The one canonical form of human-typed text that a uniqueness constraint compares (FU-084).
 *
 * A unique index compares bytes. Two values a person cannot tell apart — one typed with the Arabic
 * ي or ك, with Persian or Arabic-Indic digits, a tatweel, a presentation form, a zero-width joiner,
 * a combining grapheme joiner (U+034F) or a bidi mark — would both be stored, and the index would
 * hold two "identical" names. So the value is folded here, at the input boundary, and what is not
 * provably in the one form is refused by naming what is allowed: a character Unicode adds tomorrow,
 * or one nobody listed, stays out. The approach is #677's (`deduction_rule_name_is_canonical`).
 *
 * Every service that adopts it writes the same SQL in its own migration (database ownership per
 * service) and runs an integration test comparing it with {@link isCanonicalUniqueText} and
 * {@link uniqueTextKey} over every code point, so the application and PostgreSQL cannot disagree.
 *
 * The form:
 *   * printable ASCII, the Persian alphabet with its hamza letters, and ، ؛ ؟ ٪ « ». Digits are
 *     Latin (CLAUDE.md); the Arabic ي ى ك, tatweel and presentation forms are folded first, and no
 *     other script is admitted, so a lookalike cannot be spelled at all;
 *   * one space between words, none at either end;
 *   * the only mark is U+0654, the hamza of the ezafe, only after heh;
 *   * the only invisible character is the half-space (U+200C), only between Persian letters. It is
 *     not part of the key: after ر or ا it does not even change the drawing.
 *
 * Length is the field's own bound, counted in code points by its caller.
 */
const LETTERS =
  '\\u0621-\\u063A\\u0641\\u0642\\u0644-\\u0648\\u067E\\u0686\\u0698\\u06A9\\u06AF\\u06CC';
const ONLY_ALLOWED = new RegExp(
  `^[\\u0654\\u0020-\\u007E\\u00AB\\u00BB\\u060C\\u061B\\u061F\\u066A${LETTERS}\\u200C]+$`,
  'u',
);
const BLANK_OUT_OF_PLACE = /^[\u0020\u200c]|[\u0020\u200c]$|[\u0020\u200c]{2}/u;
const MARK_OUT_OF_PLACE = /(^|[^\u0647])\u0654/u;
const HALF_SPACE_OUT_OF_PLACE = new RegExp(
  `(^|[^\\u0654${LETTERS}])\\u200C|\\u200C($|[^${LETTERS}])`,
  'u',
);

/** Whether `candidate` is already in the one form; the migrations' `*_text_is_canonical`. */
export function isCanonicalUniqueText(candidate: string): boolean {
  return (
    ONLY_ALLOWED.test(candidate) &&
    !BLANK_OUT_OF_PLACE.test(candidate) &&
    !MARK_OUT_OF_PLACE.test(candidate) &&
    !HALF_SPACE_OUT_OF_PLACE.test(candidate)
  );
}

/** A–Z to a–z and nothing else: the one case fold, the same in every locale and in SQL `translate`. */
export function foldAsciiCase(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

export interface CanonicalUniqueTextOptions {
  /**
   * Required, so no caller gets a fold by omission: `true` for a login name, where `Ali` and `ali`
   * are one person; `false` for a code an authority issues, where case may be meant.
   */
  caseFold: boolean;
}

/**
 * What keyboards vary without anyone meaning a difference, folded: presentation and compatibility
 * forms, the Arabic ي ى ك, ۀ, Persian and Arabic-Indic digits, tatweel, blank runs; then A–Z when
 * `caseFold`. Nothing is refused here, so this alone is not the form: {@link canonicalUniqueText}
 * holds the result to it, and a search reads it through {@link uniqueTextSearchKey}.
 */
export function foldUniqueText(raw: string, options: CanonicalUniqueTextOptions): string {
  const folded = raw
    // Presentation forms and compatibility characters, other blanks, and composed letters.
    .normalize('NFKC')
    .replace(/[\u064a\u0649]/g, '\u06cc')
    .replace(/\u0643/g, '\u06a9')
    .replace(/\u06c0/g, '\u0647\u0654')
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\u0640/g, '')
    .replace(/[\t\n\v\f\r ]+/g, ' ')
    .replace(/^ | $/g, '');
  return options.caseFold ? foldAsciiCase(folded) : folded;
}

/**
 * The value in its one form, or `null` if it has none. What keyboards vary without anyone meaning a
 * difference is folded; anything else invisible is refused rather than removed, since the person
 * never saw what would be dropped.
 */
export function canonicalUniqueText(
  raw: string,
  options: CanonicalUniqueTextOptions,
): string | null {
  const text = foldUniqueText(raw, options);
  return isCanonicalUniqueText(text) ? text : null;
}

/** What makes two canonical values one value: the migrations' `*_text_key`. */
export function uniqueTextKey(canonical: string): string {
  return canonical.replace(/\u200c/g, '');
}

/**
 * What a search for `raw` looks for inside the keys of stored values (FU-084 r2): the same fold the
 * write applied, then the same key. Every read of a uniqueness-compared field goes through the fold
 * — an exact read through {@link canonicalUniqueText}, a substring search through this — so a value
 * is found by the spelling it was created with. Nothing is refused: a search term may be a fragment
 * of a value (one starting with a half-space, say) that is not itself in the form, and a term that
 * folds to something no stored key holds simply finds nothing.
 */
export function uniqueTextSearchKey(raw: string, options: CanonicalUniqueTextOptions): string {
  return uniqueTextKey(foldUniqueText(raw, options));
}

/** The closed refusal: it names no character and repeats no input (S-09). */
export const NOT_CANONICAL_TEXT = 'Contains unsupported characters';

/**
 * A request field compared for uniqueness: canonicalised, or refused with the closed message. Chain
 * the field's own bounds after it: `uniqueText({ caseFold: false }).pipe(z.string().min(1).max(64))`.
 */
export function uniqueText(options: CanonicalUniqueTextOptions) {
  return z.string().transform((raw, ctx) => {
    const canonical = canonicalUniqueText(raw, options);
    if (canonical === null) {
      ctx.addIssue({ code: 'custom', message: NOT_CANONICAL_TEXT });
      return z.NEVER;
    }
    return canonical;
  });
}
