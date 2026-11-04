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

  it('leaves a discriminated union and a pipe between two schemas undescribed, as before', () => {
    // zod 3 had a type of its own for each, which the converter did not know; in
    // zod 4 a discriminated union is a union and `.pipe()` a pipe, and still `{}`.
    const tagged = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('A') }),
      z.object({ kind: z.literal('B') }),
    ]);
    expect(toJsonSchema(tagged)).toEqual({});
    expect(toJsonSchema(z.string().pipe(z.enum(['X'])))).toEqual({});
    // A plain union is still described.
    expect(toJsonSchema(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
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
