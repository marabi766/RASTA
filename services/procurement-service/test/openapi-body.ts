import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * Validates a real response body against the schema the **published** document gives for that
 * operation and status (PR-327 r1 F3) — the JSON a client's validator reads, not the Zod source it
 * was generated from.
 *
 * Only the keywords `toJsonSchema` emits are understood, and any other keyword is an error rather
 * than ignored: a validator that skipped what it did not know would accept a body the document
 * refuses. (ajv is a root devDependency only; services declare what they import.)
 */
type Schema = Record<string, unknown>;

const KNOWN = new Set([
  '$ref',
  'type',
  'nullable',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'format',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'anyOf',
  'description',
]);

/** ISO 8601 instant as `Date#toISOString` writes it and `isoDateTime()` (@rasta/contracts) accepts it. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function responseSchemaOf(
  document: OpenAPIObject,
  method: string,
  path: string,
  status: number,
): Schema {
  const operation = (document.paths?.[path] as Record<string, unknown> | undefined)?.[
    method.toLowerCase()
  ] as { responses?: Record<string, { content?: Record<string, { schema?: Schema }> }> };
  const schema = operation?.responses?.[String(status)]?.content?.['application/json']?.schema;
  if (!schema) throw new Error(`${method} ${path} documents no JSON body for ${status}`);
  return schema;
}

/** The problems of `value` under `schema`; empty when it is accepted. */
export function validateBody(document: OpenAPIObject, schema: Schema, value: unknown): string[] {
  const problems: string[] = [];
  check(document, schema, value, '$', problems);
  return problems;
}

function check(
  document: OpenAPIObject,
  schema: Schema,
  value: unknown,
  at: string,
  problems: string[],
): void {
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN.has(keyword)) throw new Error(`${at}: schema keyword ${keyword} is not understood`);
  }
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/components/schemas/', '');
    const target = document.components?.schemas?.[name] as Schema | undefined;
    if (!target) throw new Error(`${at}: unresolved ${schema.$ref}`);
    check(document, target, value, at, problems);
    return;
  }
  if (value === null && schema.nullable === true) return;
  if (Array.isArray(schema.anyOf)) {
    const accepted = (schema.anyOf as Schema[]).some(
      (option) => validateBody(document, option, value).length === 0,
    );
    if (!accepted) problems.push(`${at}: matches no anyOf option`);
    return;
  }
  if ('const' in schema && value !== schema.const) {
    problems.push(`${at}: ${JSON.stringify(value)} is not ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  }
  switch (schema.type) {
    case undefined:
      return;
    case 'string':
      if (typeof value !== 'string') {
        problems.push(`${at}: not a string`);
        return;
      }
      if (schema.format === 'date-time' && !DATE_TIME.test(value)) {
        problems.push(`${at}: not a date-time`);
      } else if (schema.format !== undefined && schema.format !== 'date-time') {
        throw new Error(`${at}: format ${String(schema.format)} is not understood`);
      }
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
        problems.push(`${at}: shorter than ${schema.minLength}`);
      }
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
        problems.push(`${at}: longer than ${schema.maxLength}`);
      }
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
        problems.push(`${at}: does not match ${schema.pattern}`);
      }
      return;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || (schema.type === 'integer' && !Number.isInteger(value))) {
        problems.push(`${at}: not ${String(schema.type)}`);
        return;
      }
      if (typeof schema.minimum === 'number' && value < schema.minimum) {
        problems.push(`${at}: below ${schema.minimum}`);
      }
      if (typeof schema.maximum === 'number' && value > schema.maximum) {
        problems.push(`${at}: above ${schema.maximum}`);
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`${at}: not a boolean`);
      return;
    case 'array':
      if (!Array.isArray(value)) {
        problems.push(`${at}: not an array`);
        return;
      }
      value.forEach((item, index) =>
        check(document, (schema.items ?? {}) as Schema, item, `${at}[${index}]`, problems),
      );
      return;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        problems.push(`${at}: not an object`);
        return;
      }
      const record = value as Record<string, unknown>;
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      for (const name of (schema.required ?? []) as string[]) {
        if (!(name in record)) problems.push(`${at}.${name}: required`);
      }
      for (const [name, member] of Object.entries(record)) {
        const property = properties[name];
        if (property) check(document, property, member, `${at}.${name}`, problems);
        else if (schema.additionalProperties === false) {
          problems.push(`${at}.${name}: not allowed`);
        }
      }
      return;
    }
    default:
      throw new Error(`${at}: type ${String(schema.type)} is not understood`);
  }
}
