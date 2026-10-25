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
 * through {@link legacyParse}, so nothing outside this file knows zod 4's
 * vocabulary.
 *
 * A message is **zod's default** when it is exactly what zod's active locale
 * writes for the issue; that is decided here by asking the locale again, which
 * needs the value the issue was raised on. A default message is replaced by
 * zod 3's default for the same issue; any other message — one the schema wrote
 * — is kept as written, and `zodDefault` says which.
 *
 * ## One operation: parse and translate ({@link legacyParse})
 *
 * The translation needs two things zod 4's issue alone does not carry: the
 * **schema** (whether an `invalid_value` came from a literal or an enum — a
 * one-value enum such as `currencySchema` looks exactly like a literal — and
 * which checks a non-finite number was refused before) and the **value each
 * issue was raised on** (a missing field from a wrong one; the number after a
 * `z.preprocess`/coerce, which the raw input no longer shows). PR #444 r1 F1
 * found callers that had neither, and wrote zod 4's guesses on the wire. So the
 * translation is no longer callable on its own: {@link legacyParse} parses with
 * the issue values reported and translates against the schema it parsed, in one
 * call, and returns a {@link LegacyRefusal}. Every formatter takes that refusal
 * and refuses anything else ({@link requireLegacyRefusal}). The zod 4 error,
 * which then carries the input on every issue, never leaves this file.
 *
 * ## Run order: zod 3's, from the patched zod
 *
 * zod 3 kept parsing after a failed check, so a refusal also held the
 * number's later checks and every enclosing refinement; zod 4 stops at some
 * failures zod 3 went on after (PR #444 r2 F1). The repository's patch of zod
 * (`patches/zod@4.6.7.patch`) restores zod 3's run order in the one zod every
 * workspace loads, so a refusal holds the issues zod 3's held and this file
 * only words them. Nothing is replayed, except for the single issue a form's
 * error map is asked about ({@link legacyIssueInErrorMap}).
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

/** Every issue carries the value it was raised on (read by the translation only). */
const LEGACY_PARSE = { reportInput: true } as const;

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

/** zod 4's `expected` for a type → zod 3's: a record was an object to zod 3, a tuple an array. */
const LEGACY_EXPECTED: Readonly<Record<string, string>> = { record: 'object', tuple: 'array' };

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
 * says itself — whether an `invalid_value` came from a literal or an enum.
 * The value the issue was raised on is on the issue: {@link legacyParse}
 * parses with it reported.
 */
function translate(issue: V4Issue, schema: z.ZodType, at: PropertyKey[]): Translated | null {
  const path = at.filter((segment): segment is string | number => typeof segment !== 'symbol');
  const raw = issue as unknown as Fields;
  // Always reported by legacyParse's parse; an error map's raw issue carries it too.
  const known = 'input' in issue;
  const seen = issue.input;
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
        expected: LEGACY_EXPECTED[issue.expected] ?? issue.expected,
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
 * Whether zod 3 kept parsing after the issue. Besides {@link NON_FATAL_CODES},
 * two `invalid_type`s were checks in zod 3, and keep parsing here too (the
 * `patches/zod@4.6.7.patch` of this repository): a failed `.int()`, and ±Infinity
 * where a number was expected, which zod 3's number took and ran its checks on.
 */
function keptParsing(issue: V4Issue): boolean {
  return NON_FATAL_CODES.has(issue.code) || integerRefused(issue) || nonFiniteNumber(issue);
}

/** A failed `.int()`: zod 3's `invalid_type` "Expected integer, received float". */
function integerRefused(issue: V4Issue): boolean {
  return issue.code === 'invalid_type' && issue.expected === 'int';
}

/**
 * zod 4's own refusal of an integer beyond ±(2^53 − 1) (r1 Deviation 4): a
 * bound zod 3's `.int()` did not have, raised before the schema's own checks.
 */
function unsafeInteger(issue: V4Issue): boolean {
  return (
    (issue.code === 'too_big' || issue.code === 'too_small') &&
    issue.origin === 'int' &&
    (issue.code === 'too_big'
      ? issue.maximum === Number.MAX_SAFE_INTEGER
      : issue.minimum === Number.MIN_SAFE_INTEGER)
  );
}

/** ±Infinity where a number was expected. */
function nonFiniteNumber(issue: V4Issue): boolean {
  return (
    issue.code === 'invalid_type' &&
    issue.expected === 'number' &&
    typeof issue.input === 'number' &&
    !Number.isNaN(issue.input) &&
    !Number.isFinite(issue.input)
  );
}

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
    (option) => option.length > 0 && option.every((inner) => keptParsing(inner as V4Issue)),
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
 * What zod 3 reported for ±Infinity where a number was expected, for an error
 * map, which sees one issue at a time.
 *
 * zod 3's `z.number()` took ±Infinity (only `.finite()` refused it) and ran
 * the number's checks on it: `.max(100)` refused it as `too_big` with the
 * schema's own message, `.int()` as a float. zod 4 refuses it as a type — and a
 * number reaches here from text (`Number('9'.repeat(400))`, `?limit=1e999`).
 * The patched zod (`patches/zod@4.6.7.patch`) keeps parsing after that type
 * issue, so the number's checks raise their own issues after it, and a whole
 * refusal drops the type issue ({@link translateIssues}). A form's error map,
 * though, is asked for the type issue's text on its own, and the field shows
 * the first issue's text: that is the first failing check, replayed on the
 * value as zod 3 ran it, with its own message; a number with none of them
 * refused it only through `.finite()` (a no-op in zod 4, leaving no trace), so
 * that is `not_finite`.
 *
 * The value is the one the number schema saw — after a `z.preprocess` or a
 * coercion turned `"1e999"` into `Infinity` — which only the issue itself
 * reports; the raw input at that path is still the text.
 */
function infinityAsZod3Checked(
  issue: V4Issue,
  schema: z.ZodType,
  at: PropertyKey[],
): LegacyIssue[] | undefined {
  if (!nonFiniteNumber(issue)) return undefined;
  const value = issue.input as number;
  const checks = numberChecksAt(schema, at);
  if (!checks) return undefined;
  const out = replayNumberChecks(checks.list, checks.nodeDef, value, at);
  return out.length > 0 ? out : undefined;
}

type NumberCheck = { _zod: { def: Record<string, unknown> } };
type NumberDef = { checks?: NumberCheck[]; error?: unknown };

/** The checks of the number schema at `at`, in declaration order. */
function numberChecksAt(
  schema: z.ZodType,
  at: PropertyKey[],
): { list: NumberCheck[]; nodeDef: NumberDef } | undefined {
  const node = resolveZodPath(schema, at)
    .nodes.flatMap(unwrapZodSchema)
    .find((candidate) => zodDef(candidate).type === 'number');
  if (!node) return undefined;
  const nodeDef = zodDef(node) as unknown as NumberDef;
  return { list: nodeDef.checks ?? [], nodeDef };
}

/** Each of `checks` run on `value` as zod 3 ran it: every failure, in order, with its own message. */
function replayNumberChecks(
  checks: readonly NumberCheck[],
  nodeDef: NumberDef,
  value: number,
  at: PropertyKey[],
): LegacyIssue[] {
  const path = at.filter((segment): segment is string | number => typeof segment !== 'symbol');
  const out: LegacyIssue[] = [];
  for (const check of checks) {
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
    } else if (
      def.check === 'number_format' &&
      String(def.format).includes('int') &&
      !Number.isInteger(value)
    ) {
      translated = { code: 'invalid_type', path, expected: 'integer', received: 'float' };
    } else if (def.check === 'multiple_of' && floatSafeRemainder(value, limit) !== 0) {
      translated = { code: 'not_multiple_of', path, multipleOf: limit };
    }
    if (!translated) continue;
    const raw = { ...translated, input: value, origin: 'number', divisor: limit };
    const custom = mappedMessage(def.error, raw) ?? mappedMessage(nodeDef.error, raw);
    const legacy = { ...translated, message: '', zodDefault: custom === undefined } as LegacyIssue;
    legacy.message = custom ?? legacyDefaultMessage(legacy);
    out.push(legacy);
  }
  return out;
}

/** zod 3's `floatSafeRemainder`, which its `multipleOf` compared with 0 (`NaN` for ±Infinity). */
function floatSafeRemainder(value: number, step: number): number {
  const decimals = (n: number) => (n.toString().split('.')[1] ?? '').length;
  const places = Math.max(decimals(value), decimals(step));
  const whole = (n: number) => parseInt(n.toFixed(places).replace('.', ''), 10);
  return (whole(value) % whole(step)) / 10 ** places;
}

/**
 * zod 4 issues, in zod 3's vocabulary, against the schema that raised them.
 * An `invalid_key`/`invalid_element` wrapper is replaced by the issues it
 * wraps, at its path, as zod 3 reported them. Module-private: the only way to
 * it is {@link legacyParse} (or {@link legacyIssueInErrorMap}), which always
 * have the schema and the issue values.
 *
 * A failed `.int()` and ±Infinity as a number keep the parse going (the
 * patched zod): the number's later checks and every enclosing refinement raise
 * their own issues, as in zod 3, so nothing is replayed here. zod 3 raised no
 * type issue for ±Infinity: when the number's own checks refused it, they are
 * what zod 3 reported, and the type issue is dropped; when none did, zod 3
 * refused it only through `.finite()`, so it is `not_finite`. Likewise zod 4's
 * safe-integer bound (r1 Deviation 4) is dropped where the schema's own bound
 * refused the same integer, and kept where only it did.
 */
function translateIssues(issues: readonly z.core.$ZodIssue[], schema: z.ZodType): LegacyIssue[] {
  const out: LegacyIssue[] = [];
  const visit = (issue: V4Issue, prefix: PropertyKey[], siblings: readonly V4Issue[]): void => {
    const at = [...prefix, ...issue.path];
    if (issue.code === 'invalid_key' || issue.code === 'invalid_element') {
      const inner = issue.issues as V4Issue[];
      for (const each of inner) visit(each, at, inner);
      return;
    }
    const reported = unionAsZod3Reported(issue);
    if (reported) {
      const inner = reported as V4Issue[];
      for (const each of inner) visit(each, at, inner);
      return;
    }
    // zod 3 raised neither: when the number's own checks refused the value too,
    // those are what it reported.
    if ((nonFiniteNumber(issue) || unsafeInteger(issue)) && checkedAfter(issue, siblings)) return;
    const translated = translate(issue, schema, at);
    if (!translated) return;
    const zodDefault = isZodDefault(issue);
    const legacy = { ...translated, message: '', zodDefault } as LegacyIssue;
    legacy.message = zodDefault ? legacyDefaultMessage(legacy) : issue.message;
    out.push(legacy);
  };
  const top = issues as readonly V4Issue[];
  for (const issue of top) visit(issue, [], top);
  return out;
}

/** Whether a later issue of the same parse was raised at the same path on the same number: the number's own check. */
function checkedAfter(issue: V4Issue, siblings: readonly V4Issue[]): boolean {
  const from = siblings.indexOf(issue);
  return siblings
    .slice(from + 1)
    .some((later) => Object.is(later.input, issue.input) && samePath(later.path, issue.path));
}

function samePath(a: readonly PropertyKey[], b: readonly PropertyKey[]): boolean {
  return a.length === b.length && a.every((segment, at) => segment === b[at]);
}

/** Marks a {@link LegacyRefusal} across copies of this package (a registry symbol, not `instanceof`). */
const LEGACY_REFUSAL = Symbol.for('@rasta/contracts/LegacyRefusal');

/** Lets only {@link legacyParse} construct a {@link LegacyRefusal}. */
const ISSUED = Symbol('LegacyRefusal.issued');

/**
 * A refused parse, in zod 3's vocabulary — what every formatter of a zod
 * refusal takes (HTTP details, dead-letter reasons, audit diagnostics,
 * environment refusals, form messages). Only {@link legacyParse} makes one, so
 * holding one proves the issues were translated against the schema that was
 * parsed and with the values they were raised on.
 *
 * `issues` is the only own enumerable field. The schema and the input are
 * private (a formatter that needs them — the HTTP pipe's path walk and echo
 * backstop — reads them through the accessors), and `toJSON` and
 * `util.inspect` show paths and codes only, so a refusal that reaches a log
 * whole repeats nothing the caller sent.
 */
export class LegacyRefusal {
  readonly issues: readonly LegacyIssue[];
  readonly #schema: z.ZodType;
  readonly #input: unknown;

  constructor(
    token: typeof ISSUED,
    issues: readonly LegacyIssue[],
    schema: z.ZodType,
    input: unknown,
  ) {
    if (token !== ISSUED) throw new LegacyContextError('LegacyRefusal');
    this.issues = issues;
    this.#schema = schema;
    this.#input = input;
    Object.defineProperty(this, LEGACY_REFUSAL, { value: true });
    Object.freeze(this);
  }

  /** The schema that was parsed. */
  get schema(): z.ZodType {
    return this.#schema;
  }

  /** The value that was parsed, as given (before any transform). */
  get input(): unknown {
    return this.#input;
  }

  toJSON(): { issues: { path: (string | number)[]; code: string }[] } {
    return { issues: this.issues.map(({ path, code }) => ({ path, code })) };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `LegacyRefusal ${JSON.stringify(this.toJSON())}`;
  }
}

/**
 * A formatter of zod refusals was handed something {@link legacyParse} did not
 * produce — a bare `ZodError`, its `issues`, a hand-built object. Refused
 * rather than guessed at: without the schema and the issue values the
 * translation can only guess (PR #444 r1 F1). Fixed text: never the value.
 */
export class LegacyContextError extends TypeError {
  constructor(formatter: string) {
    super(
      `${formatter} needs a refusal from legacyParse (the schema and the parse that raised it), ` +
        'not a bare zod error or its issues',
    );
    this.name = 'LegacyContextError';
  }
}

/** Whether `value` is a {@link LegacyRefusal}, from this copy of the package or another. */
export function isLegacyRefusal(value: unknown): value is LegacyRefusal {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[LEGACY_REFUSAL] === true
  );
}

