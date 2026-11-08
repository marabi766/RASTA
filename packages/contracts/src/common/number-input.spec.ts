import { z } from 'zod';
import { cursorPaginationSchema, offsetPaginationSchema } from './pagination';
import { numberInput } from './number-input';
import { legacyParse } from './zod-issues';

/**
 * `numberInput` replaces `z.coerce.number()` in request schemas (#393 r1 F1).
 *
 * Only base-10 text may cross the conversion boundary (FU-131); exponent
 * notation is allowed only on non-integer fields (FU-160).
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

  it.each([
    [z.number().int(), '0.5', 'Expected an integer in decimal notation'],
    [z.number(), 'private-value', 'Expected a decimal number'],
  ])(
    'FU-160 reports a fixed refusal and keeps sibling bounds and enclosing checks',
    (inner, value, message) => {
      const schema = z
        .object({ limit: numberInput(inner), page: numberInput(z.number().min(1)) })
        .superRefine((_data, ctx) => {
          ctx.addIssue({ code: 'custom', path: ['cursor'], message: 'Invalid cursor' });
        });
      const result = legacyParse(schema, { limit: value, page: '0' });
      expect(result.success).toBe(false);
      expect(
        result.refusal?.issues.map(({ path, code, message }) => ({ path, code, message })),
      ).toEqual([
        { path: ['limit'], code: 'custom', message },
        { path: ['page'], code: 'too_small', message: 'Number must be greater than or equal to 1' },
        { path: ['cursor'], code: 'custom', message: 'Invalid cursor' },
      ]);
    },
  );

  it.each(['7.0', '7.5', '1.00000000000000001', '1e1', '1E+1', '1e-7'])(
    'FU-131 refuses fractional or exponent text on integer fields %j',
    (value) => {
      expect(after.safeParse(value).success).toBe(false);
    },
  );

  it.each(['0', '+7', '-7', '07', '7.50', '-0.5'])('FU-131 accepts decimal text %j', (value) => {
    expect(numberInput(z.number()).parse(value)).toBe(Number(value));
  });

  it('FU-160 accepts exponent text only for non-integer fields with JSON-number semantics', () => {
    const decimal = numberInput(z.number());
    for (const value of [1e-7, -1e-7, Number.MIN_VALUE, 1e20]) {
      const text = String(value);
      expect(decimal.parse(text)).toBe(value);
      expect(decimal.parse(text)).toBe(JSON.parse(text));
      expect(after.safeParse(text).success).toBe(false);
    }
    for (const text of ['1e+1', '-5E-1', '0e-9999']) {
      expect(decimal.parse(text)).toBe(JSON.parse(text));
    }
    for (const text of [
      '1e-400',
      '1e-9999',
      '1e9999',
      '-1e9999',
      '1e',
      '1e+',
      '1e-7 ',
      ' 1e-7',
      '0x1e7',
    ]) {
      expect(decimal.safeParse(text).success).toBe(false);
    }
    const latitude = numberInput(z.number().min(-90).max(90));
    expect(latitude.safeParse('9.1e1').success).toBe(false);
    expect(latitude.safeParse('-9.1e1').success).toBe(false);
  });

  it.each([z.number(), z.number().int()])('FU-184 normalizes every accepted zero', (inner) => {
    for (const value of [-0, '-0', '-00', '+0', '0']) {
      expect(Object.is(numberInput(inner).parse(value), 0)).toBe(true);
    }
  });

  it.each(['1e-400', '-1e-400', '0.000' + '0'.repeat(400) + '1'])(
    'FU-184 refuses nonzero decimal text rounded to zero: %s',
    (value) => {
      expect(numberInput(z.number()).safeParse(value).success).toBe(false);
    },
  );

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
