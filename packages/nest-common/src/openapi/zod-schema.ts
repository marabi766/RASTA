import { z } from 'zod';
import { queryBooleanDefault } from '@rasta/config';

/**
 * Converts the Zod schemas a service validates with into JSON Schema, so its
 * OpenAPI document describes payload shapes rather than only prose.
 *
 * Why this exists at all: the platform validates at the boundary with Zod
 * (AGENTS.md § 3), while `@nestjs/swagger` derives schemas from decorated
 * classes. Nothing bridges the two, so every write endpoint was published with
 * a summary and no request body — a document a client cannot generate from.
 *
 * Why it is written here rather than taken from zod 4's own `z.toJSONSchema`:
 * that writes JSON Schema 2020-12 (no `nullable`, `additionalProperties: false`
 * on every object, implicit integer bounds), so the published documents would
 * change wholesale. This keeps them byte-identical to what the platform
 * published under zod 3 (GHSA-mrhx-c7xc-m3w5: the move to zod 4 changed no
 * document).
 *
 * Scope is deliberately the constructs the services' DTOs actually use.
 * Anything else returns an open `{}` rather than a wrong shape: an
 * unconstrained schema tells a reader "not described here", while a
 * confidently wrong one sends them to write code against a contract that does
 * not hold.
 *
 * One converter for every service. Thirteen services used to carry their own
 * copy (eight variants that had drifted apart); this is their union, and every
 * service's generated document is byte-identical to what its copy produced.
 * A pure utility with no domain knowledge, so it lives in `packages/` (A-03).
 */

/** JSON Schema is recursive and heterogeneous; this is its shape, honestly. */
export type JsonSchema = Record<string, unknown>;

// JUSTIFIED-ANY: zod's internal `_zod.def` is untyped across its ~30 types,
// and narrowing each one would restate zod's own internals without making the
// walk safer — every branch below re-checks `type` before reading a field.
/* eslint-disable @typescript-eslint/no-explicit-any */
const defOf = (schema: z.ZodType): any => (schema as any)._zod.def;
const checkDefs = (def: any): any[] =>
  ((def.checks ?? []) as any[]).map((check) => ({ check, def: check._zod.def }));

/** The bounds of each `codePointLength` refinement, by its check. */
const CODE_POINT_BOUNDS = new WeakMap<object, { minLength: number; maxLength: number }>();

/**
 * `schema` of `minLength` to `maxLength` characters counted as JSON Schema's `minLength` and
 * `maxLength` count them, and PostgreSQL's `char_length`: code points. Zod's `min`/`max` count
 * UTF-16 code units, so a character outside the BMP counts twice there — "😀" × 4 passed `min(8)`
 * and failed the database's CHECK (PR-338 r1 F3), "😀" × 300 failed `max(500)` though the CHECK
 * takes it (PR-338 r2 F2). The issues are the ones `min`/`max` raise, and the bounds are published
 * as `minLength`/`maxLength`.
 */
export function codePointLength(schema: z.ZodString, minLength: number, maxLength: number) {
  const check = z.superRefine((value: string, context) => {
    const length = [...value].length;
    if (length < minLength) {
      context.addIssue({
        code: 'too_small',
        minimum: minLength,
        origin: 'string',
        inclusive: true,
        input: value,
      });
    }
    if (length > maxLength) {
      context.addIssue({
        code: 'too_big',
        maximum: maxLength,
        origin: 'string',
        inclusive: true,
        input: value,
      });
    }
  });
  CODE_POINT_BOUNDS.set(check, { minLength, maxLength });
  return schema.check(check);
}

export function toJsonSchema(schema: z.ZodType): JsonSchema {
  const description = schema.description;

  // Checked before anything is unwrapped. A `queryBoolean` accepts
  // `boolean | string` at runtime because that is how a boolean arrives in a
  // query string, but publishing that union literally would emit
  // `anyOf: [boolean, string]` — telling a generated client the parameter
  // takes arbitrary strings, when the parser rejects every string but eight,
  // and costing it a `boolean` in its typed signature. OpenAPI already defines
  // how a boolean is carried in a query string, so `type: boolean` is both
  // true and enough. The marker travels on the schema itself, so the accepted
  // input and the published output come from one call and cannot drift.
  const queryBooleanDefaultValue = queryBooleanDefault(schema);
  const base =
    queryBooleanDefaultValue === undefined
      ? convert(defOf(schema))
      : { type: 'boolean', default: queryBooleanDefaultValue };

  return description ? { ...base, description } : base;
}

/** The bounds a `codePointLength` check on `def` publishes, if any. */
function codePointBounds(def: any): { minLength: number; maxLength: number } | undefined {
  let bounds: { minLength: number; maxLength: number } | undefined;
  for (const { check } of checkDefs(def)) bounds = CODE_POINT_BOUNDS.get(check) ?? bounds;
  return bounds;
}

