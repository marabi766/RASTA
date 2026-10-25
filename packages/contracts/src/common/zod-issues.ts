import { z } from 'zod';
import {
  enumOptions,
  literalValues,
  resolveZodPath,
  unwrapZodSchema,
  zodDef,
} from './zod-schema-walk';

/**
 * zod 3's issue vocabulary, kept on the wire after the move to zod 4
 * (GHSA-mrhx-c7xc-m3w5).
 *
 * Clients read `{ path, code, message }` per issue, Kafka refusals and audit
 * diagnostics record `path code`, and environment refusals print zod's wording;
 * all of it was written against zod 3. zod 4 renamed codes
 * (`invalid_enum_value` → `invalid_value`, `invalid_string` → `invalid_format`,
 * …), dropped fields (`received`) and reworded every default message. Every
 * place that turns a zod error into something a person or a log reads goes
 * through {@link legacyIssues}, so nothing outside this file knows zod 4's
 * vocabulary.
 *
 * A message is **zod's default** when it is exactly what zod's active locale
 * writes for the issue; that is decided here by asking the locale again, which
 * needs the value the issue was raised on — so a parse whose issues are
 * translated passes `{ reportInput: true }` ({@link LEGACY_PARSE}). A default
 * message is replaced by zod 3's default for the same issue; any other message
 * — one the schema wrote — is kept as written, and `zodDefault` says which.
 */

/** The codes zod 3 used. */
export type LegacyIssueCode =
  | 'invalid_type'
  | 'invalid_literal'
  | 'custom'
  | 'invalid_union'
  | 'invalid_union_discriminator'
  | 'invalid_enum_value'
  | 'unrecognized_keys'
  | 'invalid_arguments'
  | 'invalid_return_type'
  | 'invalid_date'
  | 'invalid_string'
  | 'too_small'
  | 'too_big'
  | 'invalid_intersection_types'
  | 'not_multiple_of'
  | 'not_finite';

/** zod 3's `ZodParsedType` names: what `received` and `expected` said. */
export const LEGACY_PARSED_TYPES: ReadonlySet<string> = new Set([
  'string',
  'nan',
  'number',
  'integer',
  'float',
  'boolean',
  'date',
  'bigint',
  'symbol',
  'function',
  'undefined',
  'null',
  'array',
  'object',
  'unknown',
  'promise',
  'void',
  'never',
  'map',
  'set',
]);

export type LegacyStringValidation =
  string | { includes: string; position?: number } | { startsWith: string } | { endsWith: string };

/** The size kinds zod 3 worded. */
export type LegacySizeType = 'array' | 'string' | 'number' | 'set' | 'date' | 'bigint' | 'unknown';

interface Base {
  /** The path as zod reported it (symbols, which JSON cannot carry, dropped). */
  path: (string | number)[];
  /** zod 3's default message for the issue, or the schema's own message. */
  message: string;
  /** Whether `message` is zod's default rather than text the schema wrote. */
  zodDefault: boolean;
}

/** An issue in zod 3's shape. */
export type LegacyIssue = Base &
  (
    | { code: 'invalid_type'; expected: string; received: string }
    | { code: 'invalid_literal'; expected: unknown; received: unknown }
    | { code: 'invalid_enum_value'; options: (string | number)[]; received: unknown }
    | { code: 'invalid_union_discriminator'; options: unknown[] }
    | { code: 'unrecognized_keys'; keys: string[] }
    | { code: 'invalid_string'; validation: LegacyStringValidation }
    | {
        code: 'too_small' | 'too_big';
        type: LegacySizeType;
        minimum?: number | bigint;
        maximum?: number | bigint;
        inclusive: boolean;
        exact: boolean;
      }
    | { code: 'not_multiple_of'; multipleOf: number | bigint }
    | {
        code:
          | 'custom'
          | 'invalid_union'
          | 'invalid_date'
          | 'not_finite'
          | 'invalid_arguments'
          | 'invalid_return_type'
          | 'invalid_intersection_types';
      }
  );

/** Parse options for a parse whose issues {@link legacyIssues} translates. */
export const LEGACY_PARSE = { reportInput: true } as const;

