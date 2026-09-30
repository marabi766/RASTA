import { canonicalize } from './canonical';

/**
 * The bytes a commitment is computed over (ADR-066 § 3). Pinned, because a
 * change here silently changes every commitment ever recorded.
 */

describe('canonicalize', () => {
  it('sorts keys recursively and writes no whitespace', () => {
    expect(canonicalize({ b: 1, a: { d: [3, 2, { z: null, y: true }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,2,{"y":true,"z":null}]},"b":1}',
    );
  });

  it('gives one reading to every ordering of the same content', () => {
    expect(canonicalize({ price: '100', note: 'n' })).toBe(
      canonicalize({ note: 'n', price: '100' }),
    );
  });

  it('writes strings as JSON does, including non-ASCII text', () => {
    expect(canonicalize({ note: 'پیشنهاد "قیمت"\n' })).toBe('{"note":"پیشنهاد \\"قیمت\\"\\n"}');
  });

  it('keeps a price a string: the amount is never a number', () => {
    expect(canonicalize({ priceMinor: '9223372036854775807' })).toBe(
      '{"priceMinor":"9223372036854775807"}',
    );
  });

  it('accepts a safe integer and refuses everything that could be rounded', () => {
    expect(canonicalize({ durationDays: 90 })).toBe('{"durationDays":90}');
    for (const bad of [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
      10n as unknown as number,
    ]) {
      expect(() => canonicalize({ bad })).toThrow(
        expect.objectContaining({ code: 'INVALID_CONTENT' }),
      );
    }
  });

  it.each([
    ['undefined', { a: undefined }],
    ['a function', { a: () => 1 }],
    ['a symbol', { a: Symbol('x') }],
    ['a date', { a: new Date(0) }],
    ['a class instance', { a: new (class Money {})() }],
  ])('refuses %s', (_label, value) => {
    expect(() => canonicalize(value)).toThrow(expect.objectContaining({ code: 'INVALID_CONTENT' }));
  });

  it('refuses content nested beyond the bound', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i += 1) deep = { a: deep };
    expect(() => canonicalize(deep)).toThrow(expect.objectContaining({ code: 'INVALID_CONTENT' }));
  });

  it('accepts an object with a null prototype', () => {
    const bare = Object.assign(Object.create(null) as object, { a: 1 });
    expect(canonicalize(bare)).toBe('{"a":1}');
  });
});
