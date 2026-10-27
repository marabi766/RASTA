import { z } from 'zod';
import { isoDateTime, parsableUrl } from '@rasta/contracts';
import { codePointLength, toJsonSchema, type JsonSchema } from '@rasta/nest-common';
import {
  aggregationViewSchema,
  cancelAggregationSchema,
  listDemandsQuerySchema,
  withdrawDemandSchema,
} from '../demand/dto';

/**
 * The bridge between what the service validates with and what it publishes.
 *
 * These assertions are about a contract a client generates code from, so the
 * failure they guard is not a crash: it is a published document that quietly
 * disagrees with the running service, which a client only discovers as a 400
 * it could not have predicted.
 */

describe('the constructs the demand DTOs are built from', () => {
  it('publishes a string with its bounds', () => {
    expect(toJsonSchema(z.string().min(8).max(500))).toEqual({
      type: 'string',
      minLength: 8,
      maxLength: 500,
    });
  });

  it('publishes an integer as an integer, with its range', () => {
    // `type: 'number'` for a field the service refuses unless it is a whole
    // number would send a client to submit 1.5 and be told no.
    expect(toJsonSchema(z.number().int().min(1).max(100))).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 100,
    });
  });

  it('publishes an enum as its actual values', () => {
    expect(toJsonSchema(z.enum(['PROCUREMENT', 'OTHER']))).toEqual({
      type: 'string',
      enum: ['PROCUREMENT', 'OTHER'],
    });
  });

  it('publishes a regex as the pattern that actually runs', () => {
    // The source's own flags rather than a re-spelling, so the published
    // pattern is the one the service enforces.
    const schema = toJsonSchema(z.string().regex(/^DOC_[0-9A-Z]{26}$/));
    expect(schema.pattern).toBe('^DOC_[0-9A-Z]{26}$');
  });

  it('publishes the formats a client can validate against', () => {
    expect(toJsonSchema(z.string().check(parsableUrl())).format).toBe('uri');
    expect(toJsonSchema(z.string().email()).format).toBe('email');
    expect(toJsonSchema(z.string().check(isoDateTime())).format).toBe('date-time');
  });

  it('publishes a default rather than hiding it', () => {
    expect(toJsonSchema(z.number().int().prefault(25))).toEqual({
      type: 'integer',
      default: 25,
    });
  });

  it('unwraps optional and nullable to their inner type', () => {
    expect(toJsonSchema(z.string().optional())).toEqual({ type: 'string' });
    expect(toJsonSchema(z.string().nullable())).toEqual({ type: 'string', nullable: true });
  });

  it('publishes an array with its bounds and item type', () => {
    expect(toJsonSchema(z.array(z.string()).min(1).max(50))).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 50,
    });
  });

  it('publishes a union as anyOf', () => {
    expect(toJsonSchema(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('publishes a literal as a const', () => {
    expect(toJsonSchema(z.literal('CLEAN'))).toEqual({ const: 'CLEAN' });
  });

  it('publishes a record as an open object with a typed value', () => {
    expect(toJsonSchema(z.record(z.string(), z.string()))).toEqual({
      type: 'object',
      additionalProperties: { type: 'string' },
    });
  });

  it('publishes a boolean', () => {
    expect(toJsonSchema(z.boolean())).toEqual({ type: 'boolean' });
  });

  it('carries a description through', () => {
    expect(toJsonSchema(z.string().describe('the filename as uploaded'))).toEqual({
      type: 'string',
      description: 'the filename as uploaded',
    });
  });

  it('publishes a length counted in code points as minLength/maxLength, described or not', () => {
    // JSON Schema counts a string's length in code points, as codePointLength does.
    expect(toJsonSchema(codePointLength(z.string(), 2, 3))).toEqual({
      type: 'string',
      minLength: 2,
      maxLength: 3,
    });
    expect(toJsonSchema(codePointLength(z.string(), 2, 3).describe('why'))).toEqual({
      type: 'string',
      minLength: 2,
      maxLength: 3,
      description: 'why',
    });
  });

  it('publishes the inner shape of a refined schema', () => {
    // A cross-field rule cannot be expressed in JSON Schema. The shape is
    // published and the rule stays in the endpoint description, which is
    // better than publishing nothing at all.
    const refined = z.object({ a: z.string() }).refine(() => true);
    expect(toJsonSchema(refined)).toMatchObject({
      type: 'object',
      properties: { a: { type: 'string' } },
    });
  });

  it('returns an open schema for a construct it does not model', () => {
    // Deliberately `{}` rather than a guess: "not described here" is honest,
    // and a confidently wrong shape sends a client to write code against a
    // contract that does not hold.
    expect(toJsonSchema(z.any())).toEqual({});
    expect(toJsonSchema(z.unknown())).toEqual({});
  });
});

describe('objects', () => {
  it('lists only the fields that are actually required', () => {
    const schema = toJsonSchema(z.object({ a: z.string(), b: z.string().optional() }));
    expect(schema.required).toEqual(['a']);
  });

  it('omits required entirely when nothing is', () => {
    const schema = toJsonSchema(z.object({ b: z.string().optional() }));
    expect(schema).not.toHaveProperty('required');
  });

  it('publishes that a strict object refuses unknown fields', () => {
    // Load-bearing on every input schema here: the service rejects an unknown
    // field rather than dropping it, so a client that misspells a key hears
    // about it. A document that omitted this would hide the rejection.
    expect(toJsonSchema(z.object({ a: z.string() }).strict()).additionalProperties).toBe(false);
  });

  it('leaves additionalProperties open for a non-strict object', () => {
    expect(toJsonSchema(z.object({ a: z.string() })).additionalProperties).toBeUndefined();
  });
});

describe('the real demand DTOs', () => {
  it('publishes the list query as a strict object with a bounded limit and a closed status', () => {
    const schema = toJsonSchema(listDemandsQuerySchema);

    expect(schema.additionalProperties).toBe(false);
    const properties = schema.properties as Record<string, { enum?: string[] }>;
    expect(properties.status?.enum).toEqual(['SUBMITTED', 'WITHDRAWN', 'REFERRED', 'LAPSED']);
    expect(properties.limit).toBeDefined();
  });

  // PR-338 r1 F3 / r2 F2: both bounds of a reason in characters, as the CHECK and JSON Schema count
  // them — 4 emoji are 8 code units, 500 emoji 1000.
  it.each([
    ['withdrawal', withdrawDemandSchema, { expectedVersion: 1 }],
    ['cancellation', cancelAggregationSchema, { expectedVersion: 1 }],
  ])(
    'counts a %s reason in characters at both bounds, and publishes 8..500',
    (_l, schema, rest) => {
      const issues = (reason: string) => {
        const parsed = schema.safeParse({ ...rest, reason });
        return parsed.success ? [] : parsed.error.issues.map(({ code, path }) => ({ code, path }));
      };
      const emoji = (n: number) => '\u{1F600}'.repeat(n);

      expect(issues(emoji(4))).toEqual([{ code: 'too_small', path: ['reason'] }]);
      expect(schema.safeParse({ ...rest, reason: emoji(4) }).error?.issues).toEqual(
        schema.safeParse({ ...rest, reason: 'abcdefg' }).error?.issues,
      );
      expect(issues(emoji(8))).toEqual([]);
      expect(issues(emoji(300))).toEqual([]);
      expect(issues(emoji(500))).toEqual([]);
      expect(issues(emoji(501))).toEqual([{ code: 'too_big', path: ['reason'] }]);
      expect(schema.safeParse({ ...rest, reason: emoji(501) }).error?.issues).toEqual(
        schema.safeParse({ ...rest, reason: 'a'.repeat(501) }).error?.issues,
      );
      expect(issues('a'.repeat(500))).toEqual([]);
      const properties = toJsonSchema(schema).properties as Record<string, JsonSchema>;
      expect(properties.reason).toMatchObject({ type: 'string', minLength: 8, maxLength: 500 });
    },
  );

  it('publishes the aggregation view as strict, with the total an integer up to MAX_QUANTITY', () => {
    const schema = toJsonSchema(aggregationViewSchema);
    const properties = schema.properties as Record<string, { type?: string; maximum?: number }>;

    expect(schema.additionalProperties).toBe(false);
    expect(properties.totalQuantity).toMatchObject({ type: 'integer', maximum: 2147483647 });
  });
});
