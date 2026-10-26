import { inspect } from 'node:util';

import { z } from 'zod';
import { legacyParse, type LegacyRefusal } from '@rasta/contracts';

import { firstIssuePerField, formIssueMessage } from '../lib/form-issues';
import { legacyFormResolver } from '../lib/form-resolver';

/**
 * PR #444 r5 F6: zod's default messages that repeat a value — the one
 * received, the schema's options, a literal, a prefix, an unknown key — in
 * Persian or Latin script, at the root, nested, in an array and under a
 * record key, at the top level and in a union's options. Run by
 * `form-masking.spec.ts` in Jest and, through `zod-builds.ts`, in both builds
 * of zod; it returns plain JSON so either run is judged the same way.
 *
 * Every place a form shows a message is collected: the resolver's errors
 * (first issue, and with `criteriaMode: 'all'` every `types` entry), their
 * JSON and inspection, `firstIssuePerField`, and each union's branch tree as
 * JSON and `util.inspect(showHidden)`.
 */

export type Script = 'fa' | 'latin';

/** Values a default message would repeat; none may reach a person. */
export const SENTINELS: Record<Script, Record<string, string>> = {
  fa: {
    received: 'محرمانه‌ورودی',
    optionA: 'گزینه‌پنهان‌یک',
    optionB: 'گزینه‌پنهان‌دو',
    literal: 'لیترال‌پنهان',
    prefix: 'پیشوند‌پنهان',
    suffix: 'پسوند‌پنهان',
    infix: 'میانوند‌پنهان',
    key: 'کلید‌پنهان',
  },
  latin: {
    received: 'SECRET-RECEIVED',
    optionA: 'SECRET-OPTION-A',
    optionB: 'SECRET-OPTION-B',
    literal: 'SECRET-LITERAL',
    prefix: 'SECRET-PREFIX',
    suffix: 'SECRET-SUFFIX',
    infix: 'SECRET-INFIX',
    key: 'SECRET-KEY',
  },
};

export const VARIANTS = [
  'enum received',
  'enum options in a type error',
  'literal expected',
  'strict object unknown key',
  'startsWith',
  'endsWith',
  'includes',
] as const;
export type Variant = (typeof VARIANTS)[number];

export const POSITIONS = ['root', 'nested', 'array', 'record'] as const;
export type Position = (typeof POSITIONS)[number];

export const CONTEXTS = ['field', 'union option', 'union in a union option'] as const;
export type Context = (typeof CONTEXTS)[number];

/** How a variant's schema is made to word its issue: zod's default, or an author's `error`. */
export type Wording =
  | { kind: 'default' }
  | { kind: 'static'; text: string }
  | { kind: 'dynamic' }
  | { kind: 'returns nothing' }
  | { kind: "zod's own text" };

/** The Persian sentence a dynamic author message is built from: it repeats the input. */
export const dynamicMessage = (input: unknown): string => `مقدار ${String(input)} پذیرفته نیست`;

function errorParam(wording: Wording): { error?: z.core.$ZodErrorMap } {
  switch (wording.kind) {
    case 'default':
      return {};
    case 'static':
      return { error: () => wording.text };
    case 'dynamic':
      return { error: (issue) => dynamicMessage(issue.input) };
    case 'returns nothing':
      return { error: () => undefined };
    case "zod's own text":
      // Exactly what the active locale writes: still zod's, not the author's.
      return {
        error: (issue) => {
          const written = z.config().localeError?.(issue);
          return typeof written === 'string' ? written : written?.message;
        },
      };
  }
}

/** The variant's schema and the value that fails it. */
function variant(
  which: Variant,
  params: Record<string, string>,
  received: Record<string, string>,
  wording: Wording,
): [z.ZodType, unknown] {
  const error = errorParam(wording);
  switch (which) {
    case 'enum received':
      return [z.enum([params.optionA!, params.optionB!], error), received.received];
    case 'enum options in a type error':
      return [z.enum([params.optionA!, params.optionB!], error), 7];
    case 'literal expected':
      return [z.literal(params.literal!, error), received.received];
    case 'strict object unknown key':
      return [
        z.strictObject({ ok: z.string() }, error),
        { ok: 'x', [params.key!]: received.received },
      ];
    case 'startsWith':
      return [z.string().startsWith(params.prefix!, error), received.received];
    case 'endsWith':
      return [z.string().endsWith(params.suffix!, error), received.received];
    case 'includes':
      return [z.string().includes(params.infix!, error), received.received];
  }
}

