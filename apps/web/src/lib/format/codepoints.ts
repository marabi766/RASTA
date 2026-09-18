/**
 * The characters this layer cannot write as literals.
 *
 * Every entry here is either invisible or confusable. A zero-width non-joiner
 * in source is a character no diff and no reviewer can see. U+066C is a comma
 * to anyone not looking closely, and U+2212 is a hyphen. U+06CC and U+064A are
 * drawn the same and differ only in which keyboard produced them — which is
 * the entire reason `normalizePersianLetters` exists, so writing them as
 * literals in the code that distinguishes them would be self-defeating.
 *
 * So they are named, given their Unicode name in a comment, and built from
 * their code point. The cost is one indirection; what it buys is source in
 * which nothing is hiding.
 */

/** U+200C ZERO WIDTH NON-JOINER — the نیم‌فاصله of docs/16 § 16.3. */
export const ZWNJ = String.fromCodePoint(0x200c);

/** U+200B ZERO WIDTH SPACE. Invisible, and not matched by `\s`. */
export const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

/**
 * U+066C ARABIC THOUSANDS SEPARATOR — the grouping mark Persian typography
 * uses, and the one docs/16 § 16.5 shows in `۱۰٬۰۰۰٬۰۰۰`. Not a comma.
 */
export const PERSIAN_THOUSANDS_SEPARATOR = String.fromCodePoint(0x066c);

/** U+066B ARABIC DECIMAL SEPARATOR. Not a full stop. */
export const PERSIAN_DECIMAL_SEPARATOR = String.fromCodePoint(0x066b);

/**
 * U+2212 MINUS SIGN. Typography, not arithmetic: the ASCII hyphen reads as a
 * dash at the start of a right-to-left line.
 */
export const MINUS_SIGN = String.fromCodePoint(0x2212);

/** U+064A ARABIC LETTER YEH — what an Arabic keyboard produces. */
export const ARABIC_YEH = String.fromCodePoint(0x064a);

/** U+0649 ARABIC LETTER ALEF MAKSURA. */
export const ALEF_MAKSURA = String.fromCodePoint(0x0649);

/** U+06CC ARABIC LETTER FARSI YEH — what Persian wants. */
export const FARSI_YEH = String.fromCodePoint(0x06cc);

/** U+0643 ARABIC LETTER KAF — what an Arabic keyboard produces. */
export const ARABIC_KAF = String.fromCodePoint(0x0643);

/** U+06A9 ARABIC LETTER KEHEH — what Persian wants. */
export const KEHEH = String.fromCodePoint(0x06a9);
