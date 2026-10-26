/**
 * The tasks `runInBuild` runs in one of zod's builds (D-078, PR #444 r4): the
 * patched zod (`patched`, which `legacyParse` loads too) against stock zod 4
 * (`stock`, an unmodified copy loaded on its own). Plain data in, plain data
 * out: every value crosses a process boundary as JSON.
 */
import type { z as zodNamespace } from 'zod';

import type * as ZodIssues from '../zod-issues';

type Z = typeof zodNamespace;
type Schema = zodNamespace.ZodType;
type Issues = typeof ZodIssues;

export interface Context {
  patched: Z;
  stock: Z;
  issues: Issues;
}

/** zod's switch for zod 3's run order; only `legacyParse` (and these tests) name it. */
const SWITCHED = { [Symbol.for('@rasta/zod.legacyRunOrder')]: true };

/**
 * A value as a string that two deep-equal values share and two different ones
 * do not: types, ±0, NaN, ±Infinity, `undefined` members, Dates, Maps, Sets,
 * class names and key order included.
 */
export function canon(value: unknown, seen: Set<object> = new Set()): string {
  if (value === undefined) return 'u';
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      return Object.is(value, -0) ? 'n:-0' : `n:${String(value)}`;
    case 'bigint':
      return `b:${value}`;
    case 'string':
      return `s:${JSON.stringify(value)}`;
    case 'boolean':
      return `t:${value}`;
    case 'symbol':
      return `y:${String(value)}`;
    case 'function':
      return `f:${value.name}`;
    default:
      break;
  }
  const object = value as object;
  if (seen.has(object)) return 'cycle';
  seen.add(object);
  try {
    if (object instanceof Date) return `d:${object.getTime()}`;
    if (Array.isArray(object)) return `[${object.map((each) => canon(each, seen)).join(',')}]`;
    if (object instanceof Map) {
      return `M{${[...object].map(([k, v]) => `${canon(k, seen)}=>${canon(v, seen)}`).join(',')}}`;
    }
    if (object instanceof Set) return `S{${[...object].map((v) => canon(v, seen)).join(',')}}`;
    const name = Object.getPrototypeOf(object)?.constructor?.name ?? 'null';
    const keys = Reflect.ownKeys(object).filter(
      (key) => Object.getOwnPropertyDescriptor(object, key)?.enumerable,
    );
    const body = keys
      .map((key) => `${String(key)}:${canon((object as Record<PropertyKey, unknown>)[key], seen)}`)
      .join(',');
    return `${name}{${body}}`;
  } finally {
    seen.delete(object);
  }
}

type Outcome =
  | { kind: 'accepted'; data: string }
  | { kind: 'refused'; issues: string; codes: string[] }
  | { kind: 'threw'; message: string };

function settle(run: () => zodNamespace.ZodSafeParseResult<unknown>): Outcome {
  try {
    const result = run();
    if (result.success) return { kind: 'accepted', data: canon(result.data) };
    const issues = result.error.issues;
    return { kind: 'refused', issues: canon(issues), codes: issues.map((issue) => issue.code) };
  } catch (error) {
    return { kind: 'threw', message: (error as Error).message };
  }
}

type LegacyOutcome =
  | { kind: 'accepted'; data: string }
  | { kind: 'refused'; issues: { path: string; code: string; message: string }[] }
  | { kind: 'threw'; message: string };

function legacy(ctx: Context, schema: Schema, input: unknown): LegacyOutcome {
  try {
    const result = ctx.issues.legacyParse(schema, input);
    if (result.success) return { kind: 'accepted', data: canon(result.data) };
    return {
      kind: 'refused',
      issues: result.refusal.issues.map(({ path, code, message }) => ({
        path: path.join('.'),
        code,
        message,
      })),
    };
  } catch (error) {
    return { kind: 'threw', message: (error as Error).message };
  }
}

/** Codex PR-444 r3 F3 and its wrappers: a refusal another combinator reconciles away. */
function f3Schemas(z: Z, calls: { n: number }): [string, Schema, unknown][] {
  const left = () =>
    z
      .object({ a: z.string() })
      .strict()
      .transform((value) => value)
      .refine(() => {
        calls.n += 1;
        return false;
      }, 'never allowed');
  const core = () => z.intersection(left(), z.object({ b: z.string() }));
  return [
    ['direct', core(), { a: 'a', b: 'b' }],
    ['under an object', z.object({ outer: core() }), { outer: { a: 'a', b: 'b' } }],
    ['under a union', z.union([z.number(), core()]), { a: 'a', b: 'b' }],
    ['under a pipe', z.unknown().pipe(core()), { a: 'a', b: 'b' }],
    ['under .and()', left().and(z.object({ b: z.string() })), { a: 'a', b: 'b' }],
  ];
}

