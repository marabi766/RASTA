import { z } from 'zod';
import { queryBooleanDefault } from '@rasta/config';
import {
  numberInputInnerSchema,
  publishablePattern,
  unchangedCheck,
  publishedIsoDateTimeZone,
  publishedRefinementPattern,
} from '@rasta/contracts';

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
const CODE_POINT_BOUNDS = new WeakMap<
  object,
  { bounds: { minLength: number; maxLength: number }; unchanged: () => boolean }
>();

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
  CODE_POINT_BOUNDS.set(check, {
    bounds: { minLength, maxLength },
    unchanged: unchangedCheck(check),
  });
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
  // Known decimal transport adapters publish numeric semantics, including integer
  // bounds. Unregistered preprocessors keep the fail-closed omission below.
  const numberInner = numberInputInnerSchema(schema);

  const queryBooleanDefaultValue = queryBooleanDefault(schema);
  const base =
    numberInner !== undefined
      ? toJsonSchema(numberInner)
      : queryBooleanDefaultValue === undefined
        ? convert(defOf(schema))
        : { type: 'boolean', default: queryBooleanDefaultValue };

  if (!description) return base;
  // A schema's own words come first; a bound its format carries (FU-035) is kept after them.
  return {
    ...base,
    description: base.description ? `${description} ${String(base.description)}` : description,
  };
}

/** A deliberate omission, not a raw-input constraint. Kept through descriptions/wrappers. */
const TRANSFORMED_CONSTRAINTS =
  'Constraints after a value-changing step are omitted; validation applies them to the transformed value.';

function transformedConstraints(input: JsonSchema = {}): JsonSchema {
  const description = String(input.description ?? '');
  return {
    ...input,
    description: description.includes(TRANSFORMED_CONSTRAINTS)
      ? description
      : [description, TRANSFORMED_CONSTRAINTS].filter(Boolean).join(' '),
  };
}

function convert(def: any): JsonSchema {
  switch (def.type) {
    case 'object':
      return objectSchema(def);

    case 'string':
      return stringSchema(def);

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
      const { checks, changed } = rawChecks(def);
      for (const { def: check } of checks) {
        if (check.check === 'min_length') minItems = check.minimum as number;
        if (check.check === 'max_length') maxItems = check.maximum as number;
      }
      if (minItems !== undefined) array.minItems = minItems;
      if (maxItems !== undefined) array.maxItems = maxItems;
      return changed ? transformedConstraints(array) : array;
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

    // OpenAPI 3.0's `nullable` qualifies a `type` and means nothing without one ("nullable"
    // cannot be used without "type", AJV). An inner schema that says nothing already admits
    // `null`, so it is published as it is rather than as the non-schema `{"nullable":true}`.
    case 'nullable': {
      const inner = toJsonSchema(def.innerType);
      return inner.type === undefined && Object.keys(inner).every((key) => key === 'description')
        ? inner
        : { ...inner, nullable: true };
    }

    // `.prefault()` is zod 3's `.default()` (the value is parsed like any
    // input); either way the value written is the one published.
    case 'default':
    case 'prefault':
      return { ...toJsonSchema(def.innerType), default: def.defaultValue };

    // `.transform()` and `z.preprocess()` pipe a schema into or out of a
    // function. What a transform returns cannot be expressed in JSON Schema,
    // so only the schema checked before the function is published; the cross-field
    // rules `.refine()` carries — "at least one of hours or kilometres",
    // "periodEnd after periodStart" — are checks, left out the same way, and
    // stay in the endpoint description where a human will read it.
    case 'pipe':
      if (defOf(def.out).type === 'transform') return toJsonSchema(def.in);
      if (defOf(def.in).type === 'transform') return transformedConstraints();
      return pipeBetweenSchemas(def.in, def.out);

    default:
      return {};
  }
}

/** The keywords a later schema in a pipe narrows: the tighter bound of the two is the one that holds. */
const LOWER_BOUNDS = ['minLength', 'minimum', 'minItems'] as const;
const UPPER_BOUNDS = ['maxLength', 'maximum', 'maxItems'] as const;

/**
 * `.pipe()` between two schemas. A value is accepted only when it passes both, so the input
 * schema's type and constraints are published — never `{}` (FU-078 r1 F2: under `.nullable()` that
 * published `{"nullable":true}`, which is not a schema).
 *
 * The later schema's constraints are added only when the value reaching it IS the raw input: the
 * input changes nothing on the way (no transform, no overwrite such as `.trim()`, no coercion) and
 * the two agree on the type; the tighter bound of a pair wins. A JSON Schema validator checks the
 * raw request text, so a bound the later schema applies to canonicalised text describes a different
 * string: `identifierText()` NFKC-folds and strips tatweel before `z.string().max(64)`, and merging
 * that bound published "67 characters is too long" for a value runtime accepts (FU-078 r2 F2).
 * Anything the converter cannot prove value-preserving is treated as changing it (fail closed):
 * the input schema alone is published, and a rule on the changed value belongs in a description.
 *
 * When the input says nothing (`z.unknown().pipe(…)`) and changes nothing, the later schema is
 * what is published. When the two disagree on the type, the input schema alone is published: it
 * is what the client sends.
 */
