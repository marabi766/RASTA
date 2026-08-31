import { z } from 'zod';
import { toJsonSchema } from './zod-schema';
import {
  deleteDocumentSchema,
  listDocumentsQuerySchema,
  requestUploadUrlSchema,
} from '../document/dto';

/**
 * The bridge between what the service validates with and what it publishes.
 *
 * These assertions are about a contract a client generates code from, so the
 * failure they guard is not a crash: it is a published document that quietly
 * disagrees with the running service, which a client only discovers as a 400
 * it could not have predicted.
 */

describe('the constructs the document DTOs are built from', () => {
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

describe('the real document DTOs', () => {
  it('publishes the upload request as a closed object with every field', () => {
    const schema = toJsonSchema(requestUploadUrlSchema);
    const properties = schema.properties as Record<string, unknown>;

    expect(Object.keys(properties).sort()).toEqual(
      ['contentType', 'documentClass', 'filename', 'sizeBytes'].sort(),
    );
    // The property ADR-014 depends on: there is no field through which a
    // client could name the object key, and the document says so.
    expect(schema.additionalProperties).toBe(false);
    expect(properties).not.toHaveProperty('objectKey');
  });

  it('publishes the deletion reason as required, with its minimum length', () => {
    // A tombstone with no reason is not an audit record, and a client should
    // be able to see the minimum before it sends "x".
    const schema = toJsonSchema(deleteDocumentSchema);
    expect(schema.required).toEqual(['reason']);
    expect((schema.properties as Record<string, { minLength: number }>).reason.minLength).toBe(8);
  });

  it('publishes the listing filters with their defaults', () => {
    const properties = toJsonSchema(listDocumentsQuerySchema).properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(properties.limit).toMatchObject({ type: 'integer', default: 25, maximum: 100 });
    expect(properties.includeDeleted).toMatchObject({ default: false });
  });
});
