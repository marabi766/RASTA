/**
 * The product's Persian is written in standard orthography, hamza included
 * (تأمین، تأیید، مسئول، رئیس). Owner decision 2026-10-24; it replaces the
 * earlier "no hamza" wording rule, which applies to PM reports and Telegram
 * only, never to product text.
 *
 * What a rendered sentence must NOT hold: a combining hamza (U+0654, or U+0655
 * below) on alef, waw or yeh (the precomposed letters أ إ ؤ ئ are the standard
 * spelling; a decomposed one compares unequal to it), and a hamza-less spelling
 * of a word that takes one. A combining hamza on heh is the ezafe
 * («شمارهٔ دارایی») and is the standard spelling, so it is allowed.
 *
 * Order matters. The combining hamza is looked for in the text as written,
 * BEFORE anything is normalised: NFC/NFKC would compose «ا» + U+0654 into «أ»,
 * and stripping marks would delete it, so either step first would turn the
 * non-standard form into a standard one. Only then is the text normalised for
 * word matching.
 */

/** Hamza-less spellings, in Persian letters (ی U+06CC, ک U+06A9); matched as word stems. */
export const HAMZA_LESS_WORDS = [
  'تامین',
  'تایید',
  'تاثیر',
  'تاخیر',
  'تاکید',
  'تاسیس',
  'تالیف',
  'ماخذ',
  'مساله',
  'مسایل',
  'ارایه',
  'مولف',
  'مامور',
  'متاسف',
  'هیات',
  'رییس',
  'مسوول',
  'مسول',
  'جزییات',
] as const;

/** Invisible inside a word: combining marks, format characters (ZWNJ, ZWJ, bidi marks) and tatweel. */
const INVISIBLE = '[\\p{Mn}\\p{Cf}\\u0640]';
/** What may sit between a preceding letter and a word without separating them (ZWNJ does separate). */
const JOINING = '[\\p{Mn}\\u0640\\u200d\\u200e\\u200f\\u061c]';
/** Prefixes a word joins without a ZWNJ (بی‌تأثیر written «بیتاثیر»); a ZWNJ compound needs none. */
const PREFIXES = ['بی', 'نا', 'پر', 'کم', 'با', 'تحت'];

const spelled = (word: string) => [...word].join(`${INVISIBLE}*`);

/**
 * A dictionary word at the start of a word (no Arabic-script letter directly
 * before it, or one of PREFIXES), with any invisible character between its
 * letters, and any ending (تأییدنشده، مسئولیت، هیئت‌ها are stems + suffix).
 * Inside another word it is not matched: «ویتامین، الهیات، ماهیات» are valid.
 */
const HAMZA_LESS = new RegExp(
  `(?<![\\p{sc=Arab}&&\\p{L}]${JOINING}*)` +
    `(?:(?:${PREFIXES.map(spelled).join('|')})${INVISIBLE}*)?` +
    `(?:${HAMZA_LESS_WORDS.map(spelled).join('|')})`,
  'v',
);

/** Letters that never take a combining hamza in standard spelling (after compatibility folding). */
const CARRIERS = new Set(['\u0627', '\u0671', '\u0648', '\u064a', '\u0649', '\u06cc']);
const SKIPPED = new RegExp(`^${INVISIBLE}$`, 'u');

/** A combining hamza on alef, waw or yeh, however many marks sit between them. Raw text only. */
function decomposedHamza(text: string): string | null {
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] !== '\u0654' && text[at] !== '\u0655') continue;
    let base = at - 1;
    while (base >= 0 && SKIPPED.test(text[base] as string)) base -= 1;
    if (base >= 0 && CARRIERS.has((text[base] as string).normalize('NFKC'))) {
      return text.slice(base, at + 1);
    }
  }
  return null;
}

/** Compatibility forms (presentation forms) folded; Arabic yeh and kaf written as the Persian letters. */
function normalised(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u064a\u0649]/gu, '\u06cc')
    .replace(/\u0643/gu, '\u06a9');
}

/** The first non-standard spelling in a text, or null. */
export function nonStandardSpelling(text: string): string | null {
  const decomposed = decomposedHamza(text);
  if (decomposed !== null) return decomposed;
  return HAMZA_LESS.exec(normalised(text))?.[0] ?? null;
}
