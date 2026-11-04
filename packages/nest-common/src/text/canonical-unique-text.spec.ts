import {
  canonicalUniqueText,
  foldAsciiCase,
  isCanonicalUniqueText,
  uniqueText,
  uniqueTextKey,
  uniqueTextSearchKey,
} from './canonical-unique-text';

const exact = { caseFold: false } as const;

describe('canonicalUniqueText (FU-084)', () => {
  it.each([
    ['Arabic yeh and kaf', 'علي كريمي', 'علی کریمی'],
    ['alef maksura', 'مصطفى', 'مصطفی'],
    ['Persian digits', 'IR-۱۲۳', 'IR-123'],
    ['Arabic-Indic digits', 'IR-١٢٣', 'IR-123'],
    ['tatweel', 'تهـــران', 'تهران'],
    ['presentation forms', 'ﺳﻠﺎﻡ', 'سلام'],
    ['fullwidth Latin', 'ＩＲ－１', 'IR-1'],
    ['heh with yeh above', 'خانۀ', 'خانه\u0654'],
    ['runs of blanks, at the ends too', '  IR \t 1\n', 'IR 1'],
  ])('folds %s', (_what, raw, canonical) => {
    expect(canonicalUniqueText(raw, exact)).toBe(canonical);
  });

  it.each([
    ['ZWJ', 'IR\u200d1'],
    ['combining grapheme joiner', 'IR\u034f1'],
    ['zero-width space', 'IR\u200b1'],
    ['word joiner', 'IR\u20601'],
    ['soft hyphen', 'IR\u00ad1'],
    ['left-to-right mark', 'IR\u200e1'],
    ['Arabic letter mark', 'IR\u061c1'],
    ['an override', 'IR\u202e1'],
    ['a variation selector', 'IR\ufe0f1'],
    ['Cyrillic а', 'IR-а'],
    ['Greek ο', 'IR-ο'],
    ['a half-space outside Persian letters', 'IR\u200c1'],
    ['a stray hamza mark', '\u0628\u0654'],
    ['nothing', ' \t '],
  ])('refuses %s', (_what, raw) => {
    expect(canonicalUniqueText(raw, exact)).toBeNull();
  });

  it('keeps the half-space Persian needs, but it is not part of the key', () => {
    const typed = canonicalUniqueText('می\u200cشود', exact)!;
    expect(typed).toBe('می\u200cشود');
    expect(uniqueTextKey(typed)).toBe(uniqueTextKey(canonicalUniqueText('میشود', exact)!));
  });

  it('folds case only when asked, and only A–Z', () => {
    expect(canonicalUniqueText('Ali.Reza', { caseFold: true })).toBe('ali.reza');
    expect(canonicalUniqueText('Ali.Reza', exact)).toBe('Ali.Reza');
    // U+212A KELVIN SIGN becomes K under NFKC, then folds; U+0130 is not ASCII and stays out.
    expect(canonicalUniqueText('K', { caseFold: true })).toBe('k');
    expect(canonicalUniqueText('İ', { caseFold: true })).toBeNull();
    expect(foldAsciiCase('ÀZaz')).toBe('Àzaz');
  });

  it('every output is itself canonical, and canonicalising it again changes nothing', () => {
    for (let cp = 1; cp <= 0xffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      for (const caseFold of [false, true]) {
        const out = canonicalUniqueText(`a${String.fromCodePoint(cp)}b`, { caseFold });
        if (out === null) continue;
        expect(isCanonicalUniqueText(out)).toBe(true);
        expect(canonicalUniqueText(out, { caseFold })).toBe(out);
      }
    }
  });

  it('the schema refuses with the closed message and never echoes the input', () => {
    const result = uniqueText(exact).safeParse('IR\u200d1');
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).not.toContain('IR');
    expect(uniqueText({ caseFold: true }).parse(' ALI ')).toBe('ali');
  });

  it('a search finds a value by the spelling it was created with (r2 F1)', () => {
    // The reviewer's cases: the stored key contains what the search for the typed spelling looks for.
    for (const [raw, caseFold] of [
      ['IR-۱۲', false],
      ['ali۱', true],
      ['Ali', true],
      ['علي‌كريمي', false],
    ] as const) {
      const stored = uniqueTextKey(canonicalUniqueText(raw, { caseFold })!);
      expect(uniqueTextSearchKey(raw, { caseFold })).toBe(stored);
    }
    // A fragment need not be in the form itself, and is still looked for by its key.
    expect(uniqueTextSearchKey('‌كري', exact)).toBe('کری');
    expect(uniqueTextSearchKey('-۱', exact)).toBe('-1');
  });

  it("the search key of every spelling that has a form is that form's key, over the whole BMP", () => {
    for (let cp = 1; cp <= 0xffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      for (const caseFold of [false, true]) {
        const raw = `a${String.fromCodePoint(cp)}b`;
        const canonical = canonicalUniqueText(raw, { caseFold });
        if (canonical === null) continue;
        expect(uniqueTextSearchKey(raw, { caseFold })).toBe(uniqueTextKey(canonical));
      }
    }
  });
});
