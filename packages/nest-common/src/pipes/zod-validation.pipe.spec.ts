import type { ArgumentMetadata, ArgumentsHost } from '@nestjs/common';
import type { Logger } from '@rasta/logging';
import { z, type ZodTypeAny } from 'zod';
import { AllExceptionsFilter } from '../filters/exception.filter';
import { RastaError } from '../errors/rasta-error';
import {
  REDACTED_SEGMENT,
  ZodValidationPipe,
  safePath,
  toErrorDetails,
} from './zod-validation.pipe';

/**
 * S-09: a validation failure's `details` go back to the caller and, inside the
 * error, to the log. They carry schema facts — path, code, a message — and
 * never the caller's own input. Each case below feeds a sentinel through the
 * real pipe and checks the details; the negative controls show that zod's own
 * output does carry it.
 */

const SENTINEL = 'SENTINEL-7c2e-national-id-0098765432';
const META: ArgumentMetadata = { type: 'body' };

/** Everything a value carries, Errors included (`JSON.stringify` drops their message and stack). */
function dump(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) =>
    field instanceof Error
      ? { ...field, name: field.name, message: field.message, stack: field.stack }
      : field,
  );
}

function refusal(schema: ZodTypeAny, input: unknown): RastaError {
  try {
    new ZodValidationPipe(schema).transform(input, META);
  } catch (error) {
    if (error instanceof RastaError) return error;
    throw error;
  }
  throw new Error('the pipe accepted the input');
}

function rawZodText(schema: ZodTypeAny, input: unknown): string {
  const result = schema.safeParse(input);
  if (result.success) throw new Error('zod accepted the input');
  return JSON.stringify(result.error.issues.map(({ path, message }) => ({ path, message })));
}

/** Every echoing case: the schema, an input carrying the sentinel, the issue code, the detail expected. */
const CASES: {
  name: string;
  schema: ZodTypeAny;
  input: unknown;
  expected: { path: string; code: string; message: string };
}[] = [
  {
    name: 'invalid_enum_value: zod quotes the value received',
    schema: z.object({ status: z.enum(['ACTIVE', 'RETIRED']) }),
    input: { status: SENTINEL },
    expected: {
      path: 'status',
      code: 'invalid_enum_value',
      message: "Invalid enum value. Expected 'ACTIVE' | 'RETIRED'",
    },
  },
  {
    name: 'invalid_enum_value on a native enum',
    schema: z.object({ level: z.nativeEnum({ LOW: 1, HIGH: 2 } as const) }),
    input: { level: SENTINEL },
    expected: {
      path: 'level',
      code: 'invalid_enum_value',
      message: 'Invalid enum value. Expected 1 | 2',
    },
  },
  {
    name: 'unrecognized_keys: zod lists the extra keys',
    schema: z.object({ name: z.string() }).strict(),
    input: { name: 'ok', [SENTINEL]: 1 },
    expected: {
      path: '(root)',
      code: 'unrecognized_keys',
      message: 'Unrecognized key(s) in object (1)',
    },
  },
  {
    name: 'a z.record key lands in the path',
    schema: z.object({ metadata: z.record(z.string(), z.number()) }),
    input: { metadata: { [SENTINEL]: 'not a number' } },
    expected: {
      path: `metadata.${REDACTED_SEGMENT}`,
      code: 'invalid_type',
      message: 'Expected number, received string',
    },
  },
  {
    name: 'a .catchall() key lands in the path',
    schema: z.object({ name: z.string() }).catchall(z.number()),
    input: { name: 'ok', [SENTINEL]: 'not a number' },
    expected: {
      path: REDACTED_SEGMENT,
      code: 'invalid_type',
      message: 'Expected number, received string',
    },
  },
  {
    name: 'custom: a refine message that interpolates the value',
    schema: z.object({
      reference: z.string().refine(
        (v) => v.startsWith('REF-'),
        (v) => ({ message: `${v} is not a reference` }),
      ),
    }),
    input: { reference: SENTINEL },
    expected: { path: 'reference', code: 'custom', message: 'Invalid input' },
  },
  {
    name: 'custom: a superRefine that interpolates another value under its path',
    schema: z
      .object({ window: z.object({ from: z.string(), to: z.string() }) })
      .superRefine((body, ctx) => {
        if (body.window.from > body.window.to) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['window'],
            message: `from ${body.window.from} is after to ${body.window.to}`,
          });
        }
      }),
    input: { window: { from: SENTINEL, to: 'A' } },
    expected: { path: 'window', code: 'custom', message: 'Invalid input' },
  },
  {
    name: 'invalid_type: a custom errorMap that interpolates the data',
    schema: z.object({
      amount: z.number({
        errorMap: (_issue, ctx) => ({ message: `bad amount ${String(ctx.data)}` }),
      }),
    }),
    input: { amount: SENTINEL },
    expected: { path: 'amount', code: 'invalid_type', message: 'Expected number, received string' },
  },
  {
    name: 'invalid_string: a regex errorMap that interpolates the data',
    schema: z.object({
      code: z
        .string({ errorMap: (_issue, ctx) => ({ message: `"${String(ctx.data)}" is malformed` }) })
        .regex(/^[A-Z]{3}$/),
    }),
    input: { code: SENTINEL },
    expected: { path: 'code', code: 'invalid_string', message: 'Invalid' },
  },
];

