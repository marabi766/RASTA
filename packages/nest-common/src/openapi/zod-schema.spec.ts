import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { z } from 'zod';
import { isoDateTime, parsableUrl } from '@rasta/contracts';
import { queryBoolean } from '@rasta/config';
import { codePointLength, toJsonSchema } from './zod-schema';

/**
 * The shared converter, construct by construct.
 *
 * The services' own `openapi/zod-schema.spec.ts` keep pinning their DTOs; this
 * covers every branch once, including the ones only some services' copies had
 * (array bounds, `queryBoolean`, `codePointLength`). The snapshot beside this
 * file was recorded under **zod 3.25.76** and is the oracle for the zod 4
 * converter (GHSA-mrhx-c7xc-m3w5, PR B): never re-record it (`-u`) to make a
 * migration pass — every service's generated document depends on these bytes.
 */
describe('toJsonSchema', () => {
  it('publishes every construct the services use', () => {
    const schema = z
      .object({
        text: z
          .string()
          .min(1)
          .max(10)
          .regex(/^[a-z]+$/i),
        email: z.string().email(),
        url: z.string().check(parsableUrl()),
        instant: z.string().check(isoDateTime({ offset: true })),
        count: z.number().int().min(0).max(5),
        ratio: z.number().min(0.5),
        flag: z.boolean(),
        status: z.enum(['OPEN', 'CLOSED']),
        version: z.literal(1),
        lines: z.array(z.string()).min(1).max(50),
        tags: z.array(z.string()),
        metadata: z.record(z.string(), z.number()),
        either: z.union([z.string(), z.number()]),
        maybe: z.string().optional(),
        nothing: z.string().nullable(),
        defaulted: z.number().int().prefault(25),
        refined: z.string().refine((value) => value !== 'x'),
        transformed: z.string().transform((value) => value.trim()),
        described: z.string().describe('What it is'),
        codePoints: codePointLength(z.string().trim(), 2, 500),
        include: queryBoolean(false),
        unsupported: z.bigint(),
      })
      .strict();

    expect(toJsonSchema(schema)).toMatchSnapshot();
  });

  it('leaves `additionalProperties` unset on a non-strict object', () => {
    expect(toJsonSchema(z.object({ a: z.string().optional() }))).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: undefined,
    });
  });

  it('leaves a discriminated union undescribed, as before', () => {
    // zod 3 had a type of its own for it, which the converter did not know; in
    // zod 4 a discriminated union is a union, and still `{}`.
    const tagged = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('A') }),
      z.object({ kind: z.literal('B') }),
    ]);
    expect(toJsonSchema(tagged)).toEqual({});
    // A plain union is still described.
    expect(toJsonSchema(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  /**
   * FU-078 r1 F2: a pipe between two schemas published `{}`, so asset-service's
   * `identifierText(1, 64).nullable()` (plainText → canonicalise → `z.string().min(1).max(64)`)
   * published `{"nullable":true}` — no type, which AJV refuses — instead of a bounded string.
   */
  it('publishes a pipe between two schemas as its input type, with both constraints', () => {
    const identifier = z
      .string()
      .regex(/^[a-z ]*$/)
      .transform((value) => value.trim())
      .pipe(z.string().min(1).max(64));
    expect(toJsonSchema(identifier.nullable())).toEqual({
      type: 'string',
      pattern: '^[a-z ]*$',
      minLength: 1,
      maxLength: 64,
      nullable: true,
    });
    expect(toJsonSchema(z.string().pipe(z.enum(['X'])))).toEqual({ type: 'string', enum: ['X'] });
    // The tighter bound of the two holds.
    expect(toJsonSchema(z.string().min(2).max(500).pipe(z.string().min(1).max(64)))).toEqual({
      type: 'string',
      minLength: 2,
      maxLength: 64,
    });
    // An input that says nothing passes the value on unchanged: the later schema is the shape.
    expect(toJsonSchema(z.unknown().pipe(z.object({ n: z.number() })))).toEqual({
      type: 'object',
      properties: { n: { type: 'number' } },
      required: ['n'],
      additionalProperties: undefined,
    });
    // Types that disagree: the input, which is what the client sends.
    // (zod's types refuse a string piped into a number; the cast builds the shape to convert.)
    expect(toJsonSchema(z.string().pipe(z.number() as unknown as z.ZodString))).toEqual({
      type: 'string',
    });
  });

  /**
   * Every wrapper kind the services' request schemas use, alone and under `.nullable()` and
   * `.optional()`, converts to a schema AJV compiles — never `{}` for a typed input, never a
   * `nullable` without a `type`.
   */
  describe('every wrapper kind keeps its input type and compiles under AJV', () => {
    const bounded = () => z.string().min(1).max(64);
    const WRAPPERS: Record<string, z.ZodType> = {
      refine: bounded().refine((value) => value !== 'x'),
      superRefine: bounded().superRefine(() => undefined),
      check: codePointLength(z.string(), 1, 64),
      overwrite: bounded().trim(),
      transform: bounded().transform((value) => value.toUpperCase()),
      preprocess: z.preprocess((value) => value, bounded()),
      'pipe between schemas': bounded()
        .transform((value) => value)
        .pipe(z.string().max(32)),
      'plain pipe': bounded().pipe(z.string().max(32)),
      // The converter's `default` branch is what is covered; no request schema should use it.
      // eslint-disable-next-line zod/no-default
      default: bounded().default('a'),
      prefault: bounded().prefault('a'),
      describe: bounded().describe('described'),
    };
    const ajv = new Ajv({ strict: true });
    addFormats(ajv);

    it.each(Object.entries(WRAPPERS))('%s', (_kind, schema) => {
      for (const variant of [schema, schema.nullable(), schema.optional()]) {
        const published = toJsonSchema(variant);
        expect(published).toMatchObject({ type: 'string', minLength: 1 });
        expect(published.maxLength).toBeLessThanOrEqual(64);
        expect(() => ajv.compile(published)).not.toThrow();
      }
    });

    it('publishes a nullable schema that says nothing as itself, not `{"nullable":true}`', () => {
      expect(toJsonSchema(z.unknown().nullable())).toEqual({});
      expect(() => ajv.compile(toJsonSchema(z.unknown().nullable()))).not.toThrow();
    });
  });

  it('keeps a description given on a wrapper', () => {
    expect(toJsonSchema(z.string().optional().describe('outer'))).toEqual({
      type: 'string',
      description: 'outer',
    });
  });

  it('counts codePointLength in code points, and raises the min/max issues', () => {
    const schema = codePointLength(z.string(), 2, 3);
    expect(schema.safeParse('😀😀😀').success).toBe(true);
    expect(schema.safeParse('😀😀😀😀').error?.issues.map((issue) => issue.code)).toEqual([
      'too_big',
    ]);
    expect(schema.safeParse('a').error?.issues.map((issue) => issue.code)).toEqual(['too_small']);
  });
});
