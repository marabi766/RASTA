/**
 * @jest-environment node
 */
import { inspect } from 'node:util';

import { zodResolver } from '@hookform/resolvers/zod';
import type { FieldErrors, ResolverOptions } from 'react-hook-form';
import { z } from 'zod';
import { legacyParse, type LegacyRefusal } from '@rasta/contracts';

import { formIssueMessage, GENERIC_FIELD_MESSAGE } from './form-issues';
import { legacyFormResolver } from './form-resolver';

/**
 * PR #444 r4 F4 and F5: the form resolver awaits legacyParse's rule
 * (`legacyParseAsync`), so async schemas resolve as they did under
 * `zodResolver`, and a union refused as a whole routes each option's issues to
 * the option's own fields, worded and masked as every other form issue.
 */

const options = { fields: {}, shouldUseNativeValidation: false } as const;
const allCriteria = { ...options, criteriaMode: 'all' } as const;

type Options = Partial<ResolverOptions<Record<string, unknown>>>;

const resolve = (
  schema: z.ZodType<Record<string, unknown>>,
  values: unknown,
  with_: Options = options,
) => legacyFormResolver(schema as never)(values as never, undefined, with_ as never);

const viaZodResolver = (
  schema: z.ZodType<Record<string, unknown>>,
  values: unknown,
  with_: Options = options,
) => zodResolver(schema as never)(values as never, undefined, with_ as never);

/** Every field an error object addresses (react-hook-form's nested shape), sorted. */
function fieldsOf(errors: FieldErrors, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(errors)) {
    if (!value || typeof value !== 'object' || key === 'ref' || key === 'types') continue;
    const name = prefix ? `${prefix}.${key}` : key;
    if ('type' in value && 'message' in value) out.push(name);
    out.push(...fieldsOf(value as FieldErrors, name));
  }
  return out.sort();
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('legacyFormResolver awaits the parse (r4 F4)', () => {
  const kinds: [string, z.ZodType<Record<string, unknown>>, unknown, unknown][] = [
    [
      'refine',
      z.object({
        n: z.string().refine(async (value) => {
          await tick();
          return value === 'ok';
        }, 'مقدار درست نیست'),
      }),
      { n: 'ok' },
      { n: 'no' },
    ],
    [
      'superRefine',
      z.object({
        n: z.string().superRefine(async (value, ctx) => {
          await tick();
          if (value !== 'ok') ctx.addIssue({ code: 'custom', message: 'مقدار درست نیست' });
        }),
      }),
      { n: 'ok' },
      { n: 'no' },
    ],
    [
      'check',
      z.object({
        n: z.string().check(async (ctx) => {
          await tick();
          if (ctx.value !== 'ok') {
            ctx.issues.push({ code: 'custom', message: 'مقدار درست نیست', input: ctx.value });
          }
        }),
      }),
      { n: 'ok' },
      { n: 'no' },
    ],
    [
      'transform',
      z.object({
        n: z.string().transform(async (value, ctx) => {
          await tick();
          if (value !== 'ok') ctx.addIssue({ code: 'custom', message: 'مقدار درست نیست' });
          return value.toUpperCase();
        }),
      }),
      { n: 'ok' },
      { n: 'no' },
    ],
    [
      'preprocess',
      z.object({
        n: z.preprocess(
          async (value) => {
            await tick();
            return typeof value === 'string' ? value.trim() : value;
          },
          z.string().refine((value) => value === 'ok', 'مقدار درست نیست'),
        ),
      }),
      { n: ' ok ' },
      { n: ' no ' },
    ],
  ];

  it.each(kinds)('%s: valid input resolves to stock zod’s values', async (_kind, schema, valid) => {
    const resolved = await resolve(schema, valid);
    expect(resolved).toEqual({ values: await schema.parseAsync(valid), errors: {} });
    // What zodResolver answered before PR #444.
    expect(resolved.values).toEqual((await viaZodResolver(schema, valid)).values);
  });

  it.each(kinds)(
    '%s: invalid input resolves to the field’s error',
    async (_kind, schema, _valid, invalid) => {
      const resolved = await resolve(schema, invalid);
      expect(resolved.values).toEqual({});
      expect(resolved.errors).toEqual({
        n: { type: 'custom', message: 'مقدار درست نیست', ref: undefined },
      });
      expect(fieldsOf(resolved.errors)).toEqual(
        fieldsOf((await viaZodResolver(schema, invalid)).errors),
      );
    },
  );

  it('refuses an async schema in the synchronous legacyParse exactly as stock safeParse does', () => {
    const schema = kinds[0][1];
    expect(() => schema.safeParse({ n: 'ok' })).toThrow(z.core.$ZodAsyncError);
    expect(() => legacyParse(schema, { n: 'ok' })).toThrow(z.core.$ZodAsyncError);
  });

  it('refuses Codex PR-444 r3 F3 with an async refinement, as stock zod does', async () => {
    const left = z
      .object({ a: z.string() })
      .strict()
      .transform((value) => value)
      .refine(async () => false, 'never allowed');
    const f3 = z.intersection(left, z.object({ b: z.string() }));
    const value = { a: 'a', b: 'b' };
    expect(
      (await f3.safeParseAsync(value, { [Symbol.for('@rasta/zod.legacyRunOrder')]: true } as never))
        .success,
    ).toBe(true);
    const resolved = await resolve(f3, value);
    expect(resolved.values).toEqual({});
    expect(Object.keys(resolved.errors)).toEqual(['']);
    expect(value).toEqual({ a: 'a', b: 'b' });
  });
});