describe('ZodValidationPipe details (S-09)', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, { schema, input, expected }) => {
    // The control: zod's own issue list carries the sentinel.
    expect(rawZodText(schema, input)).toContain(SENTINEL);

    const error = refusal(schema, input);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toEqual([expected]);
    expect(dump(error)).not.toContain('SENTINEL');
  });

  it('reaches neither the response body nor the log line through the exception filter', () => {
    const lines: unknown[] = [];
    const record = (...args: unknown[]) => {
      lines.push(args);
    };
    const logger = { debug: record, warn: record, error: record } as unknown as Logger;
    let body: unknown;
    const response = {
      status: () => response,
      json: (sent: unknown) => {
        body = sent;
      },
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;

    for (const { schema, input } of CASES) {
      new AllExceptionsFilter(logger).catch(refusal(schema, input), host);
      expect(dump(body)).not.toContain('SENTINEL');
    }
    expect(lines).toHaveLength(CASES.length);
    expect(dump(lines)).not.toContain('SENTINEL');
  });
});

describe('what the details keep', () => {
  it('declared field names, array indexes and zod’s default messages', () => {
    const schema = z.object({
      items: z.array(z.object({ quantity: z.number().int().positive() })).min(1),
      note: z.string().max(5).optional(),
    });
    const error = refusal(schema, { items: [{ quantity: 1 }, { quantity: -2 }], note: 'too long' });
    expect(error.details).toEqual([
      { path: 'items[1].quantity', code: 'too_small', message: 'Number must be greater than 0' },
      { path: 'note', code: 'too_big', message: 'String must contain at most 5 character(s)' },
    ]);
  });

  it('a static schema message — the service’s own guidance', () => {
    const schema = z.object({
      name: z.string().regex(/^[A-Z_]+$/, 'Event names are SCREAMING_SNAKE_CASE'),
      window: z
        .object({ from: z.string(), to: z.string() })
        .refine((w) => w.from <= w.to, { message: 'from must not be after to', path: ['to'] }),
    });
    const error = refusal(schema, { name: SENTINEL.toLowerCase(), window: { from: 'b', to: 'a' } });
    expect(error.details).toEqual([
      { path: 'name', code: 'invalid_string', message: 'Event names are SCREAMING_SNAKE_CASE' },
      { path: 'window.to', code: 'custom', message: 'from must not be after to' },
    ]);
  });

  it('a static message that merely contains a short input — below the backstop length', () => {
    const schema = z.object({
      size: z.enum(['S', 'M'], { errorMap: () => ({ message: 'Pick S or M' }) }),
    });
    const error = refusal(schema, { size: 'M!' });
    expect(error.details).toEqual([
      { path: 'size', code: 'invalid_enum_value', message: 'Pick S or M' },
    ]);
  });

  it('the Required message for a missing field', () => {
    const error = refusal(z.object({ id: z.string() }), {});
    expect(error.details).toEqual([{ path: 'id', code: 'invalid_type', message: 'Required' }]);
  });
});

describe('safePath: which segments the schema declares', () => {
  const schema = z
    .object({
      wrapped: z
        .object({ inner: z.string() })
        .optional()
        .nullable()
        .default({ inner: 'x' })
        .transform((v) => v),
      list: z.array(z.record(z.string(), z.object({ leaf: z.string() }))),
      either: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
      tagged: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('X'), x: z.string() }),
        z.object({ kind: z.literal('Y'), y: z.string() }),
      ]),
      both: z.intersection(z.object({ l: z.string() }), z.object({ r: z.string() })),
      pair: z.tuple([z.string(), z.object({ t: z.string() })]),
      later: z.lazy(() => z.object({ deep: z.string() })),
      loose: z.any(),
    })
    .refine(() => true);

  it.each([
    [
      ['wrapped', 'inner'],
      ['wrapped', 'inner'],
    ],
    [
      ['list', 3, SENTINEL, 'leaf'],
      ['list', 3, REDACTED_SEGMENT, 'leaf'],
    ],
    [
      ['either', 'b'],
      ['either', 'b'],
    ],
    [
      ['tagged', 'y'],
      ['tagged', 'y'],
    ],
    [
      ['both', 'r'],
      ['both', 'r'],
    ],
    [
      ['pair', 1, 't'],
      ['pair', 1, 't'],
    ],
    [
      ['later', 'deep'],
      ['later', 'deep'],
    ],
    [
      ['loose', SENTINEL],
      ['loose', REDACTED_SEGMENT],
    ],
    [
      [SENTINEL, 'anything'],
      [REDACTED_SEGMENT, REDACTED_SEGMENT],
    ],
  ] as const)('%j → %j', (path, shown) => {
    expect(safePath(schema, path)).toEqual(shown);
  });

  it('needs the schema: the exported converter takes it', () => {
    const schema = z.object({ tags: z.record(z.string(), z.number()) });
    const result = schema.safeParse({ tags: { [SENTINEL]: 'x' } });
    if (result.success) throw new Error('accepted');
    expect(toErrorDetails(result.error, schema, { tags: { [SENTINEL]: 'x' } })[0]?.path).toBe(
      `tags.${REDACTED_SEGMENT}`,
    );
  });
});
