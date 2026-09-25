/**
 * Canonical form of a text value that takes part in a uniqueness check.
 *
 * Persian text reaches the platform from several keyboards. The same plate or
 * policy number can arrive with an Arabic yeh (ي U+064A, ى U+0649) or kaf
 * (ك U+0643) in place of the Persian ی and ک, with Persian (۰–۹) or Arabic-Indic
 * (٠–٩) digits, with presentation-form code points, or with a decorative
 * tatweel (ـ). Every one of these looks identical on screen and compares
 * unequal in the database. Without this step, a lookup misses its duplicate
 * and the unique index sees two different values (audit L3-10).
 *
 * The value is canonicalised once, at the input boundary, and stored in that
 * form. Lookups and the index then compare like with like. Digits become Latin
 * because data and APIs carry Latin digits; Persian digits are a presentation
 * concern (CLAUDE.md).
 *
 * Deliberately not done: case folding, and removing ZWNJ or punctuation. Both
 * would merge values that a person may intend as different identifiers.
 */
export function canonicalIdentifier(value: string): string {
  return (
    value
      // Presentation forms and compatibility characters fold to their base letters.
      .normalize('NFKC')
      .replace(/[يى]/g, 'ی')
      .replace(/ك/g, 'ک')
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/ـ/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
