import type { z } from 'zod';
import { enumOptions, resolveZodPath, unwrapZodSchema, zodDef } from '@rasta/contracts';

/**
 * Reading an environment schema's structure: which keys it declares, where an
 * issue's path leads, and which fields end in an enum.
 *
 * The error formatter ({@link envIssues} in `env-issues.ts`) prints only what
 * the schema owns — key names it declares, the options of the enum it reaches —
 * and this is how it finds them. The walk itself is the shared one in
 * `@rasta/contracts` (`zod-schema-walk.ts`), the only reader of zod's internals
 * outside the OpenAPI converter: wrappers (optional, nullable, default, catch,
 * readonly, lazy) are looked through, a pipe (`preprocess`, `transform`) is
 * both its input and its output, and a union's options and an intersection's
 * sides are all read.
 */

/** The schemas `schema` stands for once its wrappers are looked through. */
export const unwrapEnvSchema: (schema: z.ZodType) => z.ZodType[] = unwrapZodSchema;

/**
 * Where an issue path leads: the schemas at its end (empty once the walk
 * leaves the schema), and each segment, or `undefined` for one the schema does
 * not own (a record's key, a key no object declares).
 */
export const resolveEnvPath: (
  schema: z.ZodType,
  path: readonly PropertyKey[],
) => { nodes: z.ZodType[]; segments: (string | number | undefined)[] } = resolveZodPath;

/** The options of an enum, as Zod lists them in an issue. */
export { enumOptions };

/** A top-level environment variable whose schema reaches an enum. */
export interface EnvEnumField {
  /** The variable. */
  readonly name: string;
  /** The options of every enum its schema reaches, in the order found. */
  readonly options: readonly (readonly (string | number)[])[];
  /** Whether an enum is reached as the element of an array or a set (a list setting). */
  readonly inList: boolean;
}

/**
 * Every top-level variable of `schema` whose schema reaches a `z.enum` or a
 * `z.nativeEnum` — through the wrappers above, pipeline inputs and outputs,
 * preprocess and transform effects, defaults, optionals, unions, arrays, sets,
 * tuples and records. For tests: a new enum setting is found without being
 * listed anywhere.
 */
export function envEnumFields(schema: z.ZodType): EnvEnumField[] {
  const fields: EnvEnumField[] = [];
  const shapes = unwrapEnvSchema(schema)
    .map(zodDef)
    .filter((def) => def.type === 'object')
    .map((def) => def.shape ?? {});
  const names = new Set<string>();
  for (const shape of shapes) for (const name of Object.keys(shape)) names.add(name);

  for (const name of names) {
    const options: (readonly (string | number)[])[] = [];
    let inList = false;
    const seen = new Set<z.ZodType>();
    const visit = (node: z.ZodType, listed: boolean): void => {
      if (seen.has(node)) return;
      seen.add(node);
      for (const leaf of unwrapEnvSchema(node)) {
        const found = enumOptions(leaf);
        if (found) {
          options.push(found);
          inList ||= listed;
          continue;
        }
        const def = zodDef(leaf);
        switch (def.type) {
          case 'array':
            if (def.element) visit(def.element, true);
            break;
          case 'set':
            if (def.valueType) visit(def.valueType, true);
            break;
          case 'tuple':
            for (const item of def.items ?? []) visit(item, true);
            if (def.rest) visit(def.rest, true);
            break;
          case 'record':
          case 'map':
            if (def.valueType) visit(def.valueType, listed);
            break;
          case 'object':
            for (const child of Object.values(def.shape ?? {})) visit(child, listed);
            break;
          default:
            break;
        }
      }
    };
    for (const shape of shapes) {
      const field = shape[name];
      if (field) visit(field, false);
    }
    if (options.length > 0) fields.push({ name, options, inList });
  }
  return fields;
}
