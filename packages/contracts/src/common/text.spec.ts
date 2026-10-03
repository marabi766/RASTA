import { UNSUPPORTED_CHARACTERS, WITHOUT_BIDI_CONTROL, plainText } from './text';

/** Every character Unicode classes as Bidi_Control. */
const BIDI_CONTROLS = [
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
];

describe('plainText (server-side bidi controls)', () => {
  it.each(BIDI_CONTROLS.map((cp) => [`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`, cp]))(
    'refuses %s anywhere in the text, with a message that repeats nothing',
    (_label, cp) => {
      const value = `گواهی${String.fromCodePoint(cp)}12-34`;
      const result = plainText().max(64).safeParse(value);

      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual([
        expect.objectContaining({ code: 'invalid_string', message: UNSUPPORTED_CHARACTERS }),
      ]);
      expect(JSON.stringify(result.error?.issues)).not.toContain('12-34');
    },
  );

  it('keeps Persian with ZWNJ, Latin, digits and punctuation, trimmed', () => {
    expect(plainText().max(64).parse('  می‌خواهم ABC-123 (۱۲۳)  ')).toBe('می‌خواهم ABC-123 (۱۲۳)');
  });

  it('covers exactly the Bidi_Control set, so the list above is complete', () => {
    const found: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (!WITHOUT_BIDI_CONTROL.test(String.fromCodePoint(cp))) found.push(cp);
    }
    expect(found).toEqual(BIDI_CONTROLS);
  });
});
