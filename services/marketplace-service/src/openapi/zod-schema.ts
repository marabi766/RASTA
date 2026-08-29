import { z } from 'zod';

/**
 * Converts the Zod schemas this service validates with into JSON Schema, so
 * the OpenAPI document describes payload shapes rather than only prose.
 *
 * Why this exists at all: the platform validates at the boundary with Zod
 * (AGENTS.md § 3), while `@nestjs/swagger` derives schemas from decorated
 * classes. Nothing bridges the two, so every write endpoint was published with
 * a summary and no request body — a document a client cannot generate from.
 *
 * Why it is written here rather than pulled from a package: the repository's
 * supply-chain gate rejects newly-published dependencies pending review
 * (D-008), and `zod/v4`'s own `toJSONSchema` refuses a v3 schema — these are
 * built with the v3 API that the rest of the platform uses.
 *
 * Scope is deliberately the constructs the marketplace DTOs actually use. Anything
 * else returns an open `{}` rather than a wrong shape: an unconstrained
 * schema tells a reader "not described here", while a confidently wrong one
 * sends them to write code against a contract that does not hold.
 */

/** JSON Schema is recursive and heterogeneous; this is its shape, honestly. */
export type JsonSchema = Record<string, unknown>;

// JUSTIFIED-ANY: zod's internal `_def` is untyped across its ~20 type-kinds,
// and narrowing each one would restate zod's own internals without making the
// walk safer — every branch below re-checks `typeName` before reading a field.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyZod = z.ZodTypeAny & { _def: any };

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = (schema as AnyZod)._def;
  const description = def.description as string | undefined;
  const base = convert(schema, def);
  return description ? { ...base, description } : base;
}

function convert(schema: z.ZodTypeAny, def: any): JsonSchema {
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject:
      return objectSchema(schema as z.ZodObject<z.ZodRawShape>, def);

    case z.ZodFirstPartyTypeKind.ZodString:
      return stringSchema(def);

    case z.ZodFirstPartyTypeKind.ZodNumber:
      return numberSchema(def);

    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: 'boolean' };

    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { type: 'string', enum: [...(def.values as string[])] };

    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return { const: def.value };

    case z.ZodFirstPartyTypeKind.ZodArray:
      return { type: 'array', items: toJsonSchema(def.type as z.ZodTypeAny) };

    case z.ZodFirstPartyTypeKind.ZodRecord:
      return { type: 'object', additionalProperties: toJsonSchema(def.valueType) };

    case z.ZodFirstPartyTypeKind.ZodUnion:
      return { anyOf: (def.options as z.ZodTypeAny[]).map(toJsonSchema) };

    // Unwrapping wrappers. `optional` and `nullable` are recorded by the
    // parent object (in `required`) and by `nullable` respectively, so here
    // they only need their inner type resolved.
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return toJsonSchema(def.innerType);

    case z.ZodFirstPartyTypeKind.ZodNullable:
      return { ...toJsonSchema(def.innerType), nullable: true };

    case z.ZodFirstPartyTypeKind.ZodDefault:
      return { ...toJsonSchema(def.innerType), default: def.defaultValue() };

    // `.refine()` and `.transform()` wrap a schema in an effect. The cross-field
    // rules they carry — "at least one of hours or kilometres", "periodEnd
    // after periodStart" — cannot be expressed in JSON Schema, so the inner
    // shape is published and the rule stays in the endpoint description where
    // a human will read it.
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return toJsonSchema(def.schema);

    default:
      return {};
  }
}

function objectSchema(schema: z.ZodObject<z.ZodRawShape>, def: any): JsonSchema {
  const shape = schema.shape;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const field = value as z.ZodTypeAny;
    properties[key] = toJsonSchema(field);
    if (!field.isOptional()) required.push(key);
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    // `.strict()` is load-bearing on every input schema here: an unknown field
    // is rejected rather than dropped, so a client that misspells a key hears
    // about it. Publishing that is the difference between a document a client
    // can trust and one that hides a rejection.
    additionalProperties: def.unknownKeys === 'strict' ? false : undefined,
  };
}

function stringSchema(def: any): JsonSchema {
  const out: JsonSchema = { type: 'string' };

  for (const check of (def.checks ?? []) as any[]) {
    if (check.kind === 'min') out.minLength = check.value;
    if (check.kind === 'max') out.maxLength = check.value;
    if (check.kind === 'datetime') out.format = 'date-time';
    if (check.kind === 'email') out.format = 'email';
    if (check.kind === 'url') out.format = 'uri';
    // The source's own flags, so the published pattern matches what actually
    // runs rather than a re-spelling of it.
    if (check.kind === 'regex') out.pattern = (check.regex as RegExp).source;
  }

  return out;
}

function numberSchema(def: any): JsonSchema {
  const out: JsonSchema = { type: 'number' };

  for (const check of (def.checks ?? []) as any[]) {
    if (check.kind === 'int') out.type = 'integer';
    if (check.kind === 'min') out.minimum = check.value;
    if (check.kind === 'max') out.maximum = check.value;
  }

  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
