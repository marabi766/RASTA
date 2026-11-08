import { z } from 'zod';
import { enumOptions, literalValues, resolveZodPath, unwrapZodSchema } from './zod-schema-walk';

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
 * — is kept as written, and `zodDefault` says which. That is a comparison of
 * texts, for the wording; whether a consumer may show a message as the
 * schema's own is decided by where zod took it from ({@link isSchemaAuthored},
 * PR #444 r5 F6).
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
 * ## Run order: zod 3's, from the patched zod, for diagnostics only
 *
 * zod 3 kept parsing after a failed check, so a refusal also held the
 * number's later checks and every enclosing refinement; zod 4 stops at some
 * failures zod 3 went on after (PR #444 r2 F1). The repository's patch of zod
 * (`patches/zod@4.6.7.patch`) restores zod 3's run order behind a per-parse
 * switch that is off by default (D-078): every parse is stock zod 4.6.7, and
 * {@link legacyParse} turns it on only for a second pass over input stock zod
 * already refused, to collect the issues zod 3's refusal held. This file only
 * words them; nothing is replayed.
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

/**
 * zod's switch for zod 3's run order (`patches/zod@<version>.patch`, D-078):
 * a registered symbol, so no JSON, spread of request data or misspelt option
 * can set it, and the dual CommonJS/ESM builds of zod read the same key. zod
 * copies a parse's params into the context every nested schema, async step,
 * pipe, union, intersection and lazy runs with, so it reaches all of them and
 * no parse that does not pass it (one started inside a refinement included).
 * `zod-compat-patch.spec` refuses any other source that names it.
 */
const LEGACY_RUN_ORDER = Symbol.for('@rasta/zod.legacyRunOrder');

/** Stock zod 4: every issue carries the value it was raised on (read by the translation only). */
const STOCK_PARSE = { reportInput: true } as const;

/**
 * zod's per-parse error map, called only where zod is about to word an issue
 * itself: after the issue brought no message of its own and neither the check
 * nor the schema that raised it supplied one (`finalizeIssue`). It writes no
 * message (it returns nothing, so zod's own wording follows exactly as without
 * it); it marks the issue, and zod copies the mark onto the issue it reports
 * (PR #444 r5 F6). Every `finalizeIssue` call of either build of zod passes
 * the parse's context (`zod-authorship.spec`).
 */
const ZOD_WORDED_KEY = '~legacyZodWorded';
const ZOD_WORDED: object = Object.freeze({});
function markZodWorded(issue: unknown): undefined {
  (issue as Record<string, unknown>)[ZOD_WORDED_KEY] = ZOD_WORDED;
  return undefined;
}

/**
 * The same, in zod 3's run order: diagnostics only, after {@link STOCK_PARSE}
 * refused. It also marks every issue zod words itself, which is how the
 * translation tells a message the schema wrote ({@link isSchemaAuthored}).
 */
const LEGACY_ORDER_PARSE = {
  reportInput: true,
  [LEGACY_RUN_ORDER]: true,
  error: markZodWorded,
} as const;

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

/**
 * Messages the schema itself supplied (PR #444 r5 F6): a check's or schema's
 * own `error`/`message`, or the message a refinement added the issue with —
 * known by where zod took it from, never by what it says. Only an issue of
 * the zod 3-ordered pass can be in here: that pass marks every issue zod
 * words itself ({@link markZodWorded}), and an issue it did not mark, whose
 * message is not the active locale's text either, got its message from the
 * schema. An issue of stock zod's pass (the fallback), the generic issue, an
 * author's function that returned nothing or zod's own text, a copy of an
 * issue: not in here, so not authored. Read only through
 * {@link isSchemaAuthored}.
 */
const SCHEMA_AUTHORED = new WeakSet<LegacyIssue>();

/**
 * Whether `issue` (one of a refusal's issues, or of its union options) holds
 * a message the schema supplied, rather than zod's wording — which repeats
 * the value received, the options and the keys. `false` for anything this
 * package cannot vouch for. A consumer that may show an author's message
 * (the portal's `formIssueMessage`) asks this first.
 */
export function isSchemaAuthored(issue: LegacyIssue): boolean {
  return SCHEMA_AUTHORED.has(issue);
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
 * says itself — whether an `invalid_value` came from a literal or an enum.
 * The value the issue was raised on is on the issue: {@link legacyParse}
 * parses with it reported.
 */
function translate(issue: V4Issue, schema: z.ZodType, at: PropertyKey[]): Translated | null {
  const path = at.filter((segment): segment is string | number => typeof segment !== 'symbol');
  const raw = issue as unknown as Fields;
  // Always reported by legacyParse's parses.
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

/**
 * zod 4 issues, in zod 3's vocabulary, against the schema that raised them.
 * An `invalid_key`/`invalid_element` wrapper is replaced by the issues it
 * wraps, at its path, as zod 3 reported them. Module-private: the only way to
 * it is {@link legacyParse}, which always has the schema and the issue
 * values.
 *
 * In the second, zod 3-ordered pass a failed `.int()` and ±Infinity as a
 * number keep the parse going (the patched zod, switched on): the number's later checks and every enclosing refinement raise
 * their own issues, as in zod 3, so nothing is replayed here. zod 3 raised no
 * type issue for ±Infinity: when the number's own checks refused it, they are
 * what zod 3 reported, and the type issue is dropped; when none did, zod 3
 * refused it only through `.finite()`, so it is `not_finite`. Likewise zod 4's
 * safe-integer bound (r1 Deviation 4) is dropped where the schema's own bound
 * refused the same integer, and kept where only it did.
 *
 * `marked`: the issues come from the zod 3-ordered pass, which marks what zod
 * words itself, so an unmarked message may be the schema's
 * ({@link SCHEMA_AUTHORED}); otherwise none is.
 */
function translateIssues(
  issues: readonly z.core.$ZodIssue[],
  schema: z.ZodType,
  prefix: readonly PropertyKey[] = [],
  marked = false,
): LegacyIssue[] {
  const out: LegacyIssue[] = [];
  const visit = (
    issue: V4Issue,
    prefix: readonly PropertyKey[],
    siblings: readonly V4Issue[],
  ): void => {
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
    if (
      marked &&
      !zodDefault &&
      (issue as unknown as Fields)[ZOD_WORDED_KEY] !== ZOD_WORDED &&
      typeof issue.message === 'string' &&
      issue.message !== ''
    ) {
      SCHEMA_AUTHORED.add(legacy);
    }
    if (legacy.code === 'invalid_union') keepBranches(legacy, issue, schema, at, marked);
    out.push(legacy);
  };
  const top = issues as readonly V4Issue[];
  for (const issue of top) visit(issue, prefix, top);
  return out;
}

/**
 * The options of each union refusal a translation produced, translated the
 * same way at the union's path (PR #444 r4 F5) — what zod 3 carried as
 * `unionErrors` and a form resolver routes to the option's own fields. Kept
 * beside the issue, never on it: every other formatter reads `issues` and
 * sees exactly what it saw before. Read only through
 * {@link LegacyRefusal.unionBranches}.
 */
const UNION_BRANCHES = new WeakMap<LegacyIssue, readonly (readonly LegacyIssue[])[]>();

function keepBranches(
  legacy: LegacyIssue,
  issue: V4Issue,
  schema: z.ZodType,
  at: PropertyKey[],
  marked: boolean,
) {
  if (issue.code !== 'invalid_union' || !Array.isArray(issue.errors) || issue.errors.length === 0) {
    return;
  }
  try {
    UNION_BRANCHES.set(
      legacy,
      issue.errors.map((option) => translateIssues(option, schema, at, marked)),
    );
  } catch {
    // An option that cannot be worded leaves the union's own issue, as before.
  }
}

/**
 * One issue of a refused union option, as a consumer may show it: where, which
 * code, and the consumer's own wording of it — nothing else (no option list,
 * no value received, no key the input chose beyond its place in the path).
 */
export interface LegacyUnionBranchIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
  /** The options of a union refused inside this option, the same way. */
  readonly branches?: readonly (readonly LegacyUnionBranchIssue[])[];
}

function branchTree(
  issue: LegacyIssue,
  word: (issue: LegacyIssue) => string,
): readonly (readonly LegacyUnionBranchIssue[])[] | undefined {
  return UNION_BRANCHES.get(issue)?.map((option) =>
    Object.freeze(
      option.map((branch) => {
        const branches = branchTree(branch, word);
        return Object.freeze({
          path: Object.freeze([...branch.path]) as readonly (string | number)[],
          code: branch.code,
          message: word(branch),
          ...(branches ? { branches } : {}),
        });
      }),
    ),
  );
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

  /**
   * The options of the union refused at `issue` (one of {@link issues}), each
   * option's issues at their full paths, with nested unions the same way
   * (PR #444 r4 F5) — or `undefined` when `issue` is not such a union of this
   * refusal. `word` is the consumer's own wording, the one it gives the
   * refusal's issues (the form's `formIssueMessage`), so an option's issue is
   * masked exactly as a top-level one; the tree carries path, code and that
   * wording only.
   */
  unionBranches(
    issue: LegacyIssue,
    word: (issue: LegacyIssue) => string,
  ): readonly (readonly LegacyUnionBranchIssue[])[] | undefined {
    return this.issues.includes(issue) ? branchTree(issue, word) : undefined;
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
 * Acceptance and the value returned are stock zod 4's (D-078): the first pass
 * is a plain `safeParse`, and when it succeeds that is the answer. Only when
 * it refused does a second pass run in zod 3's order
 * ({@link LEGACY_ORDER_PARSE}), and only for its issues: whatever it does, the
 * answer stays a refusal ({@link refusalIssues}). A size check that refused an
 * array before its elements (GHSA-mrhx-c7xc-m3w5) refuses it the same way in
 * both passes, so no element is parsed in either. The zod 4 errors are not
 * returned: only the translated refusal is.
 *
 * A first pass that throws is a refusal with {@link genericLegacyIssue}, never
 * an acceptance or the error's text (addendum C) — except zod's own
 * `$ZodAsyncError`: like stock `safeParse`, this synchronous parse refuses a
 * schema with an async step by throwing it. {@link legacyParseAsync} is the
 * same rule, awaited.
 */
export function legacyParse<S extends z.ZodType>(
  schema: S,
  input: unknown,
): LegacyParseResult<z.output<S>> {
  const rule = legacyParseRule(schema, input);
  let step = rule.next();
  while (!step.done) {
    let outcome: PassOutcome;
    try {
      outcome = { threw: false, result: schema.safeParse(input, PASSES[step.value]) };
    } catch (error) {
      if (step.value === 'stock' && isZodAsyncError(error)) throw error;
      outcome = { threw: true, error };
    }
    step = rule.next(outcome);
  }
  return step.value;
}

/**
 * {@link legacyParse}, awaited (PR #444 r4 F4): the same rule, so a schema with
 * an async refinement, check, transform or preprocess is decided by stock
 * `safeParseAsync`, and its success is returned unchanged; only after a
 * refusal is the zod 3-ordered pass awaited, for the wording. A first pass
 * that rejects is a refusal with {@link genericLegacyIssue}.
 */
export async function legacyParseAsync<S extends z.ZodType>(
  schema: S,
  input: unknown,
): Promise<LegacyParseResult<z.output<S>>> {
  const rule = legacyParseRule(schema, input);
  let step = rule.next();
  while (!step.done) {
    let outcome: PassOutcome;
    try {
      outcome = { threw: false, result: await schema.safeParseAsync(input, PASSES[step.value]) };
    } catch (error) {
      outcome = { threw: true, error };
    }
    step = rule.next(outcome);
  }
  return step.value;
}

/** legacyParse's two passes, and what each parses with. */
const PASSES = { stock: STOCK_PARSE, ordered: LEGACY_ORDER_PARSE } as const;
type Pass = keyof typeof PASSES;

/** What a pass gave: its result, or what it threw. */
type PassOutcome =
  | { readonly threw: false; readonly result: z.ZodSafeParseResult<unknown> }
  | { readonly threw: true; readonly error: unknown };

/**
 * D-078, once for both {@link legacyParse} and {@link legacyParseAsync}: it
 * asks for a pass (yields which) and is handed what the pass gave, so the
 * synchronous and the awaited parse cannot decide differently.
 */
function* legacyParseRule<S extends z.ZodType>(
  schema: S,
  input: unknown,
): Generator<Pass, LegacyParseResult<z.output<S>>, PassOutcome> {
  const stock = yield 'stock';
  if (stock.threw) {
    return refused([genericLegacyIssue()], schema, input);
  }
  const first = stock.result;
  if (first.success) return { success: true, data: first.data as z.output<S> };
  const ordered = yield 'ordered';
  const issues = refusalIssues(
    () => {
      if (ordered.threw) throw ordered.error;
      return ordered.result;
    },
    () => first.error.issues,
    schema,
  );
  return refused(issues, schema, input);
}

function refused<T>(
  issues: readonly LegacyIssue[],
  schema: z.ZodType,
  input: unknown,
): LegacyParseResult<T> {
  return { success: false, refusal: new LegacyRefusal(ISSUED, issues, schema, input) };
}

/** zod's "Encountered Promise during synchronous parse", from either build of zod. */
const ZOD_ASYNC_MESSAGE = new z.core.$ZodAsyncError().message;

function isZodAsyncError(error: unknown): boolean {
  return (
    error instanceof z.core.$ZodAsyncError ||
    (error instanceof Error && error.message === ZOD_ASYNC_MESSAGE)
  );
}

/** What a refusal says when neither pass's issues could be translated: fixed text, no value. */
export function genericLegacyIssue(): LegacyIssue {
  return { code: 'custom', path: [], message: 'Invalid input', zodDefault: true };
}

/**
 * The issues of an input stock zod refused, failing closed (D-078, addendum
 * B): zod 3's order when the second pass refuses too and translates to at
 * least one issue; otherwise — it accepted (another combinator reconciled
 * what it raised), threw, or translated to nothing — stock zod's own issues,
 * translated; and when those cannot be translated either, one fixed generic
 * issue. Never an acceptance, never a raw zod error. Exported for its tests
 * only (`wrap` decorates the translation there); not in the index.
 *
 * @internal
 */
export function refusalIssues(
  ordered: () => z.ZodSafeParseResult<unknown>,
  stockIssues: () => readonly z.core.$ZodIssue[],
  schema: z.ZodType,
  wrap: (translate: typeof translateIssues) => typeof translateIssues = (translate) => translate,
): readonly LegacyIssue[] {
  const translator = wrap(translateIssues);
  try {
    const second = ordered();
    if (!second.success) {
      // The ordered pass marks what zod words itself (LEGACY_ORDER_PARSE).
      const issues = translator(second.error.issues, schema, [], true);
      if (issues.length > 0) return issues;
    }
  } catch {
    // The diagnostic pass is not the answer; stock zod's refusal is.
  }
  try {
    // Unmarked: no message of stock zod's pass counts as the schema's.
    const issues = translator(stockIssues(), schema);
    if (issues.length > 0) return issues;
  } catch {
    // Below: a fixed refusal.
  }
  return [genericLegacyIssue()];
}

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
