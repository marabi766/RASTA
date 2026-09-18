import {
  ALEF_MAKSURA,
  ARABIC_KAF,
  ARABIC_YEH,
  FARSI_YEH,
  KEHEH,
  ZERO_WIDTH_SPACE,
  ZWNJ,
} from './codepoints';
import {
  collapseWhitespace,
  containsLatin,
  joinWithZwnj,
  normalizePersianLetters,
  normalizePersianText,
} from './text';

/** U+00A0 NO-BREAK SPACE — a space that survives `trim()`. */
const NBSP = String.fromCodePoint(0x00a0);

describe('normalizePersianLetters', () => {
  // The two characters are drawn the same. Stored one way and searched the
  // other, a name never matches and nobody can see why — which is why both
  // sides of every pair are written from their code point here rather than
  // pasted in as glyphs a reader would have to take on trust.
  it('rewrites Arabic yeh as Farsi yeh', () => {
    expect(normalizePersianLetters(`عل${ARABIC_YEH}`)).toBe(`عل${FARSI_YEH}`);
  });

  it('rewrites Arabic kaf as keheh', () => {
    expect(normalizePersianLetters(`${ARABIC_KAF}تاب`)).toBe(`${KEHEH}تاب`);
  });

  it('rewrites alef maksura as Farsi yeh', () => {
    expect(normalizePersianLetters(`موس${ALEF_MAKSURA}`)).toBe(`موس${FARSI_YEH}`);
  });

  it('leaves text that is already Persian untouched', () => {
    const persian = `${KEHEH}تاب عل${FARSI_YEH}`;
    expect(normalizePersianLetters(persian)).toBe(persian);
  });

  it('does not touch digits — that is toLatinDigits', () => {
    expect(normalizePersianLetters('۱۲۳')).toBe('۱۲۳');
  });
});

describe('collapseWhitespace', () => {
  it('collapses runs and trims', () => {
    expect(collapseWhitespace('  سفارش   ثبت شد  ')).toBe('سفارش ثبت شد');
  });

  it('turns a no-break space into an ordinary one', () => {
    expect(collapseWhitespace(`سفارش${NBSP}ثبت شد`)).toBe('سفارش ثبت شد');
  });

  it('turns a zero-width space into an ordinary one', () => {
    expect(collapseWhitespace(`سفارش${ZERO_WIDTH_SPACE}ثبت شد`)).toBe('سفارش ثبت شد');
  });

  // A ZWNJ is a letter-forming mark in Persian, not whitespace. Removing it
  // turns «می‌شود» into «میشود».
  it('keeps the zero-width non-joiner', () => {
    expect(collapseWhitespace(`می${ZWNJ}شود`)).toBe(`می${ZWNJ}شود`);
  });
});

describe('normalizePersianText', () => {
  it('applies both normalisations in one pass', () => {
    expect(normalizePersianText(`  ${ARABIC_KAF}تاب   عل${ARABIC_YEH} `)).toBe(
      `${KEHEH}تاب عل${FARSI_YEH}`,
    );
  });
});

describe('containsLatin', () => {
  it.each([
    ['ORD-2026-0148', true],
    ['سفارش ORD-1', true],
    ['کد ۱۲۳', false],
    ['سفارش ثبت شد', false],
    ['', false],
  ])('%p → %p', (input, expected) => {
    expect(containsLatin(input)).toBe(expected);
  });
});

describe('joinWithZwnj', () => {
  it('joins with the half-space', () => {
    expect(joinWithZwnj('می', 'شود')).toBe(`می${ZWNJ}شود`);
  });

  it('skips empty parts rather than leaving a stray mark', () => {
    expect(joinWithZwnj('به', '', 'روزرسانی')).toBe(`به${ZWNJ}روزرسانی`);
  });
});
