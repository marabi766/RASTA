import { z } from 'zod';
import {
  UNSUPPORTED_CHARACTERS,
  WITHOUT_BIDI_CONTROL,
  WITHOUT_CONTROL_CHARACTER,
  containsBidiControl,
  plainText,
  referenceId,
  withoutBidiControlDeep,
} from './text';

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

describe('referenceId (stored references)', () => {
  const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  const REFUSED = [
    ...BIDI_CONTROLS,
    0x0000, // NUL
    0x0007, // BEL
    0x009b, // C1 CSI
    0x200b, // zero-width space
    0x200c, // ZWNJ: prose needs it, an id does not
    0x200d, // ZWJ
    0x2028, // line separator
    0x2029, // paragraph separator
    0xfeff, // byte-order mark
  ];

  it.each(REFUSED.map((cp) => [hex(cp), cp]))(
    'refuses %s inside an id, with the closed message',
    (_label, cp) => {
      const value = `DOC_01J9${String.fromCodePoint(cp)}ZK7Q`;
      const result = referenceId().min(1).max(64).safeParse(value);

      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual([
        expect.objectContaining({ code: 'invalid_string', message: UNSUPPORTED_CHARACTERS }),
      ]);
      expect(JSON.stringify(result.error?.issues)).not.toContain('ZK7Q');
    },
  );

  it('keeps an ordinary id, trimmed, and its bounds', () => {
    expect(referenceId().min(1).max(64).parse('  DOC_01J9ZK7Q  ')).toBe('DOC_01J9ZK7Q');
    expect(referenceId().min(1).max(64).parse('AST-SEED-0001')).toBe('AST-SEED-0001');
    expect(referenceId().max(4).safeParse('DOC_1').success).toBe(false);
  });

  it('refuses everything WITHOUT_BIDI_CONTROL refuses', () => {
    for (const cp of BIDI_CONTROLS) {
      expect(WITHOUT_CONTROL_CHARACTER.test(String.fromCodePoint(cp))).toBe(false);
    }
  });
});

describe('containsBidiControl / withoutBidiControlDeep (free-form JSON)', () => {
  const RLO = String.fromCodePoint(0x202e);
  const ALM = String.fromCodePoint(0x061c);
  const schema = withoutBidiControlDeep(z.record(z.unknown()));

  it.each([
    ['a top-level string value', { a: `x${RLO}` }],
    ['a top-level key', { [`k${ALM}`]: 1 }],
    ['a nested key', { a: { b: { [`${RLO}c`]: true } } }],
    ['a string in a nested array', { a: [[1, 'ok', `v${ALM}`]] }],
    ['a key of an object inside an array', { a: [{ [`k${RLO}`]: null }] }],
  ])('finds one in %s and refuses it with the closed message', (_where, value) => {
    expect(containsBidiControl(value)).toBe(true);

    const result = schema.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      { code: 'custom', message: UNSUPPORTED_CHARACTERS, path: [] },
    ]);
  });

  it('keeps clean JSON of any shape, Persian with ZWNJ in keys and values', () => {
    const value = { نام‌واحد: 'فنی‌مهندسی', n: 3, b: false, z: null, list: [['a', 1], { k: 'v' }] };
    expect(containsBidiControl(value)).toBe(false);
    expect(schema.parse(value)).toEqual(value);
  });

  it('walks a very deep value without overflowing the stack', () => {
    let value: unknown = `deep${RLO}`;
    for (let depth = 0; depth < 200_000; depth += 1)
      value = depth % 2 === 0 ? [value] : { k: value };
    expect(containsBidiControl(value)).toBe(true);
  });

  it('ignores non-string leaves and does not loop on a shared or cyclic object', () => {
    const shared = { n: 1 };
    const cyclic: Record<string, unknown> = { shared, again: shared };
    cyclic.self = cyclic;
    expect(containsBidiControl(cyclic)).toBe(false);
    expect(containsBidiControl(42)).toBe(false);
    expect(containsBidiControl(undefined)).toBe(false);
  });
});
