import { z } from 'zod';
import {
  DISPLAY_TEXT_PATTERN,
  UNSUPPORTED_CHARACTERS,
  WITHOUT_BIDI_CONTROL,
  WITHOUT_CONTROL_CHARACTER,
  containsBidiControl,
  displayText,
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

describe('displayText (the one display-text rule: descriptions, notes, titles)', () => {
  const cp = (code: number) => String.fromCodePoint(code);
  const hex = (code: number) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  const field = displayText(1, 200);

  // Every character is written from its number: a reviewer must not have to
  // tell an invisible one from a space by eye.
  const ACCEPTED: ReadonlyArray<readonly [string, string]> = [
    ['Persian comma «،»', `الف${cp(0x060c)} ب`],
    ['Persian semicolon «؛»', `الف${cp(0x061b)} ب`],
    ['Persian question mark «؟»', `چرا${cp(0x061f)}`],
    ['Arabic decimal separator U+066B', `۱${cp(0x066b)}۵`],
    ['Arabic thousands separator U+066C', `۱${cp(0x066c)}۵۰۰`],
    ['Arabic percent sign U+066A', `۵۰${cp(0x066a)}`],
    ['ASCII question mark', 'why?'],
    ['exclamation mark', 'توجه!'],
    ['ASCII semicolon', 'a; b'],
    ['percent sign', '50%'],
    ['double quote', 'گفت "بله"'],
    ['ellipsis U+2026', `ادامه${cp(0x2026)}`],
    ['en dash U+2013', `۱۰${cp(0x2013)}۲۰`],
    ['ZWNJ U+200C', `می${cp(0x200c)}شود`],
    ['Persian, Latin and digits of every script', 'گریدر Komatsu ۱۴۰۲ ١٤٠٢ 1402'],
    ['guillemets, brackets, slash, colon, plus', '«کلید» (اصلی) a/b c:d +1'],
    ['apostrophes and hyphen', "O'Brien’s a-b."],
    ['combining mark (vowel sign)', `کتاب${cp(0x064e)}`],
    ['tab', 'a\tb'],
    ['line feed (a multi-line note)', 'خط اول\nخط دوم'],
    ['carriage return + line feed', 'a\r\nb'],
    ['no-break space U+00A0', `a${cp(0x00a0)}b`],
    // `\s` always accepted these, so a value stored before the display-text
    // rule must keep validating (the compatibility table below proves all of it).
    ['byte-order mark U+FEFF inside', `a${cp(0xfeff)}b`],
    ['line separator U+2028', `a${cp(0x2028)}b`],
    ['paragraph separator U+2029', `a${cp(0x2029)}b`],
    ['vertical tab', `a${cp(0x0b)}b`],
    ['form feed', `a${cp(0x0c)}b`],
    ['a full Persian sentence', 'موتور روشن نشد، استارت خراب است؛ لطفاً بررسی شود؟'],
  ];

  const REFUSED: ReadonlyArray<readonly [string, string]> = [
    ...[
      0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068,
      0x2069,
    ].map((code) => [`bidi control ${hex(code)}`, `ab${cp(code)}cd`] as const),
    ['TATWEEL U+0640 (decision: refused)', `ســلام`.replace('س', `س${cp(0x0640)}`)],
    ['ZWJ U+200D (decision: refused)', `a${cp(0x200d)}b`],
    ['zero-width space U+200B', `a${cp(0x200b)}b`],
    ['word joiner U+2060', `a${cp(0x2060)}b`],
    ['soft hyphen U+00AD', `a${cp(0x00ad)}b`],
    ['NUL', `a${cp(0)}b`],
    ['ESC', `a${cp(0x1b)}b`],
    ['next line U+0085', `a${cp(0x85)}b`],
    ['DEL', `a${cp(0x7f)}b`],
    ['angle brackets', 'a<b>'],
    ['backslash', 'a\\b'],
    ['curly braces', 'a{b}'],
    ['at sign', 'a@b'],
    ['equals', 'a=b'],
    ['underscore', 'a_b'],
    ['emoji', `a ${cp(0x1f69c)}`],
    ['CJK', '日本語'],
    ['Cyrillic', 'Москва'],
    ['only whitespace (empty after trim)', '   '],
  ];

  it.each(ACCEPTED)('accepts %s', (_label, value) => {
    expect(field.safeParse(value).success).toBe(true);
  });

  it.each(REFUSED)('refuses %s, with the closed message that repeats nothing', (_label, value) => {
    const result = field.safeParse(value);
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((issue) => issue.message);
    expect(messages.every((m) => m === UNSUPPORTED_CHARACTERS || m.startsWith('String must'))).toBe(
      true,
    );
    expect(JSON.stringify(result.error.issues)).not.toContain('cd');
  });

  it('trims at the edges, a leading or trailing byte-order mark included', () => {
    expect(field.parse(`${cp(0xfeff)}  الف،  ${cp(0xfeff)}`)).toBe('الف،');
  });

  it('keeps the field bounds', () => {
    expect(displayText(2, 4).safeParse('ا').success).toBe(false);
    expect(displayText(2, 4).safeParse('ابتثج').success).toBe(false);
    expect(displayText(2, 4).safeParse('ابت').success).toBe(true);
  });

  it('is one pattern whose source states the whole rule, lookahead included', () => {
    expect(DISPLAY_TEXT_PATTERN.source).toContain('(?![\\s\\S]*\\p{Bidi_Control})');
    expect(DISPLAY_TEXT_PATTERN.source).toContain('\\u060c');
    expect(DISPLAY_TEXT_PATTERN.flags).toBe('u');
  });

  it('leaves plainText() and referenceId() exactly as they were', () => {
    expect(plainText().safeParse('a<b>_@').success).toBe(true);
    expect(plainText().safeParse(`a${cp(0x200d)}b`).success).toBe(true);
    expect(referenceId().safeParse(`a${cp(0x200c)}b`).success).toBe(false);
    expect(referenceId().safeParse('AST-SEED-0001').success).toBe(true);
  });
});

/**
 * Compatibility: the PR must ACCEPT more (Persian punctuation), never refuse a
 * value the per-service patterns it replaced accepted, or a stored value
 * cannot be sent back unchanged. The pattern is quoted from `origin/main`
 * (9ecfa4a9): asset, fleet and maintenance `dto.ts` each carried this exact
 * literal inside `z.string().trim().min().max().regex(…)`.
 */
describe('displayText accepts everything the pattern it replaced accepted', () => {
  const OLD_DISPLAY_TEXT =
    /^(?![\s\S]*\p{Bidi_Control})[\p{Script=Arabic}\p{Script=Latin}\p{Nd}\p{Mark}\s‌()«»'’\-.,/:+]+$/u;
  const oldField = z.string().trim().min(1).max(500).regex(OLD_DISPLAY_TEXT);
  const newField = displayText(1, 500);

  function* everyCodePoint(): Generator<number> {
    for (let code = 0; code <= 0x10ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      yield code;
    }
  }

  it('pins that the quoted pattern is the one on main (what the table is measured against)', () => {
    expect(OLD_DISPLAY_TEXT.source).toBe(
      "^(?![\\s\\S]*\\p{Bidi_Control})[\\p{Script=Arabic}\\p{Script=Latin}\\p{Nd}\\p{Mark}\\s‌()«»'’\\-.,/:+]+$",
    );
  });

  it('accepts every generated value the old pattern accepted: all code points, alone, inside, at both edges', () => {
    const lost: string[] = [];
    let oldAccepted = 0;
    for (const code of everyCodePoint()) {
      const c = String.fromCodePoint(code);
      for (const value of [c, `ا${c}ب`, `${c}ا`, `ا${c}`, `a${c}${c}b`]) {
        if (!OLD_DISPLAY_TEXT.test(value)) continue;
        oldAccepted += 1;
        if (!DISPLAY_TEXT_PATTERN.test(value))
          lost.push(`U+${code.toString(16)} in ${value.length}`);
      }
    }
    expect(oldAccepted).toBeGreaterThan(20_000);
    expect(lost).toEqual([]);
  });

  it('accepts, through the schema (trim, bounds), every whitespace code point the old schema accepted', () => {
    const whitespace = [...everyCodePoint()].filter((code) =>
      /\s/u.test(String.fromCodePoint(code)),
    );
    // 25 members today (TAB LF VT FF CR, space, NBSP, U+1680, U+2000–200A, U+2028/9, U+202F, U+205F, U+3000, BOM).
    expect(whitespace.length).toBeGreaterThanOrEqual(25);
    for (const code of whitespace) {
      const c = String.fromCodePoint(code);
      for (const value of [`ا${c}ب`, `  ا${c}ب  `, `ا${c}${c}ب`, `${c}ا${c}`, `a${c}b`]) {
        expect([code, value, newField.safeParse(value).success]).toEqual([
          code,
          value,
          oldField.safeParse(value).success,
        ]);
      }
    }
  });

  it('covers every class the first draft of this PR newly refused', () => {
    const FIRST_DRAFT_REFUSED = [0xfeff, 0x0b, 0x0c, 0x2028, 0x2029];
    for (const code of FIRST_DRAFT_REFUSED) {
      const value = `ا${String.fromCodePoint(code)}ب`;
      expect([code, oldField.safeParse(value).success, newField.safeParse(value).success]).toEqual([
        code,
        true,
        true,
      ]);
    }
  });

  it('still refuses what the old pattern refused apart from what it newly accepts', () => {
    const NEWLY_ACCEPTED = new Set(
      [0x060c, 0x061b, 0x061f, 0x3b, 0x3f, 0x21, 0x25, 0x22, 0x2026, 0x2013].map((code) =>
        String.fromCodePoint(code),
      ),
    );
    const widened: string[] = [];
    for (const code of everyCodePoint()) {
      const c = String.fromCodePoint(code);
      const value = `ا${c}ب`;
      if (
        DISPLAY_TEXT_PATTERN.test(value) &&
        !OLD_DISPLAY_TEXT.test(value) &&
        !NEWLY_ACCEPTED.has(c)
      ) {
        widened.push(`U+${code.toString(16)}`);
      }
    }
    expect(widened).toEqual([]);
  });
});
