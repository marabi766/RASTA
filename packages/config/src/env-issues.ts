import { z } from 'zod';
import { enumOptions, resolveEnvPath, unwrapEnvSchema } from './env-schema';

/** One refused setting, as `EnvValidationError` lists it. */
export type EnvIssue = { path: string; message: string };

/**
 * What an issue path prints in place of a segment the schema does not own: a
 * key a record or an object did not declare is text the operator wrote, and
 * may be a secret pasted into the wrong place.
 */
export const ENV_PATH_PLACEHOLDER = '(key not in schema)';

/**
 * The single formatter of environment refusals (S-09, #385 r2 F2).
 *
 * An issue becomes `{ path, message }` from the **issue code and the schema
 * alone**, never from the value written:
 *
 * - `message` is the issue's own text only when that text is in `fixedMessages`,
 *   the audited list of fixed texts a schema refuses with (equality, not a
 *   pattern). Any other message — Zod's built-in ones, which copy the received
 *   value into an enum refusal, and any custom or dynamic one — is replaced by
 *   a fixed text for its code, built from schema-side facts only: an enum's
 *   options as the schema declares them, a size's bound, a type's name.
 * - `path` prints a segment only when the schema owns it ({@link resolveEnvPath}):
 *   a key an object declares, an index in a list. Anything else — a record's
 *   key, a key the schema does not declare — prints as
 *   {@link ENV_PATH_PLACEHOLDER}.
 *
 * Every place that formats environment issues goes through this — `loadEnv`,
 * and through it each service's loader; a service never maps `issue.message`
 * itself.
 */
export function envIssues(
  issues: readonly z.ZodIssue[],
  schema: z.ZodTypeAny,
  fixedMessages: ReadonlySet<string>,
): EnvIssue[] {
  return issues.map((issue) => {
    const { nodes, segments } = resolveEnvPath(schema, issue.path);
    const leaves = nodes.flatMap(unwrapEnvSchema);
    const path = segments.map((segment) => segment ?? ENV_PATH_PLACEHOLDER).join('.') || '(root)';
    const message = fixedMessages.has(issue.message) ? issue.message : byCode(issue, leaves);
    return { path, message };
  });
}

/** A number Zod put in an issue, printed only when it is one. */
function bound(value: unknown): string | undefined {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

const PARSED_TYPES = new Set<string>(Object.values(z.ZodParsedType));

/**
 * The fixed text for an issue's code, in Zod's own wording where Zod's says
 * nothing about the input, and without the part that does where it does.
 */
function byCode(issue: z.ZodIssue, leaves: readonly z.ZodTypeAny[]): string {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === z.ZodParsedType.undefined) return 'Required';
      return PARSED_TYPES.has(issue.expected) ? `Expected ${issue.expected}` : 'Invalid type';
    case z.ZodIssueCode.invalid_enum_value: {
      // The options of the enum the schema has at this path, not the ones the issue carries.
      const declared = leaves
        .map(enumOptions)
        .find(
          (options) =>
            options !== undefined &&
            options.length === issue.options.length &&
            options.every((option, at) => option === issue.options[at]),
        );
      return declared
        ? `Invalid enum value. Expected ${declared.map((option) => `'${option}'`).join(' | ')}`
        : 'Invalid enum value';
    }
    case z.ZodIssueCode.too_small:
    case z.ZodIssueCode.too_big:
      return sizeMessage(issue);
    case z.ZodIssueCode.invalid_string:
      if (typeof issue.validation === 'object') return 'Invalid input: not in the expected form';
      return issue.validation === 'regex' ? 'Invalid' : `Invalid ${issue.validation}`;
    case z.ZodIssueCode.not_multiple_of: {
      const step = bound(issue.multipleOf);
      return step === undefined ? 'Invalid number' : `Number must be a multiple of ${step}`;
    }
    case z.ZodIssueCode.not_finite:
      return 'Number must be finite';
    case z.ZodIssueCode.invalid_literal:
      return 'Invalid literal value';
    case z.ZodIssueCode.unrecognized_keys:
      return `Unrecognized key(s) in object: ${issue.keys.length}`;
    case z.ZodIssueCode.invalid_union:
      return 'Invalid input';
    case z.ZodIssueCode.invalid_union_discriminator:
      return 'Invalid discriminator value';
    case z.ZodIssueCode.invalid_date:
      return 'Invalid date';
    case z.ZodIssueCode.invalid_intersection_types:
      return 'Intersection results could not be merged';
    case z.ZodIssueCode.invalid_arguments:
      return 'Invalid function arguments';
    case z.ZodIssueCode.invalid_return_type:
      return 'Invalid function return type';
    case z.ZodIssueCode.custom:
    default:
      return 'Invalid input';
  }
}

/** Zod's size wording, from the bound the schema declared. */
function sizeMessage(issue: z.ZodTooSmallIssue | z.ZodTooBigIssue): string {
  const small = issue.code === z.ZodIssueCode.too_small;
  const limit = bound(
    small ? (issue as z.ZodTooSmallIssue).minimum : (issue as z.ZodTooBigIssue).maximum,
  );
  if (limit === undefined) return 'Invalid input';
  const relation = (exact: string, inclusive: string, strict: string) =>
    issue.exact ? exact : issue.inclusive ? inclusive : strict;
  switch (issue.type) {
    case 'array':
    case 'set':
      return small
        ? `Array must contain ${relation('exactly', 'at least', 'more than')} ${limit} element(s)`
        : `Array must contain ${relation('exactly', 'at most', 'less than')} ${limit} element(s)`;
    case 'string':
      return small
        ? `String must contain ${relation('exactly', 'at least', 'over')} ${limit} character(s)`
        : `String must contain ${relation('exactly', 'at most', 'under')} ${limit} character(s)`;
    case 'number':
    case 'bigint':
      return small
        ? `Number must be ${relation('exactly equal to', 'greater than or equal to', 'greater than')} ${limit}`
        : `Number must be ${relation('exactly', 'less than or equal to', 'less than')} ${limit}`;
    case 'date': {
      const at = new Date(Number(limit)).toISOString();
      return small
        ? `Date must be ${relation('exactly equal to', 'greater than or equal to', 'greater than')} ${at}`
        : `Date must be ${relation('exactly', 'smaller than or equal to', 'smaller than')} ${at}`;
    }
    default:
      return 'Invalid input';
  }
}

/**
 * The fixed texts one service's schema refuses with, collected where the
 * schema is built and then sealed.
 *
 * `fixed(text)` records a text and returns it, so a message stays where it is
 * written; it is called while the module builds its schema, never while one
 * parses — so a message that would carry the value received (`Unknown role:
 * ${entry}`) cannot be recorded: `seal()` freezes the list once the schema
 * exists, and `fixed` refuses to record anything after that. The service
 * exports the sealed list and hands it to `loadEnv` (`fixedMessages`).
 */
export function fixedEnvMessages(): {
  fixed: (text: string) => string;
  seal: () => readonly string[];
} {
  const texts: string[] = [];
  let sealed: readonly string[] | undefined;
  return {
    fixed: (text) => {
      if (sealed) {
        throw new Error(
          'A fixed environment message is recorded only while the schema is built, before seal()',
        );
      }
      texts.push(text);
      return text;
    },
    seal: () => {
      sealed ??= Object.freeze([...new Set(texts)]);
      return sealed;
    },
  };
}
