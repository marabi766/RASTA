import { z } from 'zod';

/**
 * Reading an environment schema's structure: which keys it declares, where an
 * issue's path leads, and which fields end in an enum.
 *
 * The error formatter ({@link envIssues} in `env-issues.ts`) prints only what
 * the schema owns — key names it declares, the options of the enum it reaches —
 * and this is how it finds them. Zod 3's wrappers are looked through: optional,
 * nullable, default, catch, branded, readonly, lazy, and an effect
 * (`preprocess`, `transform`, `refine`) is read as the schema it wraps. A
 * pipeline is both its input and its output, since an issue may come from
 * either; so are a union's options and an intersection's two sides.
 */

const Kind = z.ZodFirstPartyTypeKind;

/** The schemas `schema` stands for once its wrappers are looked through. */
export function unwrapEnvSchema(schema: z.ZodTypeAny): z.ZodTypeAny[] {
  const found: z.ZodTypeAny[] = [];
  const seen = new Set<z.ZodTypeAny>();
  const visit = (node: z.ZodTypeAny): void => {
    if (seen.has(node)) return;
    seen.add(node);
    const def = node._def as { typeName?: string } & Record<string, unknown>;
    switch (def.typeName) {
      case Kind.ZodOptional:
      case Kind.ZodNullable:
      case Kind.ZodDefault:
      case Kind.ZodCatch:
      case Kind.ZodReadonly:
        visit(def.innerType as z.ZodTypeAny);
        return;
      case Kind.ZodBranded:
      case Kind.ZodPromise:
        visit(def.type as z.ZodTypeAny);
        return;
      case Kind.ZodLazy:
        visit((def.getter as () => z.ZodTypeAny)());
        return;
      case Kind.ZodEffects:
        visit(def.schema as z.ZodTypeAny);
        return;
      case Kind.ZodPipeline:
        visit(def.in as z.ZodTypeAny);
        visit(def.out as z.ZodTypeAny);
        return;
      case Kind.ZodUnion:
        for (const option of def.options as z.ZodTypeAny[]) visit(option);
        return;
      case Kind.ZodDiscriminatedUnion:
        for (const option of def.options as z.ZodTypeAny[]) visit(option);
        return;
      case Kind.ZodIntersection:
        visit(def.left as z.ZodTypeAny);
        visit(def.right as z.ZodTypeAny);
        return;
      default:
        found.push(node);
    }
  };
  visit(schema);
  return found;
}

/**
 * One step of an issue path from `nodes`: the schemas the segment leads to,
 * and whether the schema owns the segment. A key is owned when an object
 * declares it, an index when it falls in an array, a set or a tuple. A record's
 * or a map's key is the input's own, so it is not owned — the walk continues
 * into the value schema, but the segment is not printed.
 */
function step(
  nodes: readonly z.ZodTypeAny[],
  segment: string | number,
): { next: z.ZodTypeAny[]; owned: boolean } {
  const next: z.ZodTypeAny[] = [];
  let owned = false;
  for (const node of nodes.flatMap(unwrapEnvSchema)) {
    const def = node._def as { typeName?: string } & Record<string, unknown>;
    switch (def.typeName) {
      case Kind.ZodObject: {
        const shape = (node as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
        if (typeof segment === 'string' && Object.prototype.hasOwnProperty.call(shape, segment)) {
          next.push(shape[segment] as z.ZodTypeAny);
          owned = true;
        }
        break;
      }
      case Kind.ZodArray:
      case Kind.ZodSet:
        if (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0) {
          next.push((def.typeName === Kind.ZodArray ? def.type : def.valueType) as z.ZodTypeAny);
          owned = true;
        }
        break;
      case Kind.ZodTuple: {
        const items = def.items as z.ZodTypeAny[];
        const rest = def.rest as z.ZodTypeAny | null;
        if (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0) {
          const item = items[segment] ?? rest;
          if (item) {
            next.push(item);
            owned = true;
          }
        }
        break;
      }
      case Kind.ZodRecord:
      case Kind.ZodMap:
        next.push(def.valueType as z.ZodTypeAny);
        break;
      default:
        break;
    }
  }
  return { next, owned };
}

/**
 * Where an issue path leads: the schemas at its end (empty once the walk
 * leaves the schema), and each segment, or `undefined` for one the schema does
 * not own.
 */
export function resolveEnvPath(
  schema: z.ZodTypeAny,
  path: readonly (string | number)[],
): { nodes: z.ZodTypeAny[]; segments: (string | number | undefined)[] } {
  let nodes: z.ZodTypeAny[] = [schema];
  const segments: (string | number | undefined)[] = [];
  for (const segment of path) {
    const { next, owned } = step(nodes, segment);
    segments.push(owned ? segment : undefined);
    nodes = next;
  }
  return { nodes, segments };
}

/** The options of an enum, as Zod lists them in an issue. */
export function enumOptions(node: z.ZodTypeAny): readonly (string | number)[] | undefined {
  const def = node._def as { typeName?: string } & Record<string, unknown>;
  if (def.typeName === Kind.ZodEnum) return def.values as readonly string[];
  if (def.typeName === Kind.ZodNativeEnum) {
    // Zod's own reading (`util.getValidEnumValues`): a numeric enum's reverse keys are dropped.
    const values = def.values as Record<string, string | number>;
    return Object.keys(values)
      .filter((key) => typeof values[values[key] as string | number] !== 'number')
      .map((key) => values[key] as string | number);
  }
  return undefined;
}

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
export function envEnumFields(schema: z.ZodTypeAny): EnvEnumField[] {
  const fields: EnvEnumField[] = [];
  const shapes = unwrapEnvSchema(schema).filter(
    (node) => (node._def as { typeName?: string }).typeName === Kind.ZodObject,
  ) as z.AnyZodObject[];
  const names = new Set<string>();
  for (const shape of shapes) for (const name of Object.keys(shape.shape)) names.add(name);

  for (const name of names) {
    const options: (readonly (string | number)[])[] = [];
    let inList = false;
    const seen = new Set<z.ZodTypeAny>();
    const visit = (node: z.ZodTypeAny, listed: boolean): void => {
      if (seen.has(node)) return;
      seen.add(node);
      for (const leaf of unwrapEnvSchema(node)) {
        const found = enumOptions(leaf);
        if (found) {
          options.push(found);
          inList ||= listed;
          continue;
        }
        const def = leaf._def as { typeName?: string } & Record<string, unknown>;
        switch (def.typeName) {
          case Kind.ZodArray:
            visit(def.type as z.ZodTypeAny, true);
            break;
          case Kind.ZodSet:
            visit(def.valueType as z.ZodTypeAny, true);
            break;
          case Kind.ZodTuple:
            for (const item of def.items as z.ZodTypeAny[]) visit(item, true);
            if (def.rest) visit(def.rest as z.ZodTypeAny, true);
            break;
          case Kind.ZodRecord:
          case Kind.ZodMap:
            visit(def.valueType as z.ZodTypeAny, listed);
            break;
          case Kind.ZodObject:
            for (const child of Object.values((leaf as z.AnyZodObject).shape)) {
              visit(child as z.ZodTypeAny, listed);
            }
            break;
          default:
            break;
        }
      }
    };
    for (const shape of shapes) {
      const field = (shape.shape as Record<string, z.ZodTypeAny>)[name];
      if (field) visit(field, false);
    }
    if (options.length > 0) fields.push({ name, options, inList });
  }
  return fields;
}
