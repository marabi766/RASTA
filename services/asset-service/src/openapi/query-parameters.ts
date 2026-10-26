import { applyDecorators } from '@nestjs/common';
import { ApiQuery, type ApiQueryOptions } from '@nestjs/swagger';
import { queryBooleanDefault } from '@rasta/config';
import { z } from 'zod';

/**
 * Publishes a Zod query schema as OpenAPI parameters.
 *
 * This service builds its document from decorators alone — there is no
 * document-enrichment step like economic-service's — so without this, a query
 * schema was validated on every request and described nowhere. `availableOnly`
 * was accepted, parsed and acted on while the published document said the
 * endpoint took no parameters at all (D-023).
 *
 * Derived from the schema rather than hand-written beside it, for the reason
 * the defect it publishes exists in the first place: two descriptions of one
 * parameter drift, and the one nobody executes drifts first.
 *
 * Deliberately narrow. It covers the primitives a query string actually
 * carries — booleans, numbers, strings and enums, optional or defaulted — and
 * nothing else. A schema that needs more than this should say so by failing
 * review, not by being silently published as `{}`.
 */
export function ApiQueryFromSchema(schema: z.ZodObject): MethodDecorator {
  return applyDecorators(...parametersOf(schema).map((parameter) => ApiQuery(parameter)));
}

/** Exported for its own test: what gets published has to be assertable. */
export function parametersOf(schema: z.ZodObject): ApiQueryOptions[] {
  return Object.entries(schema.shape).map(([name, field]) => describe(name, field as z.ZodType));
}

function describe(name: string, field: z.ZodType): ApiQueryOptions {
  // A query boolean is `boolean | string` at runtime, because that is how a
  // boolean arrives in a query string. Published as the union it would read
  // `anyOf: [boolean, string]` — arbitrary strings, to a generated client,
  // when the parser accepts eight spellings and refuses the rest. The marker
  // rides on the schema so this and the parser cannot disagree.
  const booleanDefault = queryBooleanDefault(field);
  if (booleanDefault !== undefined) {
    return { name, required: false, schema: { type: 'boolean', default: booleanDefault } };
  }

  const { inner, required, defaultValue } = unwrap(field);
  const def = defOf(inner);

  const schema: Record<string, unknown> = { ...primitive(def) };
  if (defaultValue !== undefined) schema.default = defaultValue;

  return { name, required, schema };
}

/** A schema's zod 4 definition (`_zod.def`); every branch re-checks `type`. */
function defOf(schema: z.ZodType): Record<string, unknown> {
  return (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
}

function primitive(def: Record<string, unknown>): Record<string, unknown> {
  switch (def.type) {
    case 'boolean':
      return { type: 'boolean' };

    case 'number':
      return numeric(def);

    case 'enum':
      return { type: 'string', enum: Object.values(def.entries as Record<string, string>) };

    default:
      return { type: 'string' };
  }
}

function numeric(def: Record<string, unknown>): Record<string, unknown> {
  const checks = ((def.checks ?? []) as z.core.$ZodCheck[]).map(
    (check) => check._zod.def as unknown as { check: string; format?: string; value?: number },
  );
  const schema: Record<string, unknown> = {
    type: checks.some((check) => check.check === 'number_format' && check.format?.includes('int'))
      ? 'integer'
      : 'number',
  };

  const min = checks.find((check) => check.check === 'greater_than');
  const max = checks.find((check) => check.check === 'less_than');
  if (min) schema.minimum = min.value;
  if (max) schema.maximum = max.value;

  return schema;
}

/**
 * Peels `.prefault()`, `.optional()` and a preprocess off a field.
 *
 * Both decide whether a client must send the parameter, and both hide the
 * primitive underneath — so the answer to "is it required" and the answer to
 * "what type is it" come from the same unwrap.
 */
function unwrap(field: z.ZodType): {
  inner: z.ZodType;
  required: boolean;
  defaultValue?: unknown;
} {
  let inner = field;
  let required = true;
  let defaultValue: unknown;

  for (;;) {
    const def = defOf(inner);

    if (def.type === 'prefault' || def.type === 'default') {
      defaultValue = def.defaultValue;
      inner = def.innerType as z.ZodType;
      required = false;
      continue;
    }

    if (def.type === 'optional') {
      inner = def.innerType as z.ZodType;
      required = false;
      continue;
    }

    // `numberInput` (@rasta/contracts): text is converted before the schema
    // underneath runs (a pipe out of a transform), and that schema is what the
    // parameter is.
    if (def.type === 'pipe' && defOf(def.in as z.ZodType).type === 'transform') {
      inner = def.out as z.ZodType;
      continue;
    }

    return { inner, required, defaultValue };
  }
}