/**
 * `value` as a {@link LegacyRefusal}, or a {@link LegacyContextError} naming
 * `formatter`. Every formatter calls this first, so a caller that reaches it
 * with a bare zod error (through `as never`, plain JavaScript or a stale
 * build) fails loudly instead of printing zod 4's guesses.
 */
export function requireLegacyRefusal(value: unknown, formatter: string): LegacyRefusal {
  if (!isLegacyRefusal(value)) throw new LegacyContextError(formatter);
  return value;
}

/** What {@link legacyParse} returns. */
export type LegacyParseResult<T> =
  | { readonly success: true; readonly data: T; readonly refusal?: undefined }
  | { readonly success: false; readonly data?: undefined; readonly refusal: LegacyRefusal };

/**
 * Parses `input` with `schema` and, when it is refused, translates the refusal
 * into zod 3's vocabulary against that same schema, with every issue's value
 * reported — one operation, so no caller can translate without the schema or
 * the values (PR #444 r1 F1).
 *
 * Acceptance is exactly `schema.safeParse(input)`'s: the options only make zod
 * keep each issue's value. Nothing is parsed a second time, so a size check
 * that refused an array before its elements (GHSA-mrhx-c7xc-m3w5) still means
 * no element and no refinement over the elements ran. The zod 4 error, whose
 * issues now carry those values, is not returned: only the translated
 * refusal is.
 */
