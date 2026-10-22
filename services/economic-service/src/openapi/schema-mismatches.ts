import type { JsonSchema } from './zod-schema';

/**
 * How `value` departs from the documented `schema`, one line per departure,
 * at `path`; empty when it conforms. `$ref`s resolve against `components`.
 *
 * Only what the hand-written views use (`transaction-view.ts`): strings (with
 * `date-time` and `pattern`), integers, booleans, arrays, objects and
 * `nullable`. Every documented property must be present — documented and
 * never written is a promise a generated client would rely on. Properties
 * the schema does not name are not departures (no `additionalProperties:
 * false`). Used by the specs that hold the document to the responses.
 */
export function schemaMismatches(
  schema: JsonSchema,
  value: unknown,
  path: string,
  components: Record<string, JsonSchema>,
): string[] {
  if (value === null) return schema.nullable === true ? [] : [`${path}: null, not nullable`];
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/components/schemas/', '');
    const target = components[name];
    return target
      ? schemaMismatches(target, value, path, components)
      : [`${path}: unknown ${name}`];
  }
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') return [`${path}: ${typeof value}, not string`];
      if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
        return [`${path}: not a date-time`];
      }
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
        return [`${path}: does not match ${schema.pattern}`];
      }
      return [];
    case 'integer':
      return Number.isInteger(value) ? [] : [`${path}: not an integer`];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path}: not a boolean`];
    case 'array':
      if (!Array.isArray(value)) return [`${path}: not an array`];
      return value.flatMap((item, i) =>
        schemaMismatches(schema.items as JsonSchema, item, `${path}[${i}]`, components),
      );
    case 'object': {
      if (typeof value !== 'object') return [`${path}: not an object`];
      const record = value as Record<string, unknown>;
      const properties = schema.properties as Record<string, JsonSchema>;
      return Object.entries(properties).flatMap(([key, property]) =>
        key in record
          ? schemaMismatches(property, record[key], `${path}.${key}`, components)
          : [`${path}.${key}: documented, never written`],
      );
    }
    default:
      return [`${path}: undocumented type ${String(schema.type)}`];
  }
}
