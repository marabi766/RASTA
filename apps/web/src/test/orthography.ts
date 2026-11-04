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
 * Check the raw repertoire and per-code-point NFKC expansion. Whole-string
 * normalisation would compose a separate hamza and hide the violation.
 * Presentation forms are refused even when they expand to standard letters.
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
const INVISIBLE = '[\\p{M}\\p{Cf}\\u0640]';
/** What may sit between a preceding letter and a word without separating them (ZWNJ does separate). */
const JOINING = '[\\p{M}\\u0640\\u200d\\u200e\\u200f\\u061c]';
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

/** Explicit repertoire: Persian letters, existing Arabic yeh/kaf aliases, digits,
 * punctuation, tatweel, bidi ALM and the usual harakat (tanwin through sukun).
 * Combining hamza is separately permitted ONLY immediately after plain heh.
 * PM policy keeps U+06C0, U+0629 and U+0670 refused; Persian ezafe uses هٔ.
 */
const ALLOWED_ARABIC = new Set([
  ...'ءآأؤإئابتثجحخدذرزسشصضطظعغفقكلمنهويىپچژکگی',
  ...'٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹،؛؟٪٫٬۔',
  ...'\u061c\u0640\u064b\u064c\u064d\u064e\u064f\u0650\u0651\u0652',
]);
/** Script properties cover every block; retain legacy ranges to refuse unassigned points too. */
const ARABIC_CODE_POINT =
  /[\p{Script=Arabic}\p{Script_Extensions=Arabic}\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff\u{1ee00}-\u{1eeff}]/u;
/** Marks on either side, including runs separated by format controls or tatweel. */
const UNKNOWN_ADJACENT_MARK = new RegExp(
  String.raw`(?:[[\p{scx=Arab}&&\p{L}]\u0640][\p{M}\p{Cf}\u0640]*[\p{M}--[\u064b-\u0652\u0654]]|[\p{M}--[\u064b-\u0652\u0654]][\p{M}\p{Cf}\u0640]*[[\p{scx=Arab}&&\p{L}]\u0640])`,
  'v',
);

function outsideRepertoire(text: string): string | null {
  let previous = '';
  for (const point of text) {
    if (point === '\u0654') {
      if (previous !== '\u0647') return point;
    } else if (ARABIC_CODE_POINT.test(point) && !ALLOWED_ARABIC.has(point)) {
      return point;
    }
    previous = point;
  }
  return UNKNOWN_ADJACENT_MARK.exec(text)?.[0] ?? null;
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
  const raw = outsideRepertoire(text);
  if (raw !== null) return raw;
  const expanded = [...text].map((point) => point.normalize('NFKC')).join('');
  const compatibility = outsideRepertoire(expanded);
  if (compatibility !== null) return compatibility;
  return HAMZA_LESS.exec(normalised(text))?.[0] ?? null;
}