export function f3(ctx: Context): unknown[] {
  const stockCalls = { n: 0 };
  const patchedCalls = { n: 0 };
  const stock = f3Schemas(ctx.stock, stockCalls);
  const patched = f3Schemas(ctx.patched, patchedCalls);
  return stock.map(([name, stockSchema, input], at) => {
    const schema = patched[at][1];
    const before = canon(input);
    stockCalls.n = 0;
    const stockOutcome = settle(() => stockSchema.safeParse(input));
    const stockRefinementCalls = stockCalls.n;
    patchedCalls.n = 0;
    const plain = settle(() => schema.safeParse(input));
    const plainRefinementCalls = patchedCalls.n;
    const switched = settle(() => schema.safeParse(input, SWITCHED as never));
    const viaLegacy = legacy(ctx, schema, input);
    const stockIssues =
      stockOutcome.kind === 'refused'
        ? legacy(ctx, stockSchema, input) // the stock refusal, translated
        : stockOutcome;
    return {
      name,
      stock: stockOutcome,
      stockRefinementCalls,
      plain,
      plainRefinementCalls,
      switched: switched.kind,
      legacy: viaLegacy,
      stockTranslated: stockIssues,
      inputUnchanged: canon(input) === before,
    };
  });
}

/** One case per hunk of the patch: what zod 3 reported, in its order, only with the switch on. */
function ruleSchemas(z: Z): [string, Schema, unknown][] {
  const refused = (schema: Schema) =>
    schema.refine(() => false, { message: 'enclosing', path: ['refinement'] });
  return [
    ['int', refused(z.object({ n: z.number().int().min(1) })), { n: 0.5 }],
    ['z.int()', refused(z.object({ n: z.int().min(1) })), { n: 0.5 }],
    ['infinity', refused(z.object({ n: z.number().max(5) })), { n: Number.POSITIVE_INFINITY }],
    [
      'transform issue',
      refused(
        z.object({
          b: z.string().transform((value, inner) => {
            inner.addIssue({ code: 'custom', message: 'not a boolean' });
            return value;
          }),
        }),
      ),
      { b: 'x' },
    ],
    [
      'refused before a transform',
      refused(
        z.object({
          s: z
            .string()
            .min(3)
            .transform((value) => value),
        }),
      ),
      { s: 'x' },
    ],
    [
      'union',
      refused(z.object({ u: z.union([z.string().min(5), z.string().regex(/^a+$/)]) })),
      { u: 'b' },
    ],
  ];
}

export async function rules(ctx: Context): Promise<unknown[]> {
  const stock = ruleSchemas(ctx.stock);
  const out: unknown[] = [];
  for (const [at, [name, schema, input]] of ruleSchemas(ctx.patched).entries()) {
    out.push({
      name,
      stock: settle(() => stock[at][1].safeParse(input)),
      plain: settle(() => schema.safeParse(input)),
      plainAsync: await outcomeAsync(() => schema.safeParseAsync(input)),
      switched: settle(() => schema.safeParse(input, SWITCHED as never)),
      switchedAsync: await outcomeAsync(() => schema.safeParseAsync(input, SWITCHED as never)),
      legacy: legacy(ctx, schema, input),
    });
  }
  return out;
}

async function outcomeAsync(
  run: () => Promise<zodNamespace.ZodSafeParseResult<unknown>>,
): Promise<Outcome> {
  try {
    const result = await run();
    return settle(() => result);
  } catch (error) {
    return { kind: 'threw', message: (error as Error).message };
  }
}

/**
 * The switch reaches every way zod runs a nested schema: a failed `.int()`
 * deep inside each wrapper still lets the enclosing refinement run (zod 3's
 * order) when switched, and does not when not.
 */