/** Where the variant sits, and the path of its own issue. */
function place(
  context: Context,
  position: Position,
  [inner, value]: [z.ZodType, unknown],
): { schema: z.ZodType; input: unknown; at: (string | number)[] } {
  let slot: z.ZodType = inner;
  let slotValue = value;
  let below: (string | number)[] = [];
  // Each option also fails on a type, so zod 3 refused the union as a whole
  // and its options reach the form through the branch tree.
  if (context !== 'field') {
    const option = (schema: z.ZodType, v: unknown, key: string) =>
      [z.object({ [key]: schema, n: z.number() }), { [key]: v, n: 'x' }] as const;
    const [first, firstValue] = option(slot, slotValue, 'a');
    slot = z.union([first, z.object({ b: z.number() })]);
    slotValue = { ...firstValue, b: 'x' };
    below = ['a'];
    if (context === 'union in a union option') {
      const [outer, outerValue] = option(slot, slotValue, 'c');
      slot = z.union([outer, z.object({ d: z.boolean() })]);
      slotValue = { ...outerValue, d: 'x' };
      below = ['c', 'a'];
    }
  }
  switch (position) {
    case 'root':
      return { schema: slot, input: slotValue, at: below };
    case 'nested':
      return {
        schema: z.object({ outer: z.object({ inner: slot }) }),
        input: { outer: { inner: slotValue } },
        at: ['outer', 'inner', ...below],
      };
    case 'array':
      return {
        schema: z.object({ items: z.array(slot) }),
        input: { items: [slotValue] },
        at: ['items', 0, ...below],
      };
    case 'record':
      // A record key is the form's own field name, shown in paths (addendum D).
      return {
        schema: z.object({ tags: z.record(z.string(), slot) }),
        input: { tags: { r1: slotValue } },
        at: ['tags', 'r1', ...below],
      };
  }
}

export interface MaskingCase {
  readonly variant: Variant;
  readonly position: Position;
  readonly context: Context;
  readonly params: Script;
  readonly received: Script;
  readonly wording: Wording['kind'];
  /** The path of the variant's own issue. */
  readonly at: string;
  /** The message the resolver shows there (first issue). */
  readonly shown: string | undefined;
  /** Every message the resolver, firstIssuePerField and the branch trees show. */
  readonly messages: string[];
  /** Every serialized form of them: errors and trees as JSON and inspection. */
  readonly texts: string[];
  /** Issues in the branch trees (0 when no union was refused as a whole). */
  readonly branchIssues: number;
  /** The variant's message in `criteriaMode: 'all'` and in its branch tree, as shown there. */
  readonly shownAll: string[];
  readonly shownInTree: string[];
}

const resolverOptions = { fields: {}, shouldUseNativeValidation: false } as const;

/** firstIssuePerField's guard: every first path segment is a field here. */
const anyField = (field: string): field is string => typeof field === 'string';

/** The messages of a react-hook-form error object, with each one's field name. */
function messagesOf(
  errors: unknown,
  prefix = '',
  out: [string, string][] = [],
): [string, string][] {
  if (!errors || typeof errors !== 'object') return out;
  for (const [key, value] of Object.entries(errors)) {
    if (!value || typeof value !== 'object' || key === 'ref') continue;
    if (key === 'types') {
      for (const each of Object.values(value)) {
        for (const message of ([] as unknown[]).concat(each))
          out.push([`${prefix}#types`, String(message)]);
      }
      continue;
    }
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof (value as { message?: unknown }).message === 'string') {
      out.push([name, (value as { message: string }).message]);
    }
    messagesOf(value, name, out);
  }
  return out;
}

interface TreeIssue {
  path: readonly (string | number)[];
  message: string;
  branches?: readonly (readonly TreeIssue[])[];
}

function flatten(
  tree: readonly (readonly TreeIssue[])[] | undefined,
  out: TreeIssue[] = [],
): TreeIssue[] {
  for (const option of tree ?? []) {
    for (const issue of option) {
      out.push(issue);
      flatten(issue.branches, out);
    }
  }
  return out;
}

