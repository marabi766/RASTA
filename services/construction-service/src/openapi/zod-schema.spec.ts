import { z } from 'zod';
import { toJsonSchema } from './zod-schema';
import { createProjectSchema, updateProjectSchema, withdrawNeedSchema } from '../project/dto';

/**
 * The bridge between what the service validates with and what it publishes.
 *
 * These assertions are about a contract a client generates code from, so the
 * failure they guard is not a crash: it is a published document that quietly
 * disagrees with the running service, which a client only discovers as a 400
 * it could not have predicted.
 */

describe('the constructs the construction DTOs are built from', () => {
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
    expect(toJsonSchema(z.enum(['CONTRACT', 'OTHER']))).toEqual({
      type: 'string',
      enum: ['CONTRACT', 'OTHER'],
    });
  });

  it('publishes a regex as the pattern that actually runs', () => {
    // The source's own flags rather than a re-spelling, so the published
    // pattern is the one the service enforces.
    const schema = toJsonSchema(z.string().regex(/^DOC_[0-9A-Z]{26}$/));
    expect(schema.pattern).toBe('^DOC_[0-9A-Z]{26}$');
  });

  it('publishes the formats a client can validate against', () => {
    expect(toJsonSchema(z.string().url()).format).toBe('uri');
    expect(toJsonSchema(z.string().email()).format).toBe('email');
    expect(toJsonSchema(z.string().datetime()).format).toBe('date-time');
  });

  it('publishes a default rather than hiding it', () => {
    expect(toJsonSchema(z.number().int().default(25))).toEqual({
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
    expect(toJsonSchema(z.record(z.string()))).toEqual({
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

describe('the real construction DTOs', () => {
  it('publishes a create request that refuses unknown fields and names what it requires', () => {
    const schema = toJsonSchema(createProjectSchema);

    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      'title',
      'operationType',
      'scopeOfWork',
      'locationDescription',
    ]);
  });

  it('carries the provisional-field note into the published contract', () => {
    const properties = toJsonSchema(createProjectSchema).properties as Record<
      string,
      { description?: string }
    >;

    expect(properties.title?.description).toMatch(/Q-68/);
    expect(properties.estimatedCostMinor?.description).toMatch(/docs\/03/);
  });

  it('publishes the update request through its refinement', () => {
    const schema = toJsonSchema(updateProjectSchema);

    expect(schema.required).toEqual(['expectedVersion']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('publishes the reason floor a withdrawal must meet', () => {
    const properties = toJsonSchema(withdrawNeedSchema).properties as Record<string, unknown>;

    expect(properties.reason).toEqual({ type: 'string', minLength: 8, maxLength: 500 });
  });
});