export async function reaches(ctx: Context): Promise<unknown[]> {
  const z = ctx.patched;
  const int = () => z.number().int();
  const wrappers: [string, () => Schema, unknown][] = [
    ['object', () => z.object({ a: z.object({ n: int() }) }), { a: { n: 0.5 } }],
    ['array', () => z.array(int()), [1, 0.5]],
    ['record', () => z.record(z.string(), int()), { k: 0.5 }],
    ['tuple', () => z.tuple([z.string(), int()]), ['s', 0.5]],
    ['union', () => z.union([z.object({ n: int() }), z.string()]), { n: 0.5 }],
    [
      'discriminated union',
      () =>
        z.discriminatedUnion('t', [
          z.object({ t: z.literal('a'), n: int() }),
          z.object({ t: z.literal('b') }),
        ]),
      { t: 'a', n: 0.5 },
    ],
    [
      'intersection',
      () => z.intersection(z.object({ n: int() }), z.object({ s: z.string() })),
      { n: 0.5, s: 's' },
    ],
    ['pipe', () => z.unknown().pipe(z.object({ n: int() })), { n: 0.5 }],
    ['lazy', () => z.lazy(() => z.object({ n: int() })), { n: 0.5 }],
    ['optional', () => z.object({ n: int().optional() }), { n: 0.5 }],
    ['nullable', () => z.object({ n: int().nullable() }), { n: 0.5 }],
    // zod's own .default(), which D-078 item 3c asks the composition to cover;
    // production never reaches it (zod/no-default).
    // eslint-disable-next-line zod/no-default
    ['default', () => z.object({ n: int().default(1) }), { n: 0.5 }],
    ['prefault', () => z.object({ n: int().prefault(1) }), { n: 0.5 }],
    ['readonly', () => z.object({ n: int() }).readonly(), { n: 0.5 }],
    ['preprocess', () => z.preprocess((value) => value, z.object({ n: int() })), { n: 0.5 }],
    ['async refinement', () => z.object({ n: int() }).refine(async () => true), { n: 0.5 }],
  ];
  const out: unknown[] = [];
  for (const [name, inner, input] of wrappers) {
    let calls = 0;
    const schema = inner().refine(() => {
      calls += 1;
      return false;
    }, 'enclosing');
    const async = name === 'async refinement';
    calls = 0;
    const plain = async
      ? await outcomeAsync(() => schema.safeParseAsync(input))
      : settle(() => schema.safeParse(input));
    const plainCalls = calls;
    calls = 0;
    const switched = await outcomeAsync(() => schema.safeParseAsync(input, SWITCHED as never));
    const switchedCalls = calls;
    out.push({ name, plain: plain.kind, plainCalls, switched: switched.kind, switchedCalls });
  }
  return out;
}

/**
 * Switch isolation (addendum C): an ordinary parse started inside a switched
 * parse's refinement runs as stock zod; switched and ordinary async parses
 * interleaved on one schema do not leak into each other.
 */
export async function isolation(ctx: Context): Promise<unknown> {
  const z = ctx.patched;
  let innerCalls = 0;
  const inner = z.object({ n: z.number().int() }).refine(() => {
    innerCalls += 1;
    return false;
  });
  const nested: unknown[] = [];
  const outer = z.object({ s: z.string().min(5) }).superRefine(() => {
    innerCalls = 0;
    const result = inner.safeParse({ n: 0.5 });
    nested.push({ codes: result.error?.issues.map((issue) => issue.code), innerCalls });
  });
  const viaLegacy = legacy(ctx, outer, { s: 'x' });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  let calls = 0;
  const schema = z.object({ n: z.number().int().min(1), s: z.string() }).refine(async () => {
    await tick();
    calls += 1;
    return false;
  }, 'enclosing');
  const runs: Promise<Outcome>[] = [];
  for (let i = 0; i < 40; i += 1) {
    runs.push(
      outcomeAsync(() =>
        i % 2 === 0
          ? schema.safeParseAsync({ n: 0.5, s: 's' }, SWITCHED as never)
          : schema.safeParseAsync({ n: 0.5, s: 's' }),
      ),
    );
  }
  const settled = await Promise.all(runs);
  return {
    nested,
    legacy: viaLegacy,
    switchedCodes: [...new Set(settled.filter((_, i) => i % 2 === 0).map(codesOf))],
    ordinaryCodes: [...new Set(settled.filter((_, i) => i % 2 === 1).map(codesOf))],
    stockCodes: codesOf(
      await outcomeAsync(() =>
        ctx.stock
          .object({ n: ctx.stock.number().int().min(1), s: ctx.stock.string() })
          .refine(async () => false, 'enclosing')
          .safeParseAsync({ n: 0.5, s: 's' }),
      ),
    ),
    refinementCalls: calls,
  };
}

