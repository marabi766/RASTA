import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { z } from 'zod';
import { isoDateTime, parsableUrl, prefixedIdSchema, seedIdSchema } from '@rasta/contracts';
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
 * One deliberate difference was written into it by hand, not re-recorded: the
 * `instant` field's `pattern` and `description`, the offset bound `isoDateTime()`
 * enforces and `format: date-time` alone does not publish (FU-035).
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
    expect(
      toJsonSchema(
        z
          .string()
          .regex(/^[a-z ]*$/)
          .pipe(z.string().min(1).max(64)),
      ),
    ).toEqual({
      type: 'string',
      pattern: '^[a-z ]*$',
      minLength: 1,
      maxLength: 64,
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
   * FU-078 r2 F2: a JSON Schema validator checks the raw request text, so a bound the later schema
   * applies to a transformed value is not a bound on what the client sends. `identifierText()`
   * canonicalised then checked `max(64)`; merging that bound refused 67 raw characters the service
   * accepted (tatweel padding) — the input's own schema is published, and nothing of the later one.
   */
  it('does not publish the later schema of a pipe whose input changes the value', () => {
    const changed: Record<string, z.ZodType> = {
      transform: z
        .string()
        .regex(/^[a-z ]*$/)
        .transform((value) => value.replace(/ /g, ''))
        .pipe(z.string().min(1).max(64)),
      overwrite: z.string().trim().pipe(z.string().min(1).max(64)),
      'nested transform': z
        .string()
        .transform((value) => value)
        .optional()
        .pipe(z.string().max(64).optional()),
      'unknown kind': z.array(z.string()).pipe(z.array(z.string()).max(2)),
    };
    const published = Object.fromEntries(
      Object.entries(changed).map(([kind, schema]) => [kind, toJsonSchema(schema.nullable())]),
    );
    expect(published).toEqual({
      transform: { type: 'string', pattern: '^[a-z ]*$', nullable: true },
      overwrite: { type: 'string', nullable: true },
      'nested transform': { type: 'string', nullable: true },
      'unknown kind': { type: 'array', items: { type: 'string' }, nullable: true },
    });
    // The value that reached the later schema is not the one a validator of the document sees.
    const padded = 'abc' + ' '.repeat(64);
    expect(changed.transform!.safeParse(padded).success).toBe(true);
    expect(padded.length).toBeGreaterThan(64);
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

  it('publishes the pattern an identifier refinement is tested against (FU-073)', () => {
    const ulid = '[0-9A-HJKMNP-TV-Z]{26}';
    expect(toJsonSchema(prefixedIdSchema('AST').optional())).toEqual({
      type: 'string',
      pattern: `^AST_${ulid}$`,
      description: 'AST identifier',
    });
    expect(toJsonSchema(seedIdSchema('ORG').describe('owner'))).toEqual({
      anyOf: [
        { type: 'string', pattern: `^ORG_${ulid}$`, description: 'ORG identifier' },
        { type: 'string', pattern: '^ORG-[A-Z0-9-]{1,48}$' },
      ],
      description: 'owner',
    });
    // A clone keeps the check, so it keeps the pattern; a flagged one is not published.
    expect(toJsonSchema(prefixedIdSchema('PO').describe('order'))).toMatchObject({
      pattern: `^PO_${ulid}$`,
    });
    const flagged = z.refine<string>((value) => /^a$/i.test(value));
    Object.defineProperty(flagged, Symbol.for('rasta.openapi.publishedPattern'), { value: /^a$/i });
    expect(toJsonSchema(z.string().check(flagged))).toEqual({ type: 'string' });
  });

  it('counts codePointLength in code points, and raises the min/max issues', () => {
    const schema = codePointLength(z.string(), 2, 3);
    expect(schema.safeParse('😀😀😀').success).toBe(true);
    expect(schema.safeParse('😀😀😀😀').error?.issues.map((issue) => issue.code)).toEqual([
      'too_big',
    ]);
    expect(schema.safeParse('a').error?.issues.map((issue) => issue.code)).toEqual(['too_small']);
  });

  describe('an isoDateTime() field publishes the zone it accepts (FU-035)', () => {
    const at = '2026-11-04T12:00:00';
    // suffix, accepted with { offset: true }, accepted UTC-only
    const cases: Array<[string, boolean, boolean]> = [
      ['Z', true, true],
      ['.123Z', true, true],
      ['+14:00', true, false],
      ['-14:00', true, false],
      ['+1400', true, false],
      ['+13:59', true, false],
      ['-03:30', true, false],
      ['+14:01', false, false],
      ['+15:00', false, false],
      ['-23:59', false, false],
      ['+24:00', false, false],
      ['', false, false],
    ];

    it.each(cases)('%s: the published pattern and the check agree', (suffix, offset, utc) => {
      for (const [options, accepted] of [
        [{ offset: true }, offset],
        [{}, utc],
      ] as const) {
        const field = z.string().check(isoDateTime(options));
        const published = toJsonSchema(field) as { pattern: string };
        expect(field.safeParse(`${at}${suffix}`).success).toBe(accepted);
        expect(new RegExp(published.pattern, 'u').test(`${at}${suffix}`)).toBe(accepted);
      }
    });

    it('keeps a field’s own description first and the bound after it', () => {
      const field = z.string().check(isoDateTime()).optional().describe('When it ends.');
      expect(toJsonSchema(field)).toEqual({
        type: 'string',
        format: 'date-time',
        pattern: 'Z$',
        description:
          'When it ends. ISO 8601 instant that ends in `Z` (UTC); a numeric offset (`+03:30`) is ' +
          'invalid here.',
      });
    });
  });
});