/** zod 3's `getParsedType`. */
export function legacyParsedType(data: unknown): string {
  switch (typeof data) {
    case 'undefined':
      return 'undefined';
    case 'string':
      return 'string';
    case 'number':
      return Number.isNaN(data) ? 'nan' : 'number';
    case 'boolean':
      return 'boolean';
    case 'function':
      return 'function';
    case 'bigint':
      return 'bigint';
    case 'symbol':
      return 'symbol';
    case 'object': {
      if (Array.isArray(data)) return 'array';
      if (data === null) return 'null';
      const thenable = data as { then?: unknown; catch?: unknown };
      if (typeof thenable.then === 'function' && typeof thenable.catch === 'function') {
        return 'promise';
      }
      if (data instanceof Map) return 'map';
      if (data instanceof Set) return 'set';
      if (data instanceof Date) return 'date';
      return 'object';
    }
    default:
      return 'unknown';
  }
}

/** zod 3's `util.joinValues`. */
export function joinLegacyValues(values: readonly unknown[], separator = ' | '): string {
  return values
    .map((value) => (typeof value === 'string' ? `'${value}'` : String(value)))
    .join(separator);
}

const bigintReplacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

/** zod 3's default English message for an issue (`locales/en.ts`). */
export function legacyDefaultMessage(issue: LegacyIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return issue.received === 'undefined'
        ? 'Required'
        : `Expected ${issue.expected}, received ${issue.received}`;
    case 'invalid_literal':
      return `Invalid literal value, expected ${JSON.stringify(issue.expected, bigintReplacer)}`;
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${joinLegacyValues(issue.keys, ', ')}`;
    case 'invalid_union':
      return 'Invalid input';
    case 'invalid_union_discriminator':
      return `Invalid discriminator value. Expected ${joinLegacyValues(issue.options)}`;
    case 'invalid_enum_value':
      return `Invalid enum value. Expected ${joinLegacyValues(issue.options)}, received '${String(issue.received)}'`;
    case 'invalid_arguments':
      return 'Invalid function arguments';
    case 'invalid_return_type':
      return 'Invalid function return type';
    case 'invalid_date':
      return 'Invalid date';
    case 'invalid_string': {
      const validation = issue.validation;
      if (typeof validation === 'object') {
        if ('includes' in validation) {
          const at =
            typeof validation.position === 'number'
              ? ` at one or more positions greater than or equal to ${validation.position}`
              : '';
          return `Invalid input: must include "${validation.includes}"${at}`;
        }
        if ('startsWith' in validation)
          return `Invalid input: must start with "${validation.startsWith}"`;
        return `Invalid input: must end with "${validation.endsWith}"`;
      }
      return validation === 'regex' ? 'Invalid' : `Invalid ${validation}`;
    }
    case 'too_small':
    case 'too_big':
      return legacySizeMessage(issue);
    case 'invalid_intersection_types':
      return 'Intersection results could not be merged';
    case 'not_multiple_of':
      return `Number must be a multiple of ${String(issue.multipleOf)}`;
    case 'not_finite':
      return 'Number must be finite';
    case 'custom':
    default:
      return 'Invalid input';
  }
}

function legacySizeMessage(issue: Extract<LegacyIssue, { code: 'too_small' | 'too_big' }>): string {
  const small = issue.code === 'too_small';
  const limit = small ? issue.minimum : issue.maximum;
  const pick = (exact: string, inclusive: string, strict: string) =>
    issue.exact ? exact : issue.inclusive ? inclusive : strict;
  switch (issue.type) {
    case 'array':
      return small
        ? `Array must contain ${pick('exactly', 'at least', 'more than')} ${String(limit)} element(s)`
        : `Array must contain ${pick('exactly', 'at most', 'less than')} ${String(limit)} element(s)`;
    case 'string':
      return small
        ? `String must contain ${pick('exactly', 'at least', 'over')} ${String(limit)} character(s)`
        : `String must contain ${pick('exactly', 'at most', 'under')} ${String(limit)} character(s)`;
    case 'number':
      return small
        ? `Number must be ${pick('exactly equal to ', 'greater than or equal to ', 'greater than ')}${String(limit)}`
        : `Number must be ${pick('exactly', 'less than or equal to', 'less than')} ${String(limit)}`;
    case 'bigint':
      return small
        ? `Number must be ${pick('exactly equal to ', 'greater than or equal to ', 'greater than ')}${String(limit)}`
        : `BigInt must be ${pick('exactly', 'less than or equal to', 'less than')} ${String(limit)}`;
    case 'date':
      return small
        ? `Date must be ${pick('exactly equal to ', 'greater than or equal to ', 'greater than ')}${new Date(Number(limit)).toString()}`
        : `Date must be ${pick('exactly', 'smaller than or equal to', 'smaller than')} ${new Date(Number(limit)).toString()}`;
    default:
      return 'Invalid input';
  }
}

/** zod 4's name for a string format → zod 3's `validation`. */
const FORMAT_VALIDATION: Record<string, string> = {
  ipv4: 'ip',
  ipv6: 'ip',
  cidrv4: 'cidr',
  cidrv6: 'cidr',
};

/** zod 4's size `origin` → zod 3's `type`. */
function sizeType(origin: unknown): LegacySizeType {
  switch (origin) {
    case 'array':
    case 'string':
    case 'number':
    case 'set':
    case 'date':
    case 'bigint':
      return origin;
    case 'int':
      return 'number';
    default:
      return 'unknown';
  }
}

type V4Issue = z.core.$ZodIssue & { input?: unknown };
/** A legacy issue before its message is chosen. */
type Translated = LegacyIssue extends infer I
  ? I extends LegacyIssue
    ? Omit<I, 'message' | 'zodDefault'>
    : never
  : never;
type Fields = Record<string, unknown>;

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let current = input;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

/** Whether zod 4's active locale writes exactly this message for the issue. */
function isZodDefault(issue: V4Issue): boolean {
  const locale = z.config().localeError;
  if (!locale) return issue.message === 'Invalid input';
  const written = locale(issue as unknown as z.core.$ZodRawIssue);
  const text = typeof written === 'string' ? written : written?.message;
  return issue.message === text;
}

/**
 * The issue, in zod 3's code and fields. `schema` decides what zod 4 no longer
 * says itself — whether an `invalid_value` came from a literal or an enum —
 * and `input` stands in for `issue.input` when the parse did not report it.
 */
function translate(
  issue: V4Issue,
  schema: z.ZodType | undefined,
  input: readonly [] | readonly [unknown],
  at: PropertyKey[],
): Translated | null {
  const path = at.filter((segment): segment is string | number => typeof segment !== 'symbol');
  const raw = issue as unknown as Fields;
  // The value the issue was raised on: reported by the parse, or read from the input given.
  const known = 'input' in issue || input.length > 0;
  const seen = 'input' in issue ? issue.input : valueAt(input[0], at);
  switch (issue.code) {
    case 'invalid_type': {
      if (issue.expected === 'int') {
        return { code: 'invalid_type', path, expected: 'integer', received: 'float' };
      }
      if (issue.expected === 'number' && typeof seen === 'number' && !Number.isNaN(seen)) {
        // zod 3's number took ±Infinity; only `.finite()` refused it.
        return { code: 'not_finite', path };
      }
      if (issue.expected === 'date' && seen instanceof Date) return { code: 'invalid_date', path };
      return {
        code: 'invalid_type',
        path,
        expected: issue.expected,
        // Without the value, zod 3's name for what it was is unknown.
        received: known ? legacyParsedType(seen) : 'unknown',
      };
    }
    case 'invalid_value': {
      const values = issue.values as readonly unknown[];
      // zod 3 refused a value outside an enum as invalid_enum_value, but a value
      // of another type as invalid_type; a literal checked the value alone.
      const enumIssue = (options: readonly (string | number)[]): Translated => {
        const numeric = options.some((option) => typeof option === 'number');
        const typed = !known || typeof seen === 'string' || (numeric && typeof seen === 'number');
        return typed
          ? { code: 'invalid_enum_value', path, options: [...options], received: seen }
          : {
              code: 'invalid_type',
              path,
              expected: joinLegacyValues(options),
              received: legacyParsedType(seen),
            };
      };
      if (!schema) {
        // No schema to ask: a literal refuses with its one value, an enum with its options.
        return values.length === 1
          ? { code: 'invalid_literal', path, expected: values[0], received: seen }
          : enumIssue(values as (string | number)[]);
      }
      for (const node of resolveZodPath(schema, at).nodes.flatMap(unwrapZodSchema)) {
        const literal = literalValues(node);
        if (literal && sameValues(literal, values)) {
          return { code: 'invalid_literal', path, expected: literal[0], received: seen };
        }
        const options = enumOptions(node);
        if (options && sameValues(options, values)) return enumIssue(options);
      }
      // Raised by a refinement, not by a literal or an enum the schema has here.
      return {
        code: 'invalid_enum_value',
        path,
        options: values as (string | number)[],
        received: seen,
      };
    }
    case 'invalid_format': {
      const format = String(raw.format);
      let validation: LegacyStringValidation;
      if (format === 'starts_with') validation = { startsWith: String(raw.prefix) };
      else if (format === 'ends_with') validation = { endsWith: String(raw.suffix) };
      else if (format === 'includes') validation = { includes: String(raw.includes) };
      else validation = FORMAT_VALIDATION[format] ?? format;
      return { code: 'invalid_string', path, validation };
    }
    case 'too_small':
    case 'too_big':
      return {
        code: issue.code,
        path,
        type: sizeType(issue.origin),
        ...(issue.code === 'too_small' ? { minimum: issue.minimum } : { maximum: issue.maximum }),
        inclusive: issue.inclusive ?? issue.exact === true,
        exact: issue.exact === true,
      };
    case 'not_multiple_of':
      return { code: 'not_multiple_of', path, multipleOf: issue.divisor };
    case 'unrecognized_keys':
      return { code: 'unrecognized_keys', path, keys: [...issue.keys] };
    case 'invalid_union':
      if (Array.isArray(raw.options) && raw.options.length > 0) {
        return {
          code: 'invalid_union_discriminator',
          path,
          options: [...(raw.options as unknown[])],
        };
      }
      return { code: 'invalid_union', path };
    case 'invalid_key':
    case 'invalid_element':
      // zod 3 reported the key's or element's own issue; handled by the caller.
      return null;
    case 'custom':
      return { code: 'custom', path };
    default:
      // A code neither zod knows (a forged or future one) is passed on as it
      // is; its readers check codes against their own closed sets.
      return { code: (issue as { code: string }).code as 'custom', path };
  }
}

function sameValues(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, at) => value === b[at]);
}

/**
 * The codes of the issues after which zod 3 kept parsing (a "dirty" result):
 * a check (a bound, a format, a refinement) and a strict object's unknown key.
 * A type, value or union refusal stopped it.
 */
const NON_FATAL_CODES = new Set([
  'too_small',
  'too_big',
  'invalid_format',
  'not_multiple_of',
  'custom',
  'unrecognized_keys',
]);

/**
 * What zod 3 reported for a union that zod 4 refused as `invalid_union`.
 *
 * zod 3 returned the issues of the **first** option that failed only on
 * checks (a regex, a bound, a refinement, an unknown key) and reported
 * `invalid_union` only when every option failed on its type. zod 4 reports
 * `invalid_union` unless exactly one option failed in a way it keeps parsing
 * after — so with two such options (a seed-or-ULID identifier given neither),
 * or with one whose array is over its cap (refused before its elements, which
 * zod 4 counts as stopping), the client saw that option's message under zod 3
 * and "Invalid input" under zod 4. The per-option issues travel on the zod 4
 * issue, so zod 3's answer is restored from them.
 */
function unionAsZod3Reported(issue: V4Issue): readonly z.core.$ZodIssue[] | undefined {
  if (issue.code !== 'invalid_union' || !Array.isArray(issue.errors)) return undefined;
  const checkOnly = issue.errors.filter(
    (option) => option.length > 0 && option.every((inner) => NON_FATAL_CODES.has(inner.code)),
  );
  return checkOnly[0];
}

/** The text an error map (a check's `error`, a schema's) gives for an issue, if any. */
function mappedMessage(map: unknown, issue: Record<string, unknown>): string | undefined {
  if (typeof map !== 'function') return undefined;
  const written: unknown = (map as (issue: unknown) => unknown)(issue);
  if (typeof written === 'string') return written;
  const message = (written as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' ? message : undefined;
}

/**
 * What zod 3 reported for ±Infinity where a number was expected.
 *
 * zod 3's `z.number()` took ±Infinity (only `.finite()` refused it) and ran
 * the number's checks on it: `.max(100)` refused it as `too_big` with the
 * schema's own message, `.int()` as a float. zod 4 refuses it as a type, so
 * the person read a generic sentence where they used to read the limit — and a
 * number reaches here from text (`Number('9'.repeat(400))`, `?limit=1e999`).
 * The number schema's checks are replayed on the value as zod 3 ran them, in
 * order, each with its own message; a number with none of them refused it only
 * through `.finite()` (a no-op in zod 4, leaving no trace), so that is
 * `not_finite`, which is also the answer without a schema.
 */
function infinityAsZod3Checked(
  issue: V4Issue,
  schema: z.ZodType | undefined,
  input: readonly [] | readonly [unknown],
  at: PropertyKey[],
): LegacyIssue[] | undefined {
  if (issue.code !== 'invalid_type' || issue.expected !== 'number' || !schema) return undefined;
  const value = 'input' in issue ? issue.input : input.length > 0 ? valueAt(input[0], at) : NaN;
  if (typeof value !== 'number' || Number.isNaN(value) || Number.isFinite(value)) return undefined;
  const node = resolveZodPath(schema, at)
    .nodes.flatMap(unwrapZodSchema)
    .find((candidate) => zodDef(candidate).type === 'number');
  if (!node) return undefined;
  const nodeDef = zodDef(node) as unknown as {
    checks?: { _zod: { def: Record<string, unknown> } }[];
    error?: unknown;
  };
  const path = at.filter((segment): segment is string | number => typeof segment !== 'symbol');
  const out: LegacyIssue[] = [];
  for (const check of nodeDef.checks ?? []) {
    const def = check._zod.def;
    const limit = def.value as number;
    let translated: Translated | undefined;
    if (def.check === 'greater_than' && !(def.inclusive ? value >= limit : value > limit)) {
      translated = {
        code: 'too_small',
        path,
        type: 'number',
        minimum: limit,
        inclusive: def.inclusive === true,
        exact: false,
      };
    } else if (def.check === 'less_than' && !(def.inclusive ? value <= limit : value < limit)) {
      translated = {
        code: 'too_big',
        path,
        type: 'number',
        maximum: limit,
        inclusive: def.inclusive === true,
        exact: false,
      };
    } else if (def.check === 'number_format' && String(def.format).includes('int')) {
      translated = { code: 'invalid_type', path, expected: 'integer', received: 'float' };
    } else if (def.check === 'multiple_of') {
      translated = { code: 'not_multiple_of', path, multipleOf: limit };
    }
    if (!translated) continue;
    const raw = { ...translated, input: value, origin: 'number', divisor: limit };
    const custom = mappedMessage(def.error, raw) ?? mappedMessage(nodeDef.error, raw);
    const legacy = { ...translated, message: '', zodDefault: custom === undefined } as LegacyIssue;
    legacy.message = custom ?? legacyDefaultMessage(legacy);
    out.push(legacy);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * zod 4 issues, in zod 3's vocabulary. `schema` is the schema that was parsed;
 * it decides whether an `invalid_value` came from a literal or an enum. A
 * caller that only prints codes and has no schema at hand (a dead-letter
 * reason) may leave it out: a one-value refusal then reads as a literal's, a
 * longer one as an enum's — exact for every enum of two options or more.
 * `input`, the value it was parsed from, is needed only when the parse did not
 * run with {@link LEGACY_PARSE}: it stands in for each issue's value (zod 3's
 * `received`, and whether an enum refused a value or a type). Without either,
 * an enum's refusal reads as `invalid_enum_value` whatever it was given. An
 * `invalid_key`/`invalid_element` wrapper is replaced by the issues it wraps,
 * at its path, as zod 3 reported them.
 */
export function legacyIssues(
  issues: readonly z.core.$ZodIssue[],
  schema?: z.ZodType,
  ...input: [] | [input: unknown]
): LegacyIssue[] {
  const out: LegacyIssue[] = [];
  const visit = (issue: V4Issue, prefix: PropertyKey[]): void => {
    const at = [...prefix, ...issue.path];
    if (issue.code === 'invalid_key' || issue.code === 'invalid_element') {
      for (const inner of issue.issues) visit(inner as V4Issue, at);
      return;
    }
    const reported = unionAsZod3Reported(issue);
    if (reported) {
      for (const inner of reported) visit(inner as V4Issue, at);
      return;
    }
    const replayed = infinityAsZod3Checked(issue, schema, input, at);
    if (replayed) {
      out.push(...replayed);
      return;
    }
    const translated = translate(issue, schema, input, at);
    if (!translated) return;
    const zodDefault = isZodDefault(issue);
    const legacy = { ...translated, message: '', zodDefault } as LegacyIssue;
    legacy.message = zodDefault ? legacyDefaultMessage(legacy) : issue.message;
    out.push(legacy);
  };
  for (const issue of issues) visit(issue as V4Issue, []);
  return out;
}