const codesOf = (outcome: Outcome): string =>
  outcome.kind === 'refused' ? outcome.codes.join(',') : outcome.kind;

/**
 * GHSA-mrhx-c7xc-m3w5: an oversized array is refused before any element is
 * parsed, in the stock pass and in the switched pass legacyParse adds.
 */
export function ghsa(ctx: Context): unknown {
  const count = (z: Z) => {
    const seen = { elements: 0 };
    const schema = z.object({
      items: z
        .array(
          z.string().refine(() => {
            seen.elements += 1;
            return true;
          }),
        )
        .max(3),
    });
    return { schema, seen };
  };
  const input = { items: Array.from({ length: 100_000 }, () => 'x') };
  const stock = count(ctx.stock);
  const stockOutcome = settle(() => stock.schema.safeParse(input));
  const plain = count(ctx.patched);
  const plainOutcome = settle(() => plain.schema.safeParse(input));
  const switched = count(ctx.patched);
  const switchedOutcome = settle(() => switched.schema.safeParse(input, SWITCHED as never));
  const viaLegacy = count(ctx.patched);
  const legacyOutcome = legacy(ctx, viaLegacy.schema, input);
  return {
    stock: [codesOf(stockOutcome), stock.seen.elements],
    plain: [codesOf(plainOutcome), plain.seen.elements],
    switched: [codesOf(switchedOutcome), switched.seen.elements],
    legacy: [
      legacyOutcome.kind === 'refused'
        ? legacyOutcome.issues.map((i) => i.code).join(',')
        : legacyOutcome.kind,
      viaLegacy.seen.elements,
    ],
  };
}

// ---------------------------------------------------------------------------
// Composition fuzz (D-078 item 3c): random schemas over intersection, union,
// pipe, transform, refine, superRefine, strict/strip/loose objects, lazy,
// preprocess, default, prefault, catch, optional, nullable, arrays and every
// leaf the patch touches, each built twice from one description (stock and
// patched), with random near-valid and hostile inputs.
// ---------------------------------------------------------------------------

type Node =
  | { k: 'string'; min?: number; max?: number; regex?: boolean }
  | { k: 'number'; int?: boolean; min?: number; max?: number; finite?: boolean }
  | { k: 'zint'; min?: number }
  | { k: 'bool' }
  | { k: 'literal' }
  | { k: 'enum' }
  | { k: 'unknown' }
  | { k: 'object'; mode: 'strict' | 'strip' | 'loose'; shape: [string, Node][] }
  | { k: 'array'; el: Node; max?: number; min?: number }
  | { k: 'intersection'; l: Node; r: Node }
  | { k: 'union'; options: Node[] }
  | { k: 'pipe'; from: Node; to: Node }
  | { k: 'transform'; inner: Node; f: 'id' | 'wrap' | 'issue' | 'fatal' | 'length' }
  | { k: 'refine'; inner: Node; p: Predicate; abort?: boolean }
  | { k: 'superRefine'; inner: Node; p: Predicate }
  | { k: 'lazy'; inner: Node }
  | { k: 'preprocess'; inner: Node; f: 'id' | 'trim' | 'number' }
  | { k: 'default' | 'prefault' | 'catch'; inner: Node; value: unknown }
  | { k: 'optional' | 'nullable'; inner: Node };

type Predicate = 'never' | 'always' | 'even' | 'truthy';

const KEYS = ['a', 'b', 'c', 'n'];

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, list: readonly T[]): T {
  return list[Math.floor(r() * list.length)];
}

function leaf(r: () => number): Node {
  switch (pick(r, ['string', 'number', 'number', 'zint', 'bool', 'literal', 'enum', 'unknown'])) {
    case 'string':
      return {
        k: 'string',
        min: r() < 0.4 ? 2 : undefined,
        max: r() < 0.3 ? 5 : undefined,
        regex: r() < 0.2,
      };
    case 'number':
      return {
        k: 'number',
        int: r() < 0.6,
        min: r() < 0.4 ? 1 : undefined,
        max: r() < 0.3 ? 50 : undefined,
        finite: r() < 0.1,
      };
    case 'zint':
      return { k: 'zint', min: r() < 0.5 ? 0 : undefined };
    case 'bool':
      return { k: 'bool' };
    case 'literal':
      return { k: 'literal' };
    case 'enum':
      return { k: 'enum' };
    default:
      return { k: 'unknown' };
  }
}