describe('legacyFormResolver routes a refused union’s options to their fields (r4 F5)', () => {
  const objects = z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]);
  const cases: [string, z.ZodType<Record<string, unknown>>, unknown, string[]][] = [
    ['at the root', objects as never, { a: 1, b: 'x' }, ['', 'a', 'b']],
    [
      'nested',
      z.object({ payload: objects }),
      { payload: { a: 1, b: 'x' } },
      ['payload', 'payload.a', 'payload.b'],
    ],
    [
      'in an array',
      z.object({ items: z.array(objects) }),
      { items: [{ a: 'ok' }, { a: 1, b: 'x' }] },
      ['items.1', 'items.1.a', 'items.1.b'],
    ],
    [
      'a union inside an option',
      z.object({
        payload: z.union([
          z.object({
            kind: z.literal('x'),
            inner: z.union([z.object({ c: z.string() }), z.object({ d: z.boolean() })]),
          }),
          z.object({ e: z.number() }),
        ]),
      }),
      { payload: { kind: 'x', inner: { c: 1, d: 'y' }, e: 'z' } },
      ['payload', 'payload.e', 'payload.inner', 'payload.inner.c', 'payload.inner.d'],
    ],
  ];

  it.each(cases)(
    '%s: every option’s field gets its error, as under zodResolver',
    async (_name, schema, input, fields) => {
      const resolved = await resolve(schema, input);
      expect(fieldsOf(resolved.errors)).toEqual(fields);
      expect(fieldsOf((await viaZodResolver(schema, input)).errors)).toEqual(fields);
    },
  );

  it('words each option’s issue as a top-level issue of the same field', async () => {
    const schema = z.object({
      payload: z.union([
        z.object({ a: z.string().max(3), tag: z.literal('A') }),
        z.object({ b: z.number(), tag: z.literal('B') }),
      ]),
    });
    const resolved = await resolve(schema, { payload: { a: 'abcdef', b: 'x', tag: 'C' } });
    const payload = resolved.errors.payload as unknown as Record<
      string,
      { type: string; message: string }
    >;
    expect(payload).toMatchObject({
      type: 'invalid_union',
      message: GENERIC_FIELD_MESSAGE,
      a: { type: 'too_big', message: 'حداکثر ۳ نویسه مجاز است' },
      b: { type: 'invalid_type', message: 'یک عدد صحیح و معتبر وارد کنید' },
      tag: { type: 'invalid_literal', message: 'یکی از گزینه‌های موجود را انتخاب کنید' },
    });
  });

  it('with criteriaMode all, collects every option’s issue per field', async () => {
    const schema = z.object({
      payload: z.union([
        z.object({ a: z.string().min(5).regex(/^x+$/) }),
        z.object({ a: z.number() }),
      ]),
    });
    const resolved = await resolve(schema, { payload: { a: 'ab' } }, allCriteria);
    const a = (resolved.errors.payload as unknown as Record<string, { types: unknown }>).a;
    // zod 3's union: the first option failed on checks only, so it is the
    // refusal (no invalid_union); a type failure in every option is one.
    expect(a.types).toEqual({
      too_small: 'حداقل ۵ نویسه لازم است',
      invalid_string: 'نویسه‌های واردشده مجاز نیست',
    });
    const both = await resolve(
      z.object({ payload: z.union([z.object({ a: z.string() }), z.object({ a: z.boolean() })]) }),
      { payload: { a: 1 } },
      allCriteria,
    );
    const field = (
      both.errors.payload as unknown as Record<string, { types: unknown; type: string }>
    ).a;
    expect(field.type).toBe('invalid_type');
    expect(field.types).toEqual({
      invalid_type: [GENERIC_FIELD_MESSAGE, GENERIC_FIELD_MESSAGE],
    });
  });
});

