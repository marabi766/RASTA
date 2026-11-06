import { z } from 'zod';
import {
  TRANSACTION_TEXT_BOUNDS,
  boundsForAll,
  isWithin,
  keptTextWithin,
  textWithin,
  withLfLineEndings,
} from './transaction-text';

describe('TRANSACTION_TEXT_BOUNDS — economic-service transaction text, one table (FU-134)', () => {
  it('states the bounds economic-service published, unchanged', () => {
    // A change here changes economic-service's request bodies AND what every
    // forwarding service accepts: it is a contract change, made on purpose.
    expect(TRANSACTION_TEXT_BOUNDS).toEqual({
      disputeReason: { min: 10, max: 1000 },
      disputeResolution: { min: 10, max: 1000 },
      closingReason: { min: 3, max: 500 },
    });
  });
});

describe('textWithin', () => {
  const schema = textWithin(z.string().trim(), { min: 3, max: 5 });

  it.each([
    ['abc', true],
    ['abcde', true],
    ['ab', false],
    ['abcdef', false],
    // Trimmed first: what is counted is what is kept and sent.
    ['  abcde  ', true],
    ['  ab  ', false],
  ])('%j → %s', (value, accepted) => {
    expect(schema.safeParse(value).success).toBe(accepted);
  });

  it('counts code points, as zod 4 .min()/.max() do — not UTF-16 units, not graphemes', () => {
    // Each emoji is one code point and two UTF-16 units.
    expect(schema.safeParse('😀😀😀😀😀').success).toBe(true);
    expect(schema.safeParse('😀😀😀😀😀😀').success).toBe(false);
    // A ZWJ family is one grapheme and five code points.
    expect(schema.safeParse('👨\u200d👩\u200d👧').success).toBe(true);
    expect(schema.safeParse('👨\u200d👩\u200d👧👧').success).toBe(false);
  });
});

describe('isWithin counts exactly as textWithin does', () => {
  const bounds = { min: 3, max: 5 };
  const schema = textWithin(z.string(), bounds);
  it.each([
    '',
    'ab',
    'abc',
    'abcde',
    'abcdef',
    '😀😀',
    '😀😀😀',
    '😀😀😀😀😀😀',
    'ab😀😀😀',
    'e\u0301e',
    'ab\r\nc',
    'ab\r\ncd',
    'a\rb\rc',
  ])('%j', (value) => {
    expect(isWithin(value, bounds)).toBe(schema.safeParse(value).success);
  });
});

describe('boundsForAll — a text forwarded into several bodies', () => {
  it('is the largest minimum and the smallest maximum', () => {
    expect(
      boundsForAll(
        TRANSACTION_TEXT_BOUNDS.disputeResolution,
        TRANSACTION_TEXT_BOUNDS.closingReason,
      ),
    ).toEqual({ min: 10, max: 500 });
    expect(boundsForAll({ min: 1, max: 9 })).toEqual({ min: 1, max: 9 });
  });

  it('throws when no length satisfies them all, or when given none', () => {
    expect(() => boundsForAll({ min: 10, max: 20 }, { min: 21, max: 30 })).toThrow(
      'No length satisfies every bound',
    );
    expect(() => boundsForAll()).toThrow('at least one bound');
  });
});

describe('line endings (PR-806 r1, F1): one form for counting, hashing, storing and forwarding', () => {
  const { closingReason, disputeReason } = TRANSACTION_TEXT_BOUNDS;
  // 501 UTF-16 units and code points as sent; 500 once LF — the maximum.
  const atMaxWithCrlf = `${'x'.repeat(498)}\r\ny`;
  const atMaxWithLf = `${'x'.repeat(498)}\ny`;
  // Ten as sent — the dispute minimum — and nine once LF.
  const atMinWithCrlf = '1234\r\n5678';

  it('withLfLineEndings makes CRLF and lone CR LF, and nothing else', () => {
    expect(withLfLineEndings('a\r\nb\rc\nd\r\n\re')).toBe('a\nb\nc\nd\n\ne');
    expect(withLfLineEndings('\n\n')).toBe('\n\n');
    expect(withLfLineEndings('\u2028 \t')).toBe('\u2028 \t');
  });

  describe('textWithin — the accepting, forwarding side', () => {
    const schema = textWithin(z.string().trim(), closingReason);

    it('counts the LF form: CRLF and LF spellings at the maximum are both accepted', () => {
      expect(atMaxWithCrlf).toHaveLength(501);
      expect(schema.safeParse(atMaxWithCrlf).success).toBe(true);
      expect(schema.safeParse(atMaxWithLf).success).toBe(true);
      expect(schema.safeParse(`${'x'.repeat(499)}\r\ny`).success).toBe(false);
      expect(schema.safeParse(`${'x'.repeat(498)}\ry`).success).toBe(true);
    });

    it('makes the value LF, so both spellings are one value to hash, store and forward', () => {
      expect(schema.parse(atMaxWithCrlf)).toBe(atMaxWithLf);
      expect(schema.parse(` one\r\ntwo\rthree\n `)).toBe('one\ntwo\nthree');
    });

    it('counts the minimum on the LF form too: nine characters are nine', () => {
      expect(textWithin(z.string().trim(), disputeReason).safeParse(atMinWithCrlf).success).toBe(
        false,
      );
      expect(isWithin(atMinWithCrlf, disputeReason)).toBe(false);
      expect(isWithin(atMaxWithCrlf, closingReason)).toBe(true);
    });
  });

  describe('keptTextWithin — the receiving side that keeps the text as sent (FU-115)', () => {
    const previousRelease = (bounds: { min: number; max: number }) =>
      z.string().trim().min(bounds.min).max(bounds.max);
    const kept = keptTextWithin(z.string().trim(), closingReason);

    it('accepts what the LF count accepts, and keeps the value as sent', () => {
      expect(previousRelease(closingReason).safeParse(atMaxWithCrlf).success).toBe(false);
      expect(kept.parse(atMaxWithCrlf)).toBe(atMaxWithCrlf);
      expect(kept.parse(atMaxWithLf)).toBe(atMaxWithLf);
    });

    it('publishes its rule in words — a raw maxLength would be false (PR-806 r2 self-review)', () => {
      expect(kept.description).toBe(
        '3 to 500 characters (code points) after trimming, line endings counted as LF.',
      );
    });

    it('never refuses what the previous release accepted — the CRLF minimum', () => {
      const dispute = keptTextWithin(z.string().trim(), disputeReason);
      expect(previousRelease(disputeReason).safeParse(atMinWithCrlf).success).toBe(true);
      expect(dispute.parse(atMinWithCrlf)).toBe(atMinWithCrlf);
    });

    it.each([
      ['too long either way', `${'x'.repeat(499)}\r\ny`],
      ['too long either way, LF', 'x'.repeat(501)],
      ['too short either way', 'ab'],
      ['blank', '   '],
    ])("refuses %s, with the previous release's own issues", (_, value) => {
      const now = kept.safeParse(value);
      const before = previousRelease(closingReason).safeParse(value);
      expect(now.success).toBe(false);
      expect(now.error?.issues).toEqual(before.error?.issues);
    });
  });
});