function objectNode(r: () => number, depth: number): Node {
  const keys = KEYS.filter(() => r() < 0.55);
  if (keys.length === 0) keys.push(pick(r, KEYS));
  return {
    k: 'object',
    mode: pick(r, ['strict', 'strict', 'strip', 'loose'] as const),
    shape: keys.map((key) => [key, node(r, depth + 1)]),
  };
}

function node(r: () => number, depth: number): Node {
  if (depth >= 3 || r() < 0.25) return leaf(r);
  const kind = pick(r, [
    'object',
    'object',
    'array',
    'intersection',
    'intersection',
    'union',
    'pipe',
    'transform',
    'transform',
    'refine',
    'refine',
    'superRefine',
    'lazy',
    'preprocess',
    'default',
    'prefault',
    'catch',
    'optional',
    'nullable',
  ]);
  const inner = () => node(r, depth + 1);
  switch (kind) {
    case 'object':
      return objectNode(r, depth);
    case 'array':
      return {
        k: 'array',
        el: inner(),
        max: r() < 0.5 ? 3 : undefined,
        min: r() < 0.3 ? 1 : undefined,
      };
    case 'intersection':
      // Mostly objects (where keys reconcile), sometimes anything.
      return r() < 0.8
        ? {
            k: 'intersection',
            l: wrapMaybe(r, objectNode(r, depth), depth),
            r: wrapMaybe(r, objectNode(r, depth), depth),
          }
        : { k: 'intersection', l: inner(), r: inner() };
    case 'union':
      return { k: 'union', options: [inner(), inner(), ...(r() < 0.3 ? [inner()] : [])] };
    case 'pipe':
      return { k: 'pipe', from: r() < 0.5 ? { k: 'unknown' } : inner(), to: inner() };
    case 'transform':
      return {
        k: 'transform',
        inner: inner(),
        f: pick(r, ['id', 'wrap', 'issue', 'fatal', 'length'] as const),
      };
    case 'refine':
      return { k: 'refine', inner: inner(), p: predicate(r), abort: r() < 0.2 };
    case 'superRefine':
      return { k: 'superRefine', inner: inner(), p: predicate(r) };
    case 'lazy':
      return { k: 'lazy', inner: inner() };
    case 'preprocess':
      return { k: 'preprocess', inner: inner(), f: pick(r, ['id', 'trim', 'number'] as const) };
    case 'default':
    case 'prefault':
    case 'catch': {
      const wrapped = inner();
      return { k: kind, inner: wrapped, value: sample(wrapped, rng(Math.floor(r() * 1e9)), 0) };
    }
    default:
      return { k: kind as 'optional' | 'nullable', inner: inner() };
  }
}

/** An object operand of an intersection, sometimes behind a transform and a refinement: the F3 shape. */
function wrapMaybe(r: () => number, object: Node, depth: number): Node {
  if (depth >= 2 || r() < 0.3) return object;
  const transformed: Node = {
    k: 'transform',
    inner: object,
    f: pick(r, ['id', 'id', 'issue'] as const),
  };
  return r() < 0.8 ? { k: 'refine', inner: transformed, p: predicate(r) } : transformed;
}

function predicate(r: () => number): Predicate {
  return pick(r, ['never', 'always', 'even', 'even', 'truthy'] as const);
}

function holds(p: Predicate, value: unknown): boolean {
  switch (p) {
    case 'never':
      return false;
    case 'always':
      return true;
    case 'truthy':
      return Boolean(value);
    default:
      return canon(value).length % 2 === 0;
  }
}

