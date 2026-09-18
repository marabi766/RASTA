import { PERSIAN_THOUSANDS_SEPARATOR } from './codepoints';

/**
 * Digit conversion — the whole of it, in one place.
 *
 * docs/16 § 16.3 states the rule: numbers in data and in the API are always
 * Latin, and the conversion to Persian happens at the moment of render. Every
 * other module in this application treats a digit as Latin; only this file and
 * its callers in `src/lib/format` know that Persian digits exist.
 *
 * Both directions are needed. Rendering goes Latin → Persian. Input
 * normalisation goes the other way, and has to accept **two** alphabets: a
 * Persian keyboard produces U+06F0–U+06F9, an Arabic one produces
 * U+0660–U+0669, and the two look nearly identical on screen. A form that
 * accepted only the first would reject a number the user can see is correct.
 */

/** U+06F0 … U+06F9 — the Persian (Extended Arabic-Indic) digits. */
const PERSIAN_ZERO = 0x06f0;

/** U+0660 … U+0669 — the Arabic-Indic digits. */
const ARABIC_INDIC_ZERO = 0x0660;

const LATIN_ZERO = 0x30;

/**
 * Rewrites every Latin digit as its Persian counterpart and leaves everything
 * else untouched.
 *
 * Call this on a value that is already formatted for display. Calling it on a
 * value that still has to travel — an identifier, a URL, a form value on its
 * way to the API — is the mistake this whole layer exists to prevent.
 */
export function toPersianDigits(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    out +=
      code >= LATIN_ZERO && code <= LATIN_ZERO + 9
        ? String.fromCodePoint(PERSIAN_ZERO + (code - LATIN_ZERO))
        : char;
  }
  return out;
}

/**
 * Rewrites Persian and Arabic-Indic digits as Latin ones and leaves everything
 * else untouched.
 *
 * This is the first step of every input normalisation in the portal. It is
 * deliberately narrow: it converts digits and nothing else, so a caller that
 * also needs separators stripped has to say so.
 */
export function toLatinDigits(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code >= PERSIAN_ZERO && code <= PERSIAN_ZERO + 9) {
      out += String.fromCodePoint(LATIN_ZERO + (code - PERSIAN_ZERO));
    } else if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) {
      out += String.fromCodePoint(LATIN_ZERO + (code - ARABIC_INDIC_ZERO));
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * Groups a run of Latin digits in threes with the Persian thousands separator.
 *
 * It works on the string, never on a `number`. `10000000` as a `number` is
 * fine; a wallet balance is not, and `Number.MAX_SAFE_INTEGER` is reached by a
 * rial amount long before anyone notices. See `money.ts`.
 */
export function groupDigits(latinDigits: string, separator = PERSIAN_THOUSANDS_SEPARATOR): string {
  if (!/^\d*$/.test(latinDigits)) {
    throw new RangeError(`groupDigits expects Latin digits only, received: ${latinDigits}`);
  }
  let out = '';
  for (let i = 0; i < latinDigits.length; i += 1) {
    const fromEnd = latinDigits.length - i;
    out += latinDigits[i];
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) {
      out += separator;
    }
  }
  return out;
}
