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
export function ApiQueryFromSchema(schema: z.ZodObject<z.ZodRawShape>): MethodDecorator {
  return applyDecorators(...parametersOf(schema).map((parameter) => ApiQuery(parameter)));
}

/** Exported for its own test: what gets published has to be assertable. */
export function parametersOf(schema: z.ZodObject<z.ZodRawShape>): ApiQueryOptions[] {
  return Object.entries(schema.shape).map(([name, field]) => describe(name, field as z.ZodTypeAny));
}

function describe(name: string, field: z.ZodTypeAny): ApiQueryOptions {
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
  const def = (inner as z.ZodTypeAny & { _def: Record<string, unknown> })._def;
  const typeName = def.typeName as z.ZodFirstPartyTypeKind;

  const schema: Record<string, unknown> = { ...primitive(typeName, def) };
  if (defaultValue !== undefined) schema.default = defaultValue;

  return { name, required, schema };
}

function primitive(
  typeName: z.ZodFirstPartyTypeKind,
  def: Record<string, unknown>,
): Record<string, unknown> {
  switch (typeName) {
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: 'boolean' };

    case z.ZodFirstPartyTypeKind.ZodNumber:
      return numeric(def);

    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { type: 'string', enum: [...(def.values as string[])] };

    default:
      return { type: 'string' };
  }
}

function numeric(def: Record<string, unknown>): Record<string, unknown> {
  const checks = (def.checks ?? []) as { kind: string; value: number }[];
  const schema: Record<string, unknown> = {
    type: checks.some((check) => check.kind === 'int') ? 'integer' : 'number',
  };

  const min = checks.find((check) => check.kind === 'min');
  const max = checks.find((check) => check.kind === 'max');
  if (min) schema.minimum = min.value;
  if (max) schema.maximum = max.value;

  return schema;
}

/**
 * Peels `.default()` and `.optional()` off a field.
 *
 * Both decide whether a client must send the parameter, and both hide the
 * primitive underneath — so the answer to "is it required" and the answer to
 * "what type is it" come from the same unwrap.
 */
function unwrap(field: z.ZodTypeAny): {
  inner: z.ZodTypeAny;
  required: boolean;
  defaultValue?: unknown;
} {
  let inner = field;
  let required = true;
  let defaultValue: unknown;

  for (;;) {
    const def = (inner as z.ZodTypeAny & { _def: Record<string, unknown> })._def;

    if (def.typeName === z.ZodFirstPartyTypeKind.ZodDefault) {
      defaultValue = (def.defaultValue as () => unknown)();
      inner = def.innerType as z.ZodTypeAny;
      required = false;
      continue;
    }

    if (def.typeName === z.ZodFirstPartyTypeKind.ZodOptional) {
      inner = def.innerType as z.ZodTypeAny;
      required = false;
      continue;
    }

    return { inner, required, defaultValue };
  }
}