function realize(z: Z, n: Node): Schema {
  switch (n.k) {
    case 'string': {
      let s = z.string();
      if (n.min !== undefined) s = s.min(n.min);
      if (n.max !== undefined) s = s.max(n.max);
      if (n.regex) s = s.regex(/^[a-c]+$/);
      return s;
    }
    case 'number': {
      let s = z.number();
      if (n.int) s = s.int();
      if (n.min !== undefined) s = s.min(n.min);
      if (n.max !== undefined) s = s.max(n.max);
      if (n.finite) s = s.finite();
      return s;
    }
    case 'zint':
      return n.min === undefined ? z.int() : z.int().min(n.min);
    case 'bool':
      return z.boolean();
    case 'literal':
      return z.literal('a');
    case 'enum':
      return z.enum(['a', 'b']);
    case 'unknown':
      return z.unknown();
    case 'object': {
      const shape = Object.fromEntries(n.shape.map(([key, child]) => [key, realize(z, child)]));
      return n.mode === 'strict'
        ? z.strictObject(shape)
        : n.mode === 'loose'
          ? z.looseObject(shape)
          : z.object(shape);
    }
    case 'array': {
      let s = z.array(realize(z, n.el));
      if (n.min !== undefined) s = s.min(n.min);
      if (n.max !== undefined) s = s.max(n.max);
      return s;
    }
    case 'intersection':
      return z.intersection(realize(z, n.l), realize(z, n.r));
    case 'union': {
      const [first, second, ...rest] = n.options.map((option) => realize(z, option));
      return z.union([first, second, ...rest]);
    }
    case 'pipe':
      return realize(z, n.from).pipe(realize(z, n.to) as never);
    case 'transform': {
      const inner = realize(z, n.inner);
      switch (n.f) {
        case 'id':
          return inner.transform((value) => value);
        case 'wrap':
          return inner.transform((value) => ({ w: value }));
        case 'length':
          return inner.transform((value) => canon(value).length);
        case 'issue':
          return inner.transform((value, inner) => {
            if (!holds('even', value))
              inner.addIssue({ code: 'custom', message: 'transform issue' });
            return value;
          });
        default:
          return inner.transform((value, inner) => {
            if (!holds('even', value)) {
              inner.addIssue({
                code: 'custom',
                message: 'fatal transform issue',
                fatal: true,
              } as never);
              return z.NEVER;
            }
            return value;
          });
      }
    }
    case 'refine':
      return realize(z, n.inner).refine((value) => holds(n.p, value), {
        message: `refine ${n.p}`,
        ...(n.abort ? { abort: true } : {}),
      });
    case 'superRefine':
      return realize(z, n.inner).superRefine((value, inner) => {
        if (!holds(n.p, value)) inner.addIssue({ code: 'custom', message: `superRefine ${n.p}` });
      });
    case 'lazy': {
      const inner = realize(z, n.inner);
      return z.lazy(() => inner);
    }
    case 'preprocess':
      return z.preprocess(
        n.f === 'id'
          ? (value) => value
          : n.f === 'trim'
            ? (value) => (typeof value === 'string' ? value.trim() : value)
            : (value) => (typeof value === 'string' && value !== '' ? Number(value) : value),
        realize(z, n.inner),
      );
    case 'default':
      // zod's own .default(), covered as D-078 item 3c asks; production never reaches it.
      // eslint-disable-next-line zod/no-default
      return realize(z, n.inner).default(structuredClone(n.value) as never);
    case 'prefault':
      return realize(z, n.inner).prefault(structuredClone(n.value) as never);
    case 'catch':
      return realize(z, n.inner).catch(structuredClone(n.value) as never);
    case 'optional':
      return realize(z, n.inner).optional();
    default:
      return realize(z, n.inner).nullable();
  }
}

const HOSTILE: unknown[] = [
  undefined,
  null,
  0,
  0.5,
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  '',
  'x',
  [],
  {},
  true,
];

/** A value for `n`: near-valid mostly, hostile sometimes, at every depth. */
function sample(n: Node, r: () => number, depth: number): unknown {
  if (r() < 0.12 || depth > 8) return pick(r, HOSTILE);
  switch (n.k) {
    case 'string':
      return pick(r, ['', 'a', 'ab', 'abc', 'abcabc', ' ab ', 'xyz', '5', '0.5', 'a'.repeat(9)]);
    case 'number':
    case 'zint':
      return pick(r, [
        0,
        1,
        2,
        7,
        49,
        51,
        -3,
        0.5,
        2.5,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        2 ** 53 + 2,
        '5',
      ]);
    case 'bool':
      return r() < 0.8 ? r() < 0.5 : 'true';
    case 'literal':
      return r() < 0.7 ? 'a' : 'b';
    case 'enum':
      return pick(r, ['a', 'b', 'c']);
    case 'unknown':
      return pick(r, [1, 'u', { u: 1 }, [1, 2], null]);
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of n.shape) if (r() < 0.9) out[key] = sample(child, r, depth + 1);
      if (r() < 0.3) out[pick(r, ['x', 'b', 'c'])] = 'extra';
      return out;
    }
    case 'array': {
      const length = pick(r, [0, 1, 2, 3, 4, 6]);
      return Array.from({ length }, () => sample(n.el, r, depth + 1));
    }
    case 'intersection': {
      const left = sample(n.l, r, depth + 1);
      const right = sample(n.r, r, depth + 1);
      return left &&
        right &&
        typeof left === 'object' &&
        typeof right === 'object' &&
        !Array.isArray(left)
        ? { ...left, ...right }
        : r() < 0.5
          ? left
          : right;
    }
    case 'union':
      return sample(pick(r, n.options), r, depth + 1);
    case 'pipe':
      return sample(n.from.k === 'unknown' ? n.to : n.from, r, depth + 1);
    case 'preprocess': {
      const value = sample(n.inner, r, depth + 1);
      return n.f === 'number' && typeof value === 'number' && r() < 0.5 ? String(value) : value;
    }
    default:
      return 'inner' in n ? sample(n.inner, r, depth + 1) : undefined;
  }
}