function convert(def: any): JsonSchema {
  switch (def.type) {
    case 'object':
      return objectSchema(def);

    case 'string': {
      // A refinement is a check on the schema it refines, so a `codePointLength`
      // bound is found among the string's own checks, and published over them.
      const bounds = codePointBounds(def);
      return bounds ? { ...stringSchema(def), ...bounds } : stringSchema(def);
    }

    case 'number':
      return numberSchema(def);

    case 'boolean':
      return { type: 'boolean' };

    case 'enum':
      return { type: 'string', enum: Object.values(def.entries as Record<string, string>) };

    case 'literal':
      return { const: (def.values as unknown[])[0] };

    case 'array': {
      // Bounds are published for the same reason string and number bounds are:
      // `createOrderSchema` caps an order at fifty lines and requires at least
      // one, and a document that omits that sends a client to build a request
      // the service answers with a 400 it could not have predicted.
      const array: JsonSchema = { type: 'array', items: toJsonSchema(def.element as z.ZodType) };
      let minItems: number | undefined;
      let maxItems: number | undefined;
      for (const { def: check } of checkDefs(def)) {
        if (check.check === 'min_length') minItems = check.minimum as number;
        if (check.check === 'max_length') maxItems = check.maximum as number;
      }
      if (minItems !== undefined) array.minItems = minItems;
      if (maxItems !== undefined) array.maxItems = maxItems;
      return array;
    }

    case 'record':
      return { type: 'object', additionalProperties: toJsonSchema(def.valueType) };

    case 'union':
      // A discriminated union was never described (zod 3 had a separate type
      // for it the converter did not know), and stays undescribed.
      if (def.discriminator !== undefined) return {};
      return { anyOf: (def.options as z.ZodType[]).map(toJsonSchema) };

    // Unwrapping wrappers. `optional` and `nullable` are recorded by the
    // parent object (in `required`) and by `nullable` respectively, so here
    // they only need their inner type resolved.
    case 'optional':
      return toJsonSchema(def.innerType);

    case 'nullable':
      return { ...toJsonSchema(def.innerType), nullable: true };

    // `.prefault()` is zod 3's `.default()` (the value is parsed like any
    // input); either way the value written is the one published.
    case 'default':
    case 'prefault':
      return { ...toJsonSchema(def.innerType), default: def.defaultValue };

    // `.transform()` and `z.preprocess()` pipe a schema into or out of a
    // function. What a transform returns cannot be expressed in JSON Schema,
    // so the schema the input is checked against is published; the cross-field
    // rules `.refine()` carries — "at least one of hours or kilometres",
    // "periodEnd after periodStart" — are checks, left out the same way, and
    // stay in the endpoint description where a human will read it. A pipe
    // between two schemas (`.pipe()`) was never described, and stays so.
    case 'pipe':
      if (defOf(def.out).type === 'transform') return toJsonSchema(def.in);
      if (defOf(def.in).type === 'transform') return toJsonSchema(def.out);
      return {};

    default:
      return {};
  }
}

function objectSchema(def: any): JsonSchema {
  const shape = def.shape as Record<string, z.ZodType>;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(shape)) {
    properties[key] = toJsonSchema(field);
    if (!field.safeParse(undefined).success) required.push(key);
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    // `.strict()` is load-bearing on every input schema here: an unknown field
    // is rejected rather than dropped, so a client that misspells a key hears
    // about it. Publishing that is the difference between a document a client
    // can trust and one that hides a rejection.
    additionalProperties: def.catchall && defOf(def.catchall).type === 'never' ? false : undefined,
  };
}

/** zod 4's name for a string format → the JSON Schema `format` published for it. */
const STRING_FORMATS: Record<string, string> = {
  datetime: 'date-time',
  email: 'email',
  url: 'uri',
};

function stringSchema(def: any): JsonSchema {
  const out: JsonSchema = { type: 'string' };

  for (const { def: check } of checkDefs(def)) {
    if (check.check === 'min_length') out.minLength = check.minimum;
    if (check.check === 'max_length') out.maxLength = check.maximum;
    if (check.check !== 'string_format') continue;
    const format = STRING_FORMATS[check.format as string];
    if (format) out.format = format;
    // The source's own flags, so the published pattern matches what actually
    // runs rather than a re-spelling of it. Only a `.regex()` publishes its
    // pattern: a format's pattern is zod's implementation of it.
    if (check.format === 'regex') out.pattern = (check.pattern as RegExp).source;
  }

  return out;
}

function numberSchema(def: any): JsonSchema {
  const out: JsonSchema = { type: 'number' };

  for (const { def: check } of checkDefs(def)) {
    if (check.check === 'number_format' && String(check.format).includes('int')) {
      out.type = 'integer';
    }
    if (check.check === 'greater_than') out.minimum = check.value;
    if (check.check === 'less_than') out.maximum = check.value;
  }

  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * The fields of the object a query or body schema parses, looked up through
 * what wraps it — a refinement (a check on the object itself), a transform or
 * a preprocess (a pipe from or into it), `.optional()` and `.prefault()` — or
 * `undefined` when it is not an object. The services' OpenAPI documents list a
 * query schema's fields as parameters with it.
 */
export function objectShapeOf(schema: z.ZodType): Record<string, z.ZodType> | undefined {
  let current: z.ZodType = schema;
  for (let depth = 0; depth < 10; depth += 1) {
    const def = (current as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
    if (def.type === 'object') return def.shape as Record<string, z.ZodType>;
    if (def.type === 'optional' || def.type === 'default' || def.type === 'prefault') {
      current = def.innerType as z.ZodType;
      continue;
    }
    if (def.type === 'pipe') {
      const kind = (side: unknown) => (side as { _zod: { def: { type: string } } })._zod.def.type;
      if (kind(def.out) === 'transform') current = def.in as z.ZodType;
      else if (kind(def.in) === 'transform') current = def.out as z.ZodType;
      else return undefined;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** Whether a field may be left out: it accepts `undefined` (zod 3's `isOptional()`). */
export function isOptionalField(schema: z.ZodType): boolean {
  return schema.safeParse(undefined).success;
}
