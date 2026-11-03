import { z } from 'zod';
import { withMaxKeys } from './bounds';
import { withoutBidiControlDeep } from './text';

const entries = (count: number, value: unknown = 'v') =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, value]));

/** A record whose value schema counts every entry it is asked to parse. */
function countingRecord() {
  const parsed = jest.fn();
  const value = z.unknown().superRefine((entry, ctx) => {
    parsed();
    if (entry !== 'v') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bad entry' });
  });
  return { schema: z.record(z.string(), value), parsed };
}

describe('withMaxKeys (a key-count cap checked before any entry)', () => {
  it('accepts a record at the cap and returns it unchanged', () => {
    const { schema } = countingRecord();
    const value = entries(3);

    expect(withMaxKeys(schema, 3).parse(value)).toEqual(value);
  });

  it('refuses one key over the cap without parsing a single entry, even when every entry is invalid', () => {
    const { schema, parsed } = countingRecord();

    const result = withMaxKeys(schema, 3).safeParse(entries(10_000, 42));

    expect(parsed).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    // One issue, not one per entry. (zod 3 also kept its internal `fatal` flag on the issue.)
    expect(result.error?.issues).toEqual([
      { code: 'custom', message: 'Expected at most 3 keys', path: [] },
    ]);
  });

  it('leaves a refinement over the whole value unrun when the cap refuses', () => {
    const containsBidi = jest.fn();
    const schema = withMaxKeys(z.record(z.string(), z.unknown()), 2).superRefine(() =>
      containsBidi(),
    );

    expect(schema.safeParse(entries(3)).success).toBe(false);
    expect(containsBidi).not.toHaveBeenCalled();
  });

  it('under the cap, the record parses and reports its own issues as before', () => {
    const { schema, parsed } = countingRecord();

    const result = withMaxKeys(schema, 3).safeParse({ a: 'v', b: 42 });

    expect(parsed).toHaveBeenCalledTimes(2);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ code: 'custom', message: 'bad entry', path: ['b'] }),
    ]);
  });

  it.each([
    ['an array', ['a', 'b', 'c', 'd']],
    ['a string', 'abcd'],
    ['null', null],
  ])('passes %s through, so the record refuses it exactly as it did', (_label, input) => {
    const capped = withMaxKeys(z.record(z.string(), z.unknown()), 2).safeParse(input);
    const plain = z.record(z.string(), z.unknown()).safeParse(input);

    expect(capped.error?.issues).toEqual(plain.error?.issues);
  });

  it('names the cap and nothing the caller sent (S-09)', () => {
    const result = withoutBidiControlDeep(
      withMaxKeys(z.record(z.string(), z.unknown()), 1),
    ).safeParse({
      'SENTINEL-key': 'SENTINEL-value',
      other: 1,
    });

    expect(JSON.stringify(result.error?.issues)).not.toContain('SENTINEL');
  });
});
