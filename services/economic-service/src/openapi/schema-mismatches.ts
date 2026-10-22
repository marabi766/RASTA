import type { JsonSchema } from './zod-schema';

/**
 * How `value` departs from the documented `schema`, one line per departure,
 * at `path`; empty when it conforms. `$ref`s resolve against `components`.
 *
 * Only what the hand-written views use (`transaction-view.ts`): strings (with
 * `date-time` and `pattern`), integers, booleans, arrays, objects and
 * `nullable`. Both ways: every documented property must be present —
 * documented and never written is a promise a generated client would rely
 * on — and every property written must be documented — written and never
 * documented is a field no generated client has, which is how the detail
 * view's `disputeId` and `settlementAuthorisation` went unnoticed (Codex on
 * #322 round 3, finding 1). The document itself stays open (no
 * `additionalProperties: false`); this check is what keeps it complete. Used
 * by the specs that hold the document to the responses.
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
      return [
        ...Object.entries(properties).flatMap(([key, property]) =>
          key in record
            ? schemaMismatches(property, record[key], `${path}.${key}`, components)
            : [`${path}.${key}: documented, never written`],
        ),
        ...Object.keys(record)
          .filter((key) => !Object.hasOwn(properties, key))
          .map((key) => `${path}.${key}: written, never documented`),
      ];
    }
    default:
      return [`${path}: undocumented type ${String(schema.type)}`];
  }
}
