import { z } from 'zod';
import { isoDateTime } from '@rasta/contracts';
import { codePointLength } from '../openapi/zod-schema';
import { RastaError } from '../errors/rasta-error';
import { zodPipe } from './zod-validation.pipe';

/**
 * Golden fixtures for the zod 4 migration (GHSA-mrhx-c7xc-m3w5, PR B): what a
 * client reads back from the shared pipe, `{ path, code, message }` per issue,
 * for every issue kind the services' schemas raise — and the parse itself where
 * one succeeds.
 *
 * The snapshot beside this file was recorded under **zod 3.25.76** and is the
 * oracle B is measured against (B changed only what the zod 4 API forces in the
 * schemas below — `error` for `errorMap`, `continue: false` for `fatal`, a
 * record's key schema, `isoDateTime()` for `.datetime()` — never the snapshot): codes, declared paths, `*` for client-chosen
 * segments, rebuilt enum and unknown-key messages, the echo backstop, schema
 * messages (Persian included) kept as written. Never re-record it (`-u`) to
 * make a migration pass: a difference is a behaviour change, fixed in the code.
 *
 * One thing is deliberately not pinned: an over-cap array of invalid elements.
 * zod 3 reports every element after `too_big` — the advisory itself, and what
 * B changes.
 */

type Outcome = { parsed: unknown } | { status: number; code: string; details: unknown };

function outcome(schema: z.ZodType, input: unknown): Outcome {
  try {
    return { parsed: zodPipe(schema).transform(input, { type: 'body' }) };
  } catch (error) {
    if (error instanceof RastaError) {
      return { status: error.status, code: error.code, details: error.details };
    }
    throw error;
  }
}

const cases = (schema: z.ZodType, inputs: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, outcome(schema, input)]));

const SENTINEL = 'sentinel-input-value';

