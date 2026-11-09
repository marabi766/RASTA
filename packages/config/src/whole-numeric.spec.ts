import { parseWholeNumber, wholeBigintEnv } from './index';

describe('reviewed whole-number parsers', () => {
  it.each(['', ' ', ' 5 ', '+5', '-1', '0.5', '1e3', '0x10', 'Infinity', 'NaN', '۵', '5\n'])(
    'refuses %j without trimming',
    (text) => {
      expect(parseWholeNumber(text, { min: 0, max: 100 })).toBeNull();
      expect(wholeBigintEnv(0n, 100n).safeParse(text).success).toBe(false);
    },
  );

  it('keeps zero, leading zeros and inclusive bounds', () => {
    for (const text of ['0', '05', '100']) {
      expect(parseWholeNumber(text, { min: 0, max: 100 })).toBe(Number(text));
      expect(wholeBigintEnv(0n, 100n).parse(text)).toBe(BigInt(text));
    }
    expect(parseWholeNumber('4', { min: 5, max: 100 })).toBeNull();
    expect(parseWholeNumber('101', { min: 5, max: 100 })).toBeNull();
    expect(wholeBigintEnv(5n, 100n).safeParse('4').success).toBe(false);
    expect(wholeBigintEnv(5n, 100n).safeParse('101').success).toBe(false);
  });

  it('refuses unsafe numbers but preserves bigint precision', () => {
    expect(
      parseWholeNumber('9007199254740992', { min: 0, max: Number.MAX_SAFE_INTEGER }),
    ).toBeNull();
    expect(wholeBigintEnv(0n, 10n ** 30n).parse('9007199254740993')).toBe(9007199254740993n);
  });

  it('refuses malformed bounds', () => {
    for (const [min, max] of [
      [-1, 5],
      [6, 5],
      [0, Infinity],
      [0, 1.5],
    ]) {
      expect(() => parseWholeNumber('5', { min, max })).toThrow(RangeError);
    }
    expect(() => wholeBigintEnv(-1n, 5n)).toThrow(RangeError);
    expect(() => wholeBigintEnv(6n, 5n)).toThrow(RangeError);
  });
});