export interface FuzzReport {
  schemas: number;
  cases: number;
  asyncCases: number;
  stock: { accepted: number; refused: number; threw: number };
  /** Inputs stock zod refused that the switched pass alone would have accepted (F3's class), each refused by legacyParse. */
  switchedAcceptedStockRefused: number;
  switchedThrew: number;
  /** The first 50; {@link FuzzReport.mismatchCount} counts all of them. */
  mismatches: { schema: number; input: string; what: string }[];
  mismatchCount: number;
}

export async function fuzz(
  ctx: Context,
  args: { seed: number; schemas: number; inputs: number },
): Promise<FuzzReport> {
  const report: FuzzReport = {
    schemas: 0,
    cases: 0,
    asyncCases: 0,
    stock: { accepted: 0, refused: 0, threw: 0 },
    switchedAcceptedStockRefused: 0,
    switchedThrew: 0,
    mismatches: [],
    mismatchCount: 0,
  };
  const r = rng(args.seed);
  let mismatches = 0;
  const miss = (schema: number, input: unknown, what: string) => {
    mismatches += 1;
    if (report.mismatches.length < 50)
      report.mismatches.push({ schema, input: canon(input), what });
  };
  for (let i = 0; i < args.schemas; i += 1) {
    const description = node(r, 0);
    const stockSchema = realize(ctx.stock, description);
    const schema = realize(ctx.patched, description);
    report.schemas += 1;
    for (let j = 0; j < args.inputs; j += 1) {
      const input = sample(description, r, 0);
      const before = canon(input);
      const stock = settle(() => stockSchema.safeParse(input));
      const plain = settle(() => schema.safeParse(input));
      const viaLegacy = legacy(ctx, schema, input);
      const switched = settle(() => schema.safeParse(input, SWITCHED as never));
      report.cases += 1;
      report.stock[stock.kind] += 1;
      if (canon(plain) !== canon(stock))
        miss(i, input, `plain ${canon(plain)} != stock ${canon(stock)}`);
      if (stock.kind === 'accepted') {
        if (viaLegacy.kind !== 'accepted' || viaLegacy.data !== stock.data) {
          miss(i, input, `legacyParse ${canon(viaLegacy)} != stock acceptance ${stock.data}`);
        }
      } else if (stock.kind === 'refused') {
        if (viaLegacy.kind !== 'refused' || viaLegacy.issues.length === 0) {
          miss(i, input, `legacyParse ${canon(viaLegacy)} where stock refused`);
        }
        if (switched.kind === 'accepted') report.switchedAcceptedStockRefused += 1;
        if (switched.kind === 'threw') report.switchedThrew += 1;
      } else if (viaLegacy.kind !== 'threw' || viaLegacy.message !== stock.message) {
        miss(i, input, `legacyParse ${canon(viaLegacy)} where stock threw ${stock.message}`);
      }
      if (j % 4 === 0) {
        report.asyncCases += 1;
        const stockAsync = await outcomeAsync(() => stockSchema.safeParseAsync(input));
        const plainAsync = await outcomeAsync(() => schema.safeParseAsync(input));
        if (canon(plainAsync) !== canon(stockAsync)) {
          miss(i, input, `plain async ${canon(plainAsync)} != stock async ${canon(stockAsync)}`);
        }
      }
      if (canon(input) !== before) miss(i, input, 'the input was mutated');
    }
  }
  report.mismatchCount = mismatches;
  return report;
}