/** One case, through every place a form shows a message. */
export async function runCase(
  which: Variant,
  position: Position,
  context: Context,
  params: Script,
  received: Script,
  wording: Wording,
): Promise<MaskingCase> {
  const { schema, input, at } = place(
    context,
    position,
    variant(which, SENTINELS[params], SENTINELS[received], wording),
  );
  const name = at.join('.');
  const resolver = legacyFormResolver(schema as never);
  const first = await resolver(input as never, undefined, resolverOptions as never);
  const all = await resolver(input as never, undefined, {
    ...resolverOptions,
    criteriaMode: 'all',
  } as never);
  const parsed = legacyParse(schema, input);
  if (parsed.success) throw new Error(`${which} ${position} ${context}: expected a refusal`);
  const refusal: LegacyRefusal = parsed.refusal;
  const fields = firstIssuePerField(refusal, anyField);
  const trees = refusal.issues.map((issue) => refusal.unionBranches(issue, formIssueMessage));
  const treeIssues = trees.flatMap((tree) => flatten(tree));

  const firstMessages = messagesOf(first.errors);
  const allMessages = messagesOf(all.errors);
  const at_ = (list: [string, string][], key: string) =>
    list.filter(([field]) => field === key || field === `${key}#types`).map(([, m]) => m);
  return {
    variant: which,
    position,
    context,
    params,
    received,
    wording: wording.kind,
    at: name,
    shown: firstMessages.find(([field]) => field === name)?.[1],
    messages: [
      ...firstMessages.map(([, m]) => m),
      ...allMessages.map(([, m]) => m),
      ...Object.values(fields).filter((message) => message !== undefined),
      ...treeIssues.map((issue) => issue.message),
    ],
    texts: [
      JSON.stringify(first.errors),
      JSON.stringify(all.errors),
      inspect(all.errors, { depth: null, showHidden: true }),
      JSON.stringify(fields),
      ...trees.map((tree) => JSON.stringify(tree) ?? ''),
      ...trees.map((tree) => inspect(tree, { depth: null, showHidden: true })),
    ],
    branchIssues: treeIssues.length,
    shownAll: at_(allMessages, name),
    shownInTree: treeIssues
      .filter((issue) => issue.path.join('.') === name)
      .map((issue) => issue.message),
  };
}

/** Every variant, position, context and script pairing, worded as `wording` says. */
export async function maskingMatrix(args: { wording?: Wording } = {}): Promise<MaskingCase[]> {
  const wording = args.wording ?? { kind: 'default' };
  const out: MaskingCase[] = [];
  for (const which of VARIANTS) {
    for (const position of POSITIONS) {
      for (const context of CONTEXTS) {
        for (const params of ['fa', 'latin'] as const) {
          for (const received of ['fa', 'latin'] as const) {
            out.push(await runCase(which, position, context, params, received, wording));
          }
        }
      }
    }
  }
  return out;
}

/**
 * A process-wide error map (`z.config({ customError })`) that repeats the
 * Persian value: not the schema's message either, though zod's locale never
 * wrote it. Restored afterwards.
 */
export async function globalErrorMapCase(): Promise<MaskingCase[]> {
  z.config({ customError: (issue) => `پیام سراسری ${String(issue.input)}` });
  try {
    const out: MaskingCase[] = [];
    for (const context of CONTEXTS) {
      out.push(
        await runCase('enum received', 'nested', context, 'latin', 'fa', { kind: 'default' }),
      );
    }
    return out;
  } finally {
    z.config({ customError: undefined });
  }
}

/**
 * A refusal legacyParse took from stock zod's pass (D-078 addendum B: the
 * zod 3-ordered pass accepted it, Codex PR-444 r3 F3's shape). That pass
 * marks nothing, so no message in it can be vouched for as the author's: the
 * author's Persian refinement message is masked too (fails closed).
 */
export async function stockFallbackCase(): Promise<{
  errors: [string, string][];
  fields: Partial<Record<string, string>>;
}> {
  const { schema, input } = stockFallbackSchema();
  const resolved = await legacyFormResolver(schema as never)(input as never, undefined, {
    ...resolverOptions,
    criteriaMode: 'all',
  } as never);
  const parsed = legacyParse(schema, input);
  if (parsed.success) throw new Error('expected a refusal');
  return {
    errors: messagesOf(resolved.errors),
    fields: firstIssuePerField(parsed.refusal, anyField),
  };
}

/** The author's message in {@link stockFallbackCase}. */
export const AUTHORED_IN_FALLBACK = 'این ترکیب پذیرفته نیست';

/** {@link stockFallbackCase}'s schema and input. */
export function stockFallbackSchema(): { schema: z.ZodType; input: unknown } {
  const left = z
    .object({ a: z.string() })
    .strict()
    .transform((value) => value)
    .refine(() => false, AUTHORED_IN_FALLBACK);
  return {
    schema: z.intersection(left, z.object({ b: z.string() })),
    input: { a: SENTINELS.fa.received, b: SENTINELS.fa.received },
  };
}
