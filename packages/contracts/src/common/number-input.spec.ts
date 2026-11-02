import { z } from 'zod';
import { cursorPaginationSchema, offsetPaginationSchema } from './pagination';
import { numberInput } from './number-input';

/**
 * `numberInput` replaces `z.coerce.number()` in request schemas (#393 r1 F1).
 *
 * The change is for non-text, non-number input only: every number and every
 * string is accepted or refused exactly as `z.coerce.number()` decides, with the
 * same value; anything else is refused as `invalid_type` and nothing throws.
 */

const bounded = () => z.number().int().min(0).max(3650);
// eslint-disable-next-line no-restricted-syntax -- the behaviour being replaced, as the baseline
const before = z.coerce.number().int().min(0).max(3650);
const after = numberInput(bounded());

describe('numberInput', () => {
  it.each([
    0,
    7,
    3650,
    3651,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '7',
    ' 7 ',
    '',
    ' ',
    '0x1e',
    '1e3',
    '1e1',
    '+7',
    '-0',
    '07',
    '7.0',
    '7.5',
    'abc',
    'Infinity',
    '٧',
  ])('decides %j as z.coerce.number() did, with the same value', (value) => {
    const was = before.safeParse(value);
    const is = after.safeParse(value);

    expect(is.success).toBe(was.success);
    if (was.success && is.success) expect(is.data).toBe(was.data);
  });

  it.each([
    ['an object whose toString is null', { toString: null }],
    ['an object whose valueOf and toString are null', { valueOf: null, toString: null }],
    ['an empty object', {}],
    ['an array of one number', [7]],
    ['an array of one string', ['7']],
    ['an empty array', []],
    ['true', true],
    ['false', false],
    ['null', null],
    ['a bigint', 7n],
    ['a symbol', Symbol('7')],
    ['a date', new Date(7)],
  ])('refuses %s as invalid_type, without throwing', (_what, value) => {
    const result = after.safeParse(value);

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([expect.objectContaining({ code: 'invalid_type' })]);
  });

  it('is what z.coerce.number() made of a boolean and an array, for the record', () => {
    // zod 3 also threw a TypeError on { toString: null }; zod 4 refuses it instead.
    expect(() => before.safeParse({ toString: null })).not.toThrow();
    expect(before.safeParse(true)).toMatchObject({ success: true, data: 1 });
    expect(before.safeParse([7])).toMatchObject({ success: true, data: 7 });
  });

  it('leaves optional, nullable and default to the wrappers outside it', () => {
    expect(after.optional().parse(undefined)).toBeUndefined();
    expect(after.nullable().parse(null)).toBeNull();
    expect(after.prefault(25).parse(undefined)).toBe(25);
    expect(after.optional().isOptional()).toBe(true);
    expect(after.isOptional()).toBe(false);
  });
});

describe('the platform’s pagination schemas', () => {
  it('read a page size from text, as before', () => {
    expect(cursorPaginationSchema.parse({ limit: '50' }).limit).toBe(50);
    expect(cursorPaginationSchema.parse({}).limit).toBe(25);
    expect(offsetPaginationSchema.parse({ page: '2', pageSize: '10' })).toEqual({
      page: 2,
      pageSize: 10,
    });
  });

  it('refuse a page size that is not a number or text, without throwing', () => {
    for (const limit of [{ toString: null }, ['5'], true]) {
      expect(cursorPaginationSchema.safeParse({ limit }).success).toBe(false);
    }
  });
});