function pipeBetweenSchemas(inSchema: z.ZodType, outSchema: z.ZodType): JsonSchema {
  const input = toJsonSchema(inSchema);
  if (changesValue(inSchema)) return transformedConstraints(input);
  const output = toJsonSchema(outSchema);
  // A description on the input must not hide an omission made inside the output.
  const keepMarker = (result: JsonSchema): JsonSchema =>
    String(output.description ?? '').includes(TRANSFORMED_CONSTRAINTS)
      ? transformedConstraints(result)
      : result;
  if (Object.keys(input).every((key) => key === 'description'))
    return keepMarker({ ...output, ...input });
  if (input.type === undefined || input.type !== output.type) return keepMarker(input);
  const merged: JsonSchema = { ...output, ...input };
  for (const key of LOWER_BOUNDS) {
    if (typeof input[key] === 'number' && typeof output[key] === 'number') {
      merged[key] = Math.max(input[key] as number, output[key] as number);
    }
  }
  for (const key of UPPER_BOUNDS) {
    if (typeof input[key] === 'number' && typeof output[key] === 'number') {
      merged[key] = Math.min(input[key] as number, output[key] as number);
    }
  }
  return keepMarker(merged);
}

/** Types whose parse returns the raw input itself, unless a check on them overwrites it. */
const VALUE_PRESERVING_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'bigint',
  'enum',
  'literal',
  'unknown',
  'any',
]);

/**
 * Whether parsing `schema` may hand on a value other than its raw input: a transform, an
 * overwrite check (`.trim()`, `.toLowerCase()`, `.normalize()`), a coercion — or any type not known
 * to preserve the value (objects strip keys, defaults substitute), which fails closed.
 */
// Unknown/custom checks can assign to Zod's payload.value (.check callbacks).
// Built-in checks and registered code-point/identifier refinements are proven safe.
const VALUE_PRESERVING_CHECKS = new Set([
  'min_length',
  'max_length',
  'length_equals',
  'string_format',
  'greater_than',
  'less_than',
  'number_format',
  'multiple_of',
]);

/** Checks before the first check not proven value-preserving, in execution order. */
function rawChecks(def: any): { checks: ReturnType<typeof checkDefs>; changed: boolean } {
  const checks = checkDefs(def);
  const barrier = checks.findIndex(
    ({ check, def: definition }) =>
      !CODE_POINT_BOUNDS.get(check)?.unchanged() &&
      !publishedRefinementPattern(check) &&
      !publishedIsoDateTimeZone(check) &&
      !(
        Object.getPrototypeOf(definition) === Object.prototype &&
        z.core.originalZodCheck(check) &&
        VALUE_PRESERVING_CHECKS.has(definition.check as string) &&
        (definition.check !== 'string_format' ||
          (definition.pattern instanceof RegExp &&
            ['regex', 'email', 'datetime', 'uuid'].includes(definition.format)))
      ),
  );
  return {
    checks: barrier < 0 ? checks : checks.slice(0, barrier),
    changed: barrier >= 0,
  };
}

function changesValue(schema: z.ZodType): boolean {
  const def = defOf(schema);
  if (rawChecks(def).changed) return true;
  if (def.type === 'pipe') return changesValue(def.in) || changesValue(def.out);
  if (def.type === 'optional' || def.type === 'nullable') return changesValue(def.innerType);
  return !VALUE_PRESERVING_TYPES.has(def.type as string) || def.coerce === true;
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

/** Consumers must compile published patterns with `u`; other flags cannot be carried by OpenAPI. */
function publishPattern(out: JsonSchema, pattern: { source: string; flags: string }): void {
  if (publishablePattern(pattern)) out.pattern = pattern.source;
}

function stringSchema(def: any): JsonSchema {
  // Coercion happens before every check, including the string type check.
  if (def.coerce === true) return transformedConstraints();
  const out: JsonSchema = { type: 'string' };

  const { checks, changed } = rawChecks(def);
  for (const { check: instance, def: check } of checks) {
    const registered = CODE_POINT_BOUNDS.get(instance);
    if (registered?.unchanged()) Object.assign(out, registered.bounds);
    // Registered refinements preserve the value; publish only inside the raw prefix.
    const published = publishedRefinementPattern(instance);
    if (published) publishPattern(out, published);
    if (check.check === 'min_length') out.minLength = check.minimum;
    if (check.check === 'max_length') out.maxLength = check.maximum;
    if (check.check !== 'string_format') continue;
    const format = STRING_FORMATS[check.format as string];
    if (format) out.format = format;
    // A format's implementation regex is not its public contract.
    if (check.format === 'regex') publishPattern(out, check.pattern as RegExp);
    // `format: date-time` admits offsets the platform's `isoDateTime()` refuses (RFC 3339 allows
    // ±23:59; the UTC-only form takes none), so its accepted zone is published with it (FU-035).
    const zone = publishedIsoDateTimeZone(instance);
    if (zone) {
      publishPattern(out, { source: zone.pattern, flags: '' });
      out.description = zone.description;
    }
  }

  return changed ? transformedConstraints(out) : out;
}

function numberSchema(def: any): JsonSchema {
  if (def.coerce === true) return transformedConstraints();
  const out: JsonSchema = { type: 'number' };

  const { checks, changed } = rawChecks(def);
  for (const { def: check } of checks) {
    if (check.check === 'number_format' && String(check.format).includes('int')) {
      out.type = 'integer';
    }
    if (check.check === 'greater_than') out.minimum = check.value;
    if (check.check === 'less_than') out.maximum = check.value;
  }

  return changed ? transformedConstraints(out) : out;
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
      // A preprocessor may replace the entire object: its fields are not raw parameters.
      else if (kind(def.in) === 'transform') {
        throw new Error('Cannot publish query fields after a value-changing preprocessor');
      } else return undefined;
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
