import { z } from 'zod';
import { cursorPaginationSchema, offsetPaginationSchema } from './pagination';
import { numberInput } from './number-input';

/**
 * `numberInput` replaces `z.coerce.number()` in request schemas (#393 r1 F1).
 *
 * Only decimal text may cross the request conversion boundary (FU-131).
 */

const bounded = () => z.number().int().min(0).max(3650);
const before = z.coerce.number().int().min(0).max(3650);
const after = numberInput(bounded());

describe('numberInput', () => {
  it.each([
    '',
    ' ',
    '\t',
    '\n',
    ' 7',
    '7 ',
    '7\n',
    '7\r\n',
    '0x10',
    '0X10',
    '0o10',
    '0O10',
    '0b10',
    '0B10',
    '1e1',
    '1E+1',
    'Infinity',
    '-Infinity',
    'NaN',
    '.5',
    '5.',
    '+',
    '-',
    '1_000',
    '1,000',
    '٧',
  ])('FU-131 refuses non-decimal text %j', (value) => {
    expect(numberInput(z.number()).safeParse(value).success).toBe(false);
  });

  it.each(['7.0', '7.5', '1.00000000000000001'])(
    'FU-131 refuses fractions on integer fields %j',
    (value) => {
      expect(after.safeParse(value).success).toBe(false);
    },
  );

  it.each(['0', '+7', '-7', '07', '7.50', '-0.5'])('FU-131 accepts decimal text %j', (value) => {
    expect(numberInput(z.number()).parse(value)).toBe(Number(value));
  });

  it('FU-131 preserves inner bounds and rejects conversion overflow', () => {
    expect(after.safeParse('3651').success).toBe(false);
    expect(numberInput(z.number()).safeParse('9'.repeat(400)).success).toBe(false);
  });

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
    '+7',
    '-0',
    '07',
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
