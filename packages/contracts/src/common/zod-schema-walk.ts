import type { z } from 'zod';

/**
 * Reading a zod 4 schema's structure — the one place outside the OpenAPI
 * converter that touches zod's internals (`schema._zod.def`).
 *
 * The error formatters print only what a schema owns (key names it declares,
 * the options of the enum it reaches) and look up which kind of schema raised
 * an issue; this is how they find out. Wrappers are looked through: optional,
 * nullable, default, prefault, catch, readonly, non-optional, promise, lazy.
 * A pipe (`preprocess`, `transform`, `.pipe()`) is both its input and its
 * output, since an issue may come from either; so are a union's options and an
 * intersection's two sides. A refinement is a check on the schema it refines,
 * so it needs no unwrapping at all.
 */

/** The `def` fields the walkers read, all optional: which ones exist depends on `type`. */
export interface ZodDefLike {
  readonly type: string;
  readonly innerType?: z.ZodType;
  readonly in?: z.ZodType;
  readonly out?: z.ZodType;
  readonly getter?: () => z.ZodType;
  readonly shape?: Record<string, z.ZodType>;
  readonly catchall?: z.ZodType;
  readonly keyType?: z.ZodType;
  readonly valueType?: z.ZodType;
  readonly element?: z.ZodType;
  readonly items?: readonly z.ZodType[];
  readonly rest?: z.ZodType | null;
  readonly options?: readonly z.ZodType[];
  readonly left?: z.ZodType;
  readonly right?: z.ZodType;
  readonly entries?: Record<string, string | number>;
  readonly values?: readonly unknown[];
}

/** A schema's definition, typed for the walkers. */
export function zodDef(schema: z.ZodType): ZodDefLike {
  return (schema as unknown as { _zod: { def: ZodDefLike } })._zod.def;
}

/** Wrappers whose inner schema is the whole story. */
const WRAPPERS = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'catch',
  'readonly',
  'nonoptional',
  'promise',
]);

/**
 * The schemas `schema` stands for once its wrappers are looked through: one
 * for a plain schema, several for a pipe (input and output), a union or an
 * intersection.
 */
export function unwrapZodSchema(schema: z.ZodType): z.ZodType[] {
  const found: z.ZodType[] = [];
  const seen = new Set<z.ZodType>();
  const visit = (node: z.ZodType): void => {
    if (seen.has(node)) return;
    seen.add(node);
    const def = zodDef(node);
    if (WRAPPERS.has(def.type) && def.innerType) return visit(def.innerType);
    switch (def.type) {
      case 'lazy':
        if (def.getter) visit(def.getter());
        return;
      case 'pipe':
        if (def.in) visit(def.in);
        if (def.out) visit(def.out);
        return;
      case 'union':
        for (const option of def.options ?? []) visit(option);
        return;
      case 'intersection':
        if (def.left) visit(def.left);
        if (def.right) visit(def.right);
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
 * into the value schema, but the segment is not printed. So is a key an object
 * takes through `.catchall()`.
 */
function step(
  nodes: readonly z.ZodType[],
  segment: PropertyKey,
): { next: z.ZodType[]; owned: boolean } {
  const next: z.ZodType[] = [];
  let owned = false;
  const index = typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0;
  for (const node of nodes.flatMap(unwrapZodSchema)) {
    const def = zodDef(node);
    switch (def.type) {
      case 'object': {
        const shape = def.shape ?? {};
        if (typeof segment === 'string' && Object.prototype.hasOwnProperty.call(shape, segment)) {
          next.push(shape[segment] as z.ZodType);
          owned = true;
        } else if (def.catchall && zodDef(def.catchall).type !== 'never') {
          next.push(def.catchall);
        }
        break;
      }
      case 'array':
        if (index && def.element) {
          next.push(def.element);
          owned = true;
        }
        break;
      case 'set':
        if (index && def.valueType) {
          next.push(def.valueType);
          owned = true;
        }
        break;
      case 'tuple': {
        const item = index ? (def.items?.[segment as number] ?? def.rest) : undefined;
        if (item) {
          next.push(item);
          owned = true;
        }
        break;
      }
      case 'record':
      case 'map':
        if (def.valueType) next.push(def.valueType);
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
export function resolveZodPath(
  schema: z.ZodType,
  path: readonly PropertyKey[],
): { nodes: z.ZodType[]; segments: (string | number | undefined)[] } {
  let nodes: z.ZodType[] = [schema];
  const segments: (string | number | undefined)[] = [];
  for (const segment of path) {
    const { next, owned } = step(nodes, segment);
    segments.push(owned && typeof segment !== 'symbol' ? segment : undefined);
    nodes = next;
  }
  return { nodes, segments };
}

/**
 * The options of an enum, as zod 3 listed them in an issue: for a native enum,
 * a numeric member's reverse key is dropped (`util.getValidEnumValues`).
 */
export function enumOptions(node: z.ZodType): readonly (string | number)[] | undefined {
  const def = zodDef(node);
  if (def.type !== 'enum' || !def.entries) return undefined;
  const entries = def.entries;
  return Object.keys(entries)
    .filter((key) => typeof entries[entries[key] as string | number] !== 'number')
    .map((key) => entries[key] as string | number);
}

/** The values of a literal schema. */
export function literalValues(node: z.ZodType): readonly unknown[] | undefined {
  const def = zodDef(node);
  return def.type === 'literal' ? (def.values ?? []) : undefined;
}
