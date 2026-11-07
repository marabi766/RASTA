import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { z } from 'zod';
import {
  isoDateTime,
  numberInput,
  offsetPaginationSchema,
  parsableUrl,
  patternRefinement,
  plainText,
  prefixedIdSchema,
  seedIdSchema,
  WITHOUT_BIDI_CONTROL,
} from '@rasta/contracts';
import { queryBoolean } from '@rasta/config';
import { codePointLength, objectShapeOf, toJsonSchema } from './zod-schema';

/**
 * The shared converter, construct by construct.
 *
 * The services' own `openapi/zod-schema.spec.ts` keep pinning their DTOs; this
 * covers every branch once, including the ones only some services' copies had
 * (array bounds, `queryBoolean`, `codePointLength`). The snapshot beside this
 * file was recorded under **zod 3.25.76** and is the oracle for the zod 4
 * converter (GHSA-mrhx-c7xc-m3w5, PR B): never re-record it (`-u`) to make a
 * migration pass — every service's generated document depends on these bytes.
 * Deliberate corrections were written by hand, not re-recorded: FU-152 omits
 * case-insensitive patterns; FU-120 omits
 * post-trim code-point bounds and marks unknown refinements; the
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

  it('FU-131 publishes the registered inner integer through descriptions and wrappers', () => {
    const properties = toJsonSchema(offsetPaginationSchema).properties as Record<string, unknown>;
    expect(properties.pageSize).toMatchInlineSnapshot(`
      {
        "default": 25,
        "maximum": 200,
        "minimum": 1,
        "type": "integer",
      }
    `);
    expect(
      toJsonSchema(
        numberInput(z.number().int().min(1).max(10)).describe('Page size').optional().nullable(),
      ),
    ).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description: 'Page size',
      nullable: true,
    });
    expect(toJsonSchema(numberInput(z.number().min(-90).max(90)))).toEqual({
      type: 'number',
      minimum: -90,
      maximum: 90,
    });
  });

  it('FU-160 accepts JS exponent serialization under the published coordinate bounds', () => {
    const field = numberInput(z.number().min(-90).max(90)).describe('Latitude').optional();
    expect(toJsonSchema(field)).toEqual({
      type: 'number',
      minimum: -90,
      maximum: 90,
      description: 'Latitude',
    });
    for (const value of [1e-7, -1e-7, Number.MIN_VALUE, 91, -91]) {
      const parsed = field.safeParse(String(value));
      expect(parsed.success).toBe(field.safeParse(value).success);
      if (parsed.success) expect(parsed.data).toBe(value);
    }
    expect(field.safeParse('1e9999').success).toBe(false);
  });

  it('FU-131 does not publish a different schema piped from a registered transform', () => {
    const input = numberInput(z.number().int().min(1));
    const forged = z.pipe(input.in, z.number().max(100));
    expect(toJsonSchema(forged)).toEqual({
      description: expect.stringContaining('Constraints after a value-changing step are omitted'),
    });
  });

  const boundedText = (schema = z.string()) =>
    schema
      .min(1)
      .max(3)
      .regex(/^[a-z]+$/);
  const changingSteps = {
    trim: boundedText(z.string().trim()),
    lowercase: boundedText(z.string().toLowerCase()),
    transform: z
      .string()
      .transform((v) => v.trim())
      .pipe(boundedText()),
    // eslint-disable-next-line zod/coercion-boundary -- Diagnostic schema: arbitrary preprocess output must never be published as raw input.
    preprocess: z.preprocess((v) => String(v).trim(), boundedText()),
    pipe: z.string().trim().pipe(boundedText()),
    'wrapped custom check': z
      .string()
      .pipe(z.string())
      .check((ctx) => {
        ctx.value = ctx.value.trim();
      })
      .pipe(boundedText()),
    'custom check': boundedText(
      z.string().check((ctx) => {
        ctx.value = ctx.value.trim();
      }),
    ),
  };
  it.each(Object.entries(changingSteps))(
    'omits post-%s constraints on raw input (FU-120)',
    (kind, schema) => {
      const accepted = kind === 'lowercase' ? 'ABC' : ' abc ';
      const published = toJsonSchema(schema);
      expect(schema.safeParse(accepted).success).toBe(true);
      expect(schema.safeParse('   ').success).toBe(false);
      for (const key of ['minLength', 'maxLength', 'pattern'])
        expect(published[key]).toBeUndefined();
      expect(published.description).toContain(
        'Constraints after a value-changing step are omitted',
      );
      expect(new Ajv().compile(published)(accepted)).toBe(true);
    },
  );

  it('retains only checks before the first overwrite, including code-point bounds', () => {
    const schema = codePointLength(
      z
        .string()
        .min(2)
        .max(20)
        .regex(/^[a-z ]+$/),
      2,
      10,
    )
      .trim()
      .min(3)
      .max(5)
      .regex(/^[a-z]+$/);
    expect(toJsonSchema(schema)).toMatchObject({
      minLength: 2,
      maxLength: 10,
      pattern: '^[a-z ]+$',
    });
    expect(toJsonSchema(codePointLength(z.string().trim(), 1, 3))).toEqual({
      type: 'string',
      description:
        'Constraints after a value-changing step are omitted; validation applies them to the transformed value.',
    });
    expect(
      toJsonSchema(
        z
          .string()
          .overwrite((v) => v.slice(0, 3))
          .max(3),
      ),
    ).toEqual({
      type: 'string',
      description:
        'Constraints after a value-changing step are omitted; validation applies them to the transformed value.',
    });
    // eslint-disable-next-line zod/coercion-boundary -- Diagnostic schema: string coercion must not publish its output constraints.
    expect(toJsonSchema(z.coerce.string().min(1).max(3))).toEqual({
      description:
        'Constraints after a value-changing step are omitted; validation applies them to the transformed value.',
    });
  });

  it.each(['overwrite', 'custom check'] as const)(
    'omits number checks after %s but keeps the raw prefix (P2/P4, FU-120)',
    (step) => {
      const prefix = z.number().min(0).max(100);
      const schema = (
        step === 'overwrite'
          ? prefix.overwrite(() => 5)
          : prefix.check((ctx) => {
              ctx.value = 5;
            })
      )
        .int()
        .min(1)
        .max(5);
      expect(schema.parse(99.5)).toBe(5);
      const published = toJsonSchema(schema);
      expect(published).toMatchObject({ type: 'number', minimum: 0, maximum: 100 });
      expect(published.description).toContain(
        'Constraints after a value-changing step are omitted',
      );
      expect(new Ajv().compile(published)(99.5)).toBe(true);
    },
  );

  it.each(['overwrite', 'custom check'] as const)(
    'omits array checks after %s but keeps the raw prefix (P3, FU-120)',
    (step) => {
      const prefix = z.array(z.string()).min(1).max(10);
      const schema = (
        step === 'overwrite'
          ? prefix.overwrite((v) => v.slice(0, 1))
          : prefix.check((ctx) => {
              ctx.value = ctx.value.slice(0, 1);
            })
      )
        .min(1)
        .max(2);
      const raw = ['x', 'x', 'x'];
      expect(schema.parse(raw)).toEqual(['x']);
      const published = toJsonSchema(schema);
      expect(published).toMatchObject({ type: 'array', minItems: 1, maxItems: 10 });
      expect(published.description).toContain(
        'Constraints after a value-changing step are omitted',
      );
      expect(new Ajv().compile(published)(raw)).toBe(true);
    },
  );

  it('omits the output type and bounds of numeric coercion', () => {
    // eslint-disable-next-line zod/coercion-boundary -- Diagnostic schema: coerced numbers are not raw numeric input.
    const schema = z.coerce.number().int().min(0).max(5);
    expect(schema.parse('')).toBe(0);
    expect(toJsonSchema(schema)).toEqual({
      description:
        'Constraints after a value-changing step are omitted; validation applies them to the transformed value.',
    });
  });

  it('publishes the plainText bidi pattern before trim without changing accepted text (F3)', () => {
    const schema = plainText().min(1).max(3);
    const published = toJsonSchema(schema);
    expect(published.pattern).toBe(WITHOUT_BIDI_CONTROL.source);
    expect(published.minLength).toBeUndefined();
    expect(published.maxLength).toBeUndefined();
    expect(schema.parse('  abc  ')).toBe('abc');
    const pattern = new RegExp(String(published.pattern), 'u');
    // Every Bidi_Control, including the Arabic letter mark; none is removed by trim.
    for (const cp of [
      0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068,
      0x2069,
    ]) {
      const raw = ` ${String.fromCodePoint(cp)}a `;
      expect(pattern.test(raw)).toBe(false);
      expect(schema.safeParse(raw).success).toBe(false);
    }
  });

  it('keeps the omission marker through pipe descriptions and optional/nullable wrappers', () => {
    const schema = z
      .string()
      .describe('Raw text.')
      .pipe(z.string().max(10).trim().min(2))
      .optional()
      .nullable()
      .describe('Outer text.');
    expect(toJsonSchema(schema)).toEqual({
      type: 'string',
      maxLength: 10,
      nullable: true,
      description:
        'Outer text. Raw text. Constraints after a value-changing step are omitted; validation applies them to the transformed value.',
    });
  });

  it('refuses to publish query fields after an opaque object preprocessor', () => {
    expect(() => objectShapeOf(z.preprocess((v) => v, z.object({ q: z.string().max(3) })))).toThrow(
      'Cannot publish query fields after a value-changing preprocessor',
    );
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
      transform: {
        type: 'string',
        pattern: '^[a-z ]*$',
        nullable: true,
        description:
          'Constraints after a value-changing step are omitted; validation applies them to the transformed value.',
      },
      overwrite: {
        type: 'string',
        nullable: true,
        description:
          'Constraints after a value-changing step are omitted; validation applies them to the transformed value.',
      },
      'nested transform': {
        type: 'string',
        nullable: true,
        description:
          'Constraints after a value-changing step are omitted; validation applies them to the transformed value.',
      },
      'unknown kind': {
        type: 'array',
        items: { type: 'string' },
        nullable: true,
        description:
          'Constraints after a value-changing step are omitted; validation applies them to the transformed value.',
      },
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
    // A clone keeps the registered check, so it keeps the pattern.
    expect(toJsonSchema(prefixedIdSchema('PO').describe('order'))).toMatchObject({
      pattern: `^PO_${ulid}$`,
    });
  });

  describe.each(['regex', 'registered refinement'] as const)('FU-152 %s flags', (path) => {
    const makeSchema = (pattern: RegExp) =>
      path === 'regex'
        ? z.string().regex(pattern)
        : z.string().check(patternRefinement(pattern, 'Invalid pattern'));

    it.each(['', 'u'])('publishes flags=%j and compiles with Unicode semantics', (flags) => {
      const pattern = new RegExp('^[a-z]+$', flags);
      const schema = makeSchema(pattern).max(3).pipe(z.string().min(1));
      const published = toJsonSchema(schema);
      expect(published).toEqual({
        type: 'string',
        pattern: pattern.source,
        minLength: 1,
        maxLength: 3,
      });
      const validate = new Ajv({ unicodeRegExp: true }).compile(published);
      for (const input of ['a', 'abc', '', 'A', 'abcd']) {
        expect(validate(input)).toBe(schema.safeParse(input).success);
      }
    });

    it('publishes Unicode property escapes for consumers using u', () => {
      const pattern = /^\p{Letter}+$/u;
      const published = toJsonSchema(makeSchema(pattern));
      expect(published).toEqual({ type: 'string', pattern: pattern.source });
      const validate = new Ajv({ unicodeRegExp: true }).compile(published);
      for (const input of ['a', 'é', 'ش', '1']) expect(validate(input)).toBe(pattern.test(input));
    });

    it.each(['i', 'm', 's', 'g', 'y', 'd', 'v', 'iu', 'mu', 'su', 'gu', 'yu', 'du'])(
      'omits flags=%j without making a value-preserving check a barrier',
      (flags) => {
        const schema = makeSchema(new RegExp('^a$', flags)).max(3).pipe(z.string().min(1));
        expect(toJsonSchema(schema)).toEqual({ type: 'string', minLength: 1, maxLength: 3 });
      },
    );

    it('keeps another safe pattern when a flagged pattern is omitted', () => {
      const safe = z.string().regex(/^[a-z]+$/);
      const flagged = makeSchema(/^a$/i);
      const checks = flagged._zod.def.checks ?? [];
      expect(toJsonSchema(safe.check(...checks))).toEqual({ type: 'string', pattern: '^[a-z]+$' });
    });
  });

  it('FU-152 refuses a forged published-pattern marker on a mutating check', () => {
    const mutating = z.check<string>((payload) => {
      payload.value = payload.value.trim();
    });
    Object.defineProperty(mutating, Symbol.for('rasta.openapi.publishedPattern'), {
      value: /^[a-z]+$/,
    });
    const schema = z.string().check(mutating).max(3).pipe(z.string().min(3));
    expect(schema.parse(' abc ')).toBe('abc');
    const published = toJsonSchema(schema);
    expect(published).toEqual({
      type: 'string',
      description: expect.stringContaining('Constraints after a value-changing step are omitted'),
    });
    expect(new Ajv().compile(published)(' abc ')).toBe(true);
  });

  it('keeps identifier checks within the ordered raw-constraint prefix (FU-073/FU-120)', () => {
    const identifier = prefixedIdSchema('AST');
    const checks = identifier._zod.def.checks ?? [];
    const pattern = '^AST_[0-9A-HJKMNP-TV-Z]{26}$';
    const omission =
      'Constraints after a value-changing step are omitted; validation applies them to the transformed value.';
    // A known identifier refinement does not hide later bounds or pipe constraints.
    expect(toJsonSchema(identifier.max(30).pipe(z.string().min(30)))).toMatchObject({
      pattern,
      minLength: 30,
      maxLength: 30,
    });
    // Both kinds of barrier withhold only checks that execute after them.
    const barriers = [
      z.string().trim(),
      z.string().check((payload) => {
        payload.value = payload.value.trim();
      }),
    ];
    for (const barrier of barriers) {
      expect(toJsonSchema(barrier.check(...checks).max(30))).toEqual({
        type: 'string',
        description: omission,
      });
      expect(toJsonSchema(identifier.check(...(barrier._zod.def.checks ?? [])).max(30))).toEqual({
        type: 'string',
        pattern,
        description: `AST identifier ${omission}`,
      });
    }
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
