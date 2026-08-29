import { z } from 'zod';
import { toJsonSchema } from './zod-schema';

/**
 * The Zod → JSON Schema walk that produces the published contract.
 *
 * This converter is the only thing standing between the schemas the service
 * validates with and the document every client is generated from. A type it
 * fails to translate does not throw — it returns `{}`, which publishes a field
 * with no type at all, and a generated client then accepts anything. That
 * failure is silent by construction, so each type kind is asserted here rather
 * than assumed.
 *
 * The one that matters most is money. `amountMinor` is a **string** carrying
 * an integer in minor units (ADR-022); a client generated against `number`
 * truncates a rial figure past `Number.MAX_SAFE_INTEGER` inside its own JSON
 * parser, where no validation of ours can ever see it.
 */
describe('toJsonSchema', () => {
  it('publishes a strict object with its required fields', () => {
    const schema = z
      .object({
        required: z.string(),
        optional: z.string().optional(),
      })
      .strict();

    expect(toJsonSchema(schema)).toEqual({
      type: 'object',
      properties: { required: { type: 'string' }, optional: { type: 'string' } },
      required: ['required'],
      // `.strict()` is load-bearing on every input schema in this service: an
      // unknown field is rejected rather than dropped, and publishing that is
      // the difference between a document a client can trust and one that
      // hides a rejection.
      additionalProperties: false,
    });
  });

  it('leaves additionalProperties open for a non-strict object, and omits an empty required', () => {
    const schema = z.object({ everything: z.string().optional() });
    const json = toJsonSchema(schema);

    expect(json.additionalProperties).toBeUndefined();
    expect(json.required).toBeUndefined();
  });

  it('carries a string’s own constraints, including the regex that actually runs', () => {
    const schema = z.object({
      amountMinor: z.string().regex(/^\d{1,30}$/),
      note: z.string().min(3).max(10),
      when: z.string().datetime(),
      email: z.string().email(),
      link: z.string().url(),
    });

    const properties = toJsonSchema(schema).properties!;
    // The source's own flags, so the published pattern is what runs rather
    // than a re-spelling of it.
    expect(properties.amountMinor).toEqual({ type: 'string', pattern: '^\\d{1,30}$' });
    expect(properties.note).toEqual({ type: 'string', minLength: 3, maxLength: 10 });
    expect(properties.when).toEqual({ type: 'string', format: 'date-time' });
    expect(properties.email).toEqual({ type: 'string', format: 'email' });
    expect(properties.link).toEqual({ type: 'string', format: 'uri' });
  });

  it('publishes a basis-point rate as a bounded integer, never a decimal', () => {
    // 2.5% must be exactly 250. A decimal percentage cannot promise that, and
    // a document that says `number` invites a client to send 2.5 (ADR-022).
    const schema = z.object({ rateBasisPoints: z.number().int().min(0).max(10_000) });

    expect(toJsonSchema(schema).properties!.rateBasisPoints).toEqual({
      type: 'integer',
      minimum: 0,
      maximum: 10_000,
    });
  });

  it('translates booleans, enums, literals, arrays and records', () => {
    const schema = z.object({
      flag: z.boolean(),
      status: z.enum(['ACTIVE', 'INACTIVE']),
      kind: z.literal('SETTLEMENT'),
      names: z.array(z.string()),
      metadata: z.record(z.string()),
    });

    const properties = toJsonSchema(schema).properties!;
    expect(properties.flag).toEqual({ type: 'boolean' });
    expect(properties.status).toEqual({ type: 'string', enum: ['ACTIVE', 'INACTIVE'] });
    expect(properties.kind).toEqual({ const: 'SETTLEMENT' });
    expect(properties.names).toEqual({ type: 'array', items: { type: 'string' } });
    expect(properties.metadata).toEqual({
      type: 'object',
      additionalProperties: { type: 'string' },
    });
  });

  it('unwraps optional, nullable and default, keeping what each one adds', () => {
    const schema = z.object({
      maybe: z.string().optional(),
      nullable: z.string().nullable(),
      withDefault: z.string().default('IRR'),
    });

    const properties = toJsonSchema(schema).properties!;
    expect(properties.maybe).toEqual({ type: 'string' });
    expect(properties.nullable).toEqual({ type: 'string', nullable: true });
    expect(properties.withDefault).toEqual({ type: 'string', default: 'IRR' });
  });

  it('publishes the inner shape of a refined schema and drops the cross-field rule', () => {
    // A JSON Schema cannot express "periodCap and periodType must be supplied
    // together", so the rule stays in the endpoint description where a human
    // reads it — and the shape is still published rather than lost.
    const schema = z
      .object({ periodCap: z.number().optional(), periodType: z.string().optional() })
      .refine((value) => (value.periodCap === undefined) === (value.periodType === undefined));

    expect(toJsonSchema(schema)).toEqual({
      type: 'object',
      properties: { periodCap: { type: 'number' }, periodType: { type: 'string' } },
    });
  });

  it('publishes a union as anyOf', () => {
    expect(toJsonSchema(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
  });

  it('carries a description through to the published field', () => {
    expect(toJsonSchema(z.string().describe('minor units'))).toEqual({
      type: 'string',
      description: 'minor units',
    });
  });

  it('returns an empty schema for a type it cannot translate, rather than throwing', () => {
    // Deliberate: a document that fails to generate takes the whole service
    // down at boot, and one unknown field is a smaller problem than that. It
    // is asserted so the fallback is a known behaviour rather than a surprise.
    expect(toJsonSchema(z.unknown())).toEqual({});
  });
});
