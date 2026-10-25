/**
 * The product's Persian is written in standard orthography, hamza included
 * (تأمین، تأیید، مسئول، رئیس). Owner decision 2026-10-24; it replaces the
 * earlier "no hamza" wording rule, which applies to PM reports and Telegram
 * only, never to product text.
 *
 * What a rendered sentence must NOT hold: a combining hamza (U+0654) on alef,
 * waw or yeh (the precomposed letters أ ؤ ئ are the standard spelling; a
 * decomposed one compares unequal to it), and a hamza-less spelling of a word
 * that takes one. A combining hamza on heh is the ezafe («شمارهٔ دارایی») and
 * is the standard spelling, so it is allowed.
 */
const HAMZA_LESS_WORDS = [
  'تامین',
  'تایید',
  'تاثیر',
  'تاخیر',
  'تاکید',
  'تاسیس',
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
] as const;

/** Alef, waw, yeh (Arabic and Persian forms) followed by U+0654, or a hamza-less spelling. */
export const NON_STANDARD_SPELLING = new RegExp(
  `[\\u0627\\u0648\\u064a\\u0649\\u06cc]\\u0654|${HAMZA_LESS_WORDS.join('|')}`,
  'u',
);