export function legacyParse<S extends z.ZodType>(
  schema: S,
  input: unknown,
): LegacyParseResult<z.output<S>> {
  const result = schema.safeParse(input, LEGACY_PARSE);
  if (result.success) return { success: true, data: result.data };
  const issues = translateIssues(result.error.issues, schema);
  return { success: false, refusal: new LegacyRefusal(ISSUED, issues, schema, input) };
}

/**
 * One issue as an error map receives it, in zod 3's vocabulary — for the web
 * forms' error map, which react-hook-form's resolver calls during its own
 * parse. A raw issue there still carries the schema (or check) that raised it
 * and the value it was raised on, so the context is the issue's own; a check
 * stands in no schema, and needs none (it never raises an `invalid_value` or a
 * non-finite number).
 */
export function legacyIssueInErrorMap(raw: z.core.$ZodRawIssue): LegacyIssue | undefined {
  const inst = (raw as { inst?: unknown }).inst;
  const schema =
    typeof inst === 'object' && inst !== null && typeof zodDef(inst as z.ZodType).type === 'string'
      ? (inst as z.ZodType)
      : NO_SCHEMA;
  const finished = { ...raw, path: [], message: '' } as unknown as z.core.$ZodIssue;
  return infinityAsZod3Checked(finished, schema, [])?.[0] ?? translateIssues([finished], schema)[0];
}

const NO_SCHEMA: z.ZodType = z.never();

/**
 * A refusal as one line — `path code` per issue, zod 3's codes, with the
 * schema's own message in parentheses where it wrote one (a refinement's
 * fixed sentence: "fromStatus is null exactly when …"), at most `limit` named
 * and the rest counted — for a service's publish-time check of its own event
 * payloads. zod's default messages are left out: some repeat the value
 * received. zod 3's `ZodError.message` there was its whole issue list as JSON,
 * received values included (S-09); zod 4's is its own vocabulary.
 */
export function describeLegacyRefusal(refusal: LegacyRefusal, limit = 10): string {
  const { issues } = requireLegacyRefusal(refusal, 'describeLegacyRefusal');
  const named = issues
    .slice(0, limit)
    .map((issue) => {
      const where = `${issue.path.join('.') || '(root)'} ${issue.code}`;
      return issue.zodDefault ? where : `${where} (${issue.message})`;
    })
    .join(', ');
  return issues.length > limit ? `${named}, …(${issues.length} total)` : named;
}