describe('the union branch tree is value-free (r4 F5, addendum A)', () => {
  const VALUE = 'SENTINEL-042-value';
  const RECORD_NAME = 'SENTINEL-042-record';
  const TYPED = 'TYPED-042';
  const schema = z.object({
    tags: z.record(
      z.string(),
      z.union([
        z.object({ a: z.enum(['OPTION-ALPHA', 'OPTION-BETA']), n: z.string().max(2) }),
        z.object({
          b: z.literal('LITERAL-GAMMA'),
          c: z.string().refine((v) => v === 'ok', 'مقدار درست نیست'),
        }),
        z.object({
          // A Persian message built from the input: shown as written, at the
          // top level and in an option alike (formIssueMessage rule 1).
          d: z.number({ error: (issue) => `مقدار ${String(issue.input)} عدد نیست` }),
        }),
      ]),
    ),
  });
  const input = { tags: { [RECORD_NAME]: { a: VALUE, n: VALUE, b: VALUE, c: VALUE, d: TYPED } } };

  const refusalOf = (): LegacyRefusal => {
    const result = legacyParse(schema, input);
    if (result.success) throw new Error('expected a refusal');
    return result.refusal;
  };

  it('carries path, code and the form’s own wording only, masked as a top-level issue', () => {
    const refusal = refusalOf();
    const [union] = refusal.issues;
    const tree = refusal.unionBranches(union!, formIssueMessage);
    expect(tree).toBeDefined();
    for (const option of tree!) {
      for (const branch of option) {
        expect(Object.keys(branch).sort()).toEqual(['code', 'message', 'path']);
        expect(branch.path.slice(0, 2)).toEqual(['tags', RECORD_NAME]);
      }
    }
    const serialized = JSON.stringify(tree);
    const inspected = inspect(tree, { depth: null, showHidden: true });
    for (const text of [serialized, inspected]) {
      expect(text).not.toContain(VALUE);
      expect(text).not.toMatch(/OPTION-ALPHA|OPTION-BETA|LITERAL-GAMMA/);
      expect(text).not.toMatch(/[A-Za-z]{4,} /); // no English sentence of zod's
    }
    // A Persian message the schema wrote — static or built from the input —
    // passes exactly as it would at the top level (formIssueMessage rule 1).
    const top = legacyParse(z.object({ d: schema.shape.tags.valueType.options[2].shape.d }), {
      d: TYPED,
    });
    if (top.success) throw new Error('expected a refusal');
    const d = tree!.flat().find((branch) => branch.path.at(-1) === 'd');
    expect(d?.message).toBe(formIssueMessage(top.refusal.issues[0]));
    expect(d?.message).toBe(`مقدار ${TYPED} عدد نیست`);
  });

  it('leaves the refusal itself as it was: no tree in its issues, JSON or inspection', () => {
    const refusal = refusalOf();
    expect(Object.keys(refusal.issues[0]!).sort()).toEqual([
      'code',
      'message',
      'path',
      'zodDefault',
    ]);
    expect(JSON.stringify(refusal)).toBe(
      `{"issues":[{"path":["tags","${RECORD_NAME}"],"code":"invalid_union"}]}`,
    );
    expect(inspect(refusal)).toBe(`LegacyRefusal ${JSON.stringify(refusal)}`);
    expect(JSON.stringify(refusal.issues)).not.toMatch(/branches|OPTION-ALPHA/);
  });
});
