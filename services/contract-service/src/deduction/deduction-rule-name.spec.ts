import {
  canonicalDeductionRuleName,
  deductionRuleNameKey,
  isCanonicalDeductionRuleName,
} from './deduction-rule-name';

const LAST_CODE_POINT = 0x10ffff;
const everyCodePoint = function* () {
  for (let cp = 1; cp <= LAST_CODE_POINT; cp += 1) {
    if (cp < 0xd800 || cp > 0xdfff) yield cp;
  }
};
const HALF_SPACE = 0x200c;

describe('the one form of a deduction rule name', () => {
  it.each([
    ['Tax', 'Tax'],
    ['  Tax \r\n ', 'Tax'],
    ['Two \t words', 'Two words'],
    ['Tax\u00a0A', 'Tax A'],
    // Arabic letters, Persian and Arabic-Indic digits, tatweel, presentation forms.
    ['مال\u064aات', 'مالیات'],
    ['\u0643سر', 'کسر'],
    ['مالیات\u0649', 'مالیاتی'],
    ['\u06f1\u06f0\u066a', '10\u066a'],
    ['\u0664\u0665', '45'],
    ['مال\u0640\u0640\u0640یات', 'مالیات'],
    ['\ufe8e\ufe91', 'اب'],
    ['Tax\uff21', 'TaxA'],
    ['\u{1d4b3}x', 'Xx'],
    // Composed letters, and the one mark.
    ['ا\u0654', 'أ'],
    ['و\u0654', 'ؤ'],
    ['خان\u06c0', 'خانه\u0654'],
    ['حق\u200cبیمه', 'حق\u200cبیمه'],
    ['خانه\u0654\u200cها', 'خانه\u0654\u200cها'],
  ])('%j becomes %j', (raw, canonical) => {
    expect(canonicalDeductionRuleName(raw)).toBe(canonical);
    expect(isCanonicalDeductionRuleName(canonical)).toBe(true);
  });

  it.each([
    // The review's probe (#677 r1 F1): each read as "Tax" and passed the old check.
    ['Tax\u034f'],
    ['T\u200cax'],
    ['Tax\ufe0e'],
    ['Tax\ufe0f'],
    ['Tax\u{e0061}'],
    ['Tax\u{e0100}'],
    ['Tax\u200b'],
    ['Tax\u200d'],
    ['Tax\ufeff'],
    ['Tax\u00ad'],
    ['a\u202eb'],
    ['a\u2066b'],
    // Half-space out of place: an edge, doubled, beside a blank, a digit or Latin.
    ['\u200cب'],
    ['ب\u200c'],
    ['ب\u200c\u200cب'],
    ['ب\u200c ب'],
    ['1\u200cب'],
    // Another script is a lookalike the allowed letters cannot be told from.
    ['T\u0430\u0445'],
    ['\u0391bc'],
    ['\u{1f600}x'],
    // The mark anywhere but after heh.
    ['ب\u0654'],
    ['\u0654'],
    ['ه\u0654\u0654'],
    // Nothing left, or too long.
    [''],
    ['   '],
    ['\r\n'],
    ['x'.repeat(201)],
    ['ب'.repeat(201)],
  ])('%j has no form', (raw) => {
    expect(canonicalDeductionRuleName(raw)).toBeNull();
  });

  it('counts the limit in code points', () => {
    expect(canonicalDeductionRuleName('ب'.repeat(200))).toBe('ب'.repeat(200));
    expect(canonicalDeductionRuleName('x'.repeat(200))).toBe('x'.repeat(200));
  });

  // Reading what Unicode says of each code point, so a range nobody listed cannot be missed.
  it.each([
    ['alone', '', ''],
    ['inside Latin', 'T', 'x'],
    ['at the end', 'Tax', ''],
    ['between Persian letters', 'ب', 'ب'],
  ])(
    'no invisible, control, unassigned or private code point is canonical %s',
    (_w, before, after) => {
      const hidden = /[\p{Default_Ignorable_Code_Point}\p{C}\p{Zl}\p{Zp}\p{Zs}]/u;
      const between = before === 'ب';
      const accepted: number[] = [];
      for (const cp of everyCodePoint()) {
        const char = String.fromCodePoint(cp);
        if (hidden.test(char) && isCanonicalDeductionRuleName(`${before}${char}${after}`)) {
          accepted.push(cp);
        }
      }
      // The half-space between Persian letters and the one space between words; nothing else.
      const expected: number[] = [];
      if (before === 'T' || between) expected.push(0x20);
      if (between) expected.push(HALF_SPACE);
      expect(accepted).toEqual(expected);
    },
  );

  it('every result is a fixed point, and only a canonical name is its own form', () => {
    const broken: string[] = [];
    for (const cp of everyCodePoint()) {
      const char = String.fromCodePoint(cp);
      for (const raw of [char, `T${char}x`, `ب${char}ب`, `ه${char}ب`]) {
        const canonical = canonicalDeductionRuleName(raw);
        const fixed =
          canonical === null ||
          (isCanonicalDeductionRuleName(canonical) &&
            canonicalDeductionRuleName(canonical) === canonical);
        if (!fixed || (isCanonicalDeductionRuleName(raw) && canonical !== raw)) broken.push(raw);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('the key two rule names are compared by (FU-083)', () => {
  it.each([
    ['Tax', 'TAX'],
    ['tax', 'tAx'],
    ['Tax A', 'tax a'],
    ['Tax A', 'TaxA'],
    ['حق بیمه', 'حق\u200cبیمه'],
    ['حق بیمه', 'حقبیمه'],
    ['خانه\u0654 ما', 'خانه\u0654\u200cما'],
  ])('%j and %j are one name, and each keeps its form', (one, other) => {
    expect(canonicalDeductionRuleName(one)).toBe(one);
    expect(canonicalDeductionRuleName(other)).toBe(other);
    expect(deductionRuleNameKey(one)).toBe(deductionRuleNameKey(other));
  });

  it.each([
    ['Tax', 'Taxes'],
    ['Rule 1', 'Rule 2'],
    ['A-B', 'AB'],
    ['کسر', 'کثر'],
  ])('%j and %j stay two names', (one, other) => {
    expect(deductionRuleNameKey(one)).not.toBe(deductionRuleNameKey(other));
  });

  it('what folds to a capital before the form is one name with it; what has no form is refused, not folded', () => {
    expect(deductionRuleNameKey(canonicalDeductionRuleName('TA\u212a')!)).toBe('tak');
    expect(deductionRuleNameKey(canonicalDeductionRuleName('\uff34ax')!)).toBe('tax');
    for (const lookalike of ['\u0130x', '\u0131x', 'Stra\u00dfe', '\u0391bc']) {
      expect(canonicalDeductionRuleName(lookalike)).toBeNull();
    }
  });

  it('over every code point in the form, the key is Unicode’s own case mapping, and folding it again changes nothing', () => {
    const blanks = /[ \u200c]/g;
    const broken: number[] = [];
    for (const cp of everyCodePoint()) {
      const char = String.fromCodePoint(cp);
      for (const name of [char, `T${char}x`, `ب${char}ب`, `ه${char}ب`]) {
        if (!isCanonicalDeductionRuleName(name)) continue;
        const key = deductionRuleNameKey(name);
        const bare = name.replace(blanks, '');
        if (
          key !== bare.toLowerCase() ||
          key !== bare.toUpperCase().toLowerCase() ||
          deductionRuleNameKey(key) !== key
        ) {
          broken.push(cp);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