describe('zod-3 golden: the pipe’s issue details', () => {
  it('invalid_type, from a missing field to a wrong root', () => {
    const schema = z
      .object({
        name: z.string(),
        count: z.number(),
        count2: z.number().int(),
        when: z.date(),
        flag: z.boolean(),
        list: z.array(z.string()),
        nested: z.object({ inner: z.string() }).strict(),
      })
      .strict();
    expect(
      cases(schema, {
        missing: {},
        wrongTypes: {
          name: 7,
          count: '7',
          count2: 7.5,
          when: '2026-01-01',
          flag: 'true',
          list: 'a',
          nested: { inner: null },
        },
        rootNull: null,
        rootArray: [],
        rootString: SENTINEL,
      }),
    ).toMatchSnapshot();
  });

  it('string formats and bounds', () => {
    const schema = z
      .object({
        email: z.string().email().optional(),
        url: z.string().url().optional(),
        instant: z.string().check(isoDateTime()).optional(),
        offsetInstant: z
          .string()
          .check(isoDateTime({ offset: true }))
          .optional(),
        localInstant: z
          .string()
          .check(isoDateTime({ offset: false }))
          .optional(),
        day: z.string().date().optional(),
        code: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .optional(),
        messaged: z.string().regex(/^\d+$/, 'Amount must be digits').optional(),
        bounded: z.string().min(3).max(5).optional(),
        exact: z.string().length(4).optional(),
        filled: z.string().trim().min(1).optional(),
        prefix: z.string().startsWith('ORG-').optional(),
        suffix: z.string().endsWith('.pdf').optional(),
        codePoints: codePointLength(z.string(), 2, 3).optional(),
      })
      .strict();
    expect(
      cases(schema, {
        allBad: {
          email: SENTINEL,
          url: SENTINEL,
          instant: SENTINEL,
          offsetInstant: '2026-01-01T00:00:00',
          localInstant: '2026-01-01T00:00:00Z',
          day: '2026-02-30',
          code: SENTINEL,
          messaged: SENTINEL,
          bounded: 'ab',
          exact: 'abc',
          filled: '   ',
          prefix: SENTINEL,
          suffix: SENTINEL,
          codePoints: '😀😀😀😀',
        },
        tooLong: { bounded: 'abcdef', codePoints: 'a' },
        allGood: {
          email: 'a@b.ir',
          url: 'https://example.ir/x',
          instant: '2026-01-01T00:00:00.123Z',
          offsetInstant: '2026-01-01T00:00:00+03:30',
          localInstant: '2026-01-01T00:00:00',
          day: '2026-02-28',
          code: 'IRR',
          messaged: '12',
          bounded: 'abcd',
          exact: 'abcd',
          filled: '  x  ',
          prefix: 'ORG-1',
          suffix: 'a.pdf',
          codePoints: '😀😀',
        },
      }),
    ).toMatchSnapshot();
  });

  it('number and array bounds', () => {
    const schema = z
      .object({
        positive: z.number().positive().optional(),
        nonnegative: z.number().int().nonnegative().optional(),
        ranged: z.number().int().min(1).max(10).optional(),
        finite: z.number().finite().optional(),
        // A recorded zod 3 case B is measured against, not a request schema: #393 bars
        // z.coerce from those, and this keeps the snapshot it was recorded with.
        // eslint-disable-next-line no-restricted-syntax
        coerced: z.coerce.number().int().min(1).optional(),
        list: z.array(z.string()).min(1).max(2).optional(),
        nonempty: z.array(z.string()).nonempty().optional(),
      })
      .strict();
    expect(
      cases(schema, {
        low: { positive: 0, nonnegative: -1, ranged: 0, coerced: '0', list: [], nonempty: [] },
        high: { ranged: 11, list: ['a', 'b', 'c'] },
        notNumbers: { coerced: 'abc', finite: Number.POSITIVE_INFINITY },
        elements: { list: ['a', 7] },
        coercedOk: { coerced: ' 12 ' },
      }),
    ).toMatchSnapshot();
  });

  it('enums, literals, unions and discriminated unions', () => {
    const shape = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('A'), a: z.string() }).strict(),
      z.object({ kind: z.literal('B'), b: z.number() }).strict(),
    ]);
    const schema = z
      .object({
        status: z.enum(['OPEN', 'CLOSED']).optional(),
        version: z.literal(1).optional(),
        word: z.literal('yes').optional(),
        either: z.union([z.string().min(2), z.number()]).optional(),
        objects: z
          .union([z.object({ x: z.string() }).strict(), z.object({ y: z.number() }).strict()])
          .optional(),
        shape: shape.optional(),
      })
      .strict();
    expect(
      cases(schema, {
        bad: {
          status: SENTINEL,
          version: 2,
          word: SENTINEL,
          either: true,
          objects: { z: 1 },
          shape: { kind: 'C' },
        },
        shapeFields: { either: 'a', shape: { kind: 'B', b: 'not a number' } },
        shapeMissing: { shape: {} },
        good: {
          status: 'OPEN',
          version: 1,
          word: 'yes',
          either: 3,
          objects: { y: 1 },
          shape: { kind: 'A', a: 'x' },
        },
      }),
    ).toMatchSnapshot();
  });

  it('unknown keys, records, catchall and array paths', () => {
    const schema = z
      .object({
        metadata: z.record(z.string(), z.number()).optional(),
        labels: z.object({ fixed: z.string() }).catchall(z.number()).optional(),
        items: z.array(z.object({ quantity: z.number().int().positive() }).strict()).optional(),
      })
      .strict();
    expect(
      cases(schema, {
        unknownKeys: { [SENTINEL]: 1, another: 2 },
        recordValue: { metadata: { [SENTINEL]: 'x', ok: 1 } },
        catchallValue: { labels: { fixed: 'f', [SENTINEL]: 'x' } },
        nestedUnknown: { items: [{ quantity: 1 }, { quantity: 0, [SENTINEL]: true }] },
      }),
    ).toMatchSnapshot();
  });

  it('refinements, schema messages and the echo backstop', () => {
    const schema = z
      .object({
        plain: z
          .string()
          .refine((v) => v.length > 3)
          .optional(),
        stated: z
          .string()
          .refine((v) => v.length > 3, 'Must be longer than three characters')
          .optional(),
        echoing: z
          .string()
          .refine(() => false, { error: (issue) => `"${String(issue.input)}" is not allowed` })
          .optional(),
        persian: z.enum(['A', 'B'], { error: 'یکی از گزینه‌ها را برگزینید' }).optional(),
        persianType: z.string({ error: 'متن لازم است' }).optional(),
        fatal: z
          .string()
          .superRefine((_v, ctx) => {
            ctx.addIssue({ code: 'custom', message: 'stopped here', continue: false });
          })
          .refine(() => false, 'never reached')
          .optional(),
        transformed: z
          .string()
          .transform((v) => v.toUpperCase())
          .pipe(z.enum(['X', 'Y']))
          .optional(),
        preprocessed: z
          .preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().min(2))
          .optional(),
        caught: z.number().catch(0).optional(),
        defaulted: z.number().prefault(5),
        lazy: z.lazy(() => z.object({ leaf: z.string() }).strict()).optional(),
      })
      .strict()
      .superRefine((dto, ctx) => {
        if (dto.plain === 'cross') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['stated'],
            message: 'Cross-field rule',
          });
        }
      });
    expect(
      cases(schema, {
        bad: {
          plain: 'ab',
          stated: 'ab',
          echoing: SENTINEL,
          persian: 'C',
          persianType: 7,
          fatal: 'x',
          transformed: 'z',
          preprocessed: '  a  ',
          caught: 'not a number',
          lazy: { leaf: 1 },
        },
        crossField: { plain: 'cross' },
        good: { transformed: 'x', preprocessed: '  ab ', caught: 'n', lazy: { leaf: 'l' } },
      }),
    ).toMatchSnapshot();
  });

  it('a message the backstop cannot check: more than 200 input leaves (a key and a value each)', () => {
    const schema = z
      .object({
        bag: z
          .record(z.string(), z.string())
          .refine(() => false, 'a fixed schema message')
          .optional(),
      })
      .strict();
    const bag = (entries: number) =>
      Object.fromEntries(Array.from({ length: entries }, (_, i) => [`k${i}`, `v${i}`]));
    expect(
      cases(schema, { atLimit: { bag: bag(100) }, overLimit: { bag: bag(101) } }),
    ).toMatchSnapshot();
  });
});
