import { z } from 'zod';
import { TRANSACTION_TEXT_BOUNDS, boundsForAll, isWithin, textWithin } from './transaction-text';

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
