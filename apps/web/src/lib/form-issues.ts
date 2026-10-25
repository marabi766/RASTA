import { defaultErrorMap } from 'zod';
import type { z } from 'zod';

import { UNSUPPORTED_CHARACTERS } from '@rasta/contracts';

import { toNestErrors } from '@hookform/resolvers';
import type { FieldError } from 'react-hook-form';

import { toPersianDigits } from './format/digits';

/**
 * The one Persian boundary for the portal's own (local) validation.
 *
 * A form is parsed here with Zod before anything is sent, and a failed parse
 * puts a message in front of the person. Zod's own sentences are English and
 * can repeat the input («Invalid enum value … received 'x'»), so no parser may
 * copy `issue.message` into a form error: every one goes through
 * {@link formIssueMessage}, `firstIssuePerField` or {@link persianErrorMap}.
 * `form-issue-boundary.spec.ts` fails on any other reader of an issue's
 * message, so a new parser cannot reopen the class.
 *
 * The decision is by PROVENANCE, never by what the sentence says. Where a
 * message came from, in order:
 *  1. A shared contract message (the closed set in {@link CONTRACT_MESSAGES},
 *     exact text) is shown as its Persian translation.
 *  2. Zod's own default for that very issue — recomputed with Zod's default
 *     error map, so a default that echoes the input (Persian or not) is
 *     recognised as a default — is replaced by a sentence chosen from the
 *     issue's code and bounds, which names the limit and never the input.
 *     The text of a default is never inspected.
 *  3. A message the portal's own schema author wrote is static text. It is
 *     shown as written only if it is a Persian sentence ({@link isPersianSentence}:
 *     it holds an Arabic-script letter; digits, punctuation and a byte-order
 *     mark alone do not count). English text from anywhere else falls through.
 *  4. Otherwise a specific sentence from the issue's code, else one generic one.
 *
 * No hamza letters and no U+0654 in any sentence here (docs/16 text policy).
 */

/** The fallback for an issue nothing above can describe. */
export const GENERIC_FIELD_MESSAGE = 'مقدار واردشده معتبر نیست';

/**
 * Rule 3 only, for text the portal's own authors wrote: an Arabic-script LETTER
 * (`\p{L}`), not a digit, a punctuation mark, a mark or the byte-order mark,
 * all of which sit in the Arabic blocks too. Detection only, not an allow-list of
 * what may be typed (`display-text-sites.spec.ts` keeps
 * its one-definition rule for allow-lists).
 */
const ARABIC_SCRIPT_LETTER = /(?=\p{sc=Arab})\p{L}/u;

export function isPersianSentence(text: string): boolean {
  return ARABIC_SCRIPT_LETTER.test(text);
}

/** The shared contract messages (`@rasta/contracts`), by exact text. */
const CONTRACT_MESSAGES: ReadonlyMap<string, string> = new Map([
  [UNSUPPORTED_CHARACTERS, 'نویسه‌های واردشده مجاز نیست'],
  [
    'Amount must be a non-negative integer string in minor units',
    'مبلغ را به ریال و با ارقام درست بنویسید، بدون اعشار',
  ],
  [
    'Amount must be an integer string in minor units',
    'مبلغ را به ریال و با ارقام درست بنویسید، بدون اعشار',
  ],
]);

// A sentence no message can equal: Zod's map answers it for an issue code it has
// no default sentence for (`custom`), which is how a default is told from authored text.
const NO_DEFAULT = '\u0000no-default';

function isZodDefault(issue: z.ZodIssue): boolean {
  return (
    issue.message ===
    defaultErrorMap(issue as z.ZodIssueOptionalMessage, {
      defaultError: NO_DEFAULT,
      data: undefined,
    }).message
  );
}

const digits = (value: number | bigint): string => toPersianDigits(String(value));

function boundMessage(issue: z.ZodIssue): string | null {
  switch (issue.code) {
    case 'too_small': {
      if (issue.type === 'string') {
        return issue.minimum === 1 || issue.minimum === 1n
          ? 'این مقدار را وارد کنید'
          : `حداقل ${digits(issue.minimum as number | bigint)} نویسه لازم است`;
      }
      if (issue.type === 'array' || issue.type === 'set') {
        return `دست‌کم ${digits(issue.minimum as number | bigint)} مورد لازم است`;
      }
      if (issue.type === 'number' || issue.type === 'bigint') {
        return `مقدار نباید کمتر از ${digits(issue.minimum as number | bigint)} باشد`;
      }
      return null;
    }
    case 'too_big': {
      if (issue.type === 'string') {
        return `حداکثر ${digits(issue.maximum as number | bigint)} نویسه مجاز است`;
      }
      if (issue.type === 'array' || issue.type === 'set') {
        return `حداکثر ${digits(issue.maximum as number | bigint)} مورد مجاز است`;
      }
      if (issue.type === 'number' || issue.type === 'bigint') {
        return `مقدار نباید بیشتر از ${digits(issue.maximum as number | bigint)} باشد`;
      }
      return null;
    }
    case 'invalid_type':
      if (issue.received === 'undefined' || issue.received === 'null') {
        return 'این مقدار را وارد کنید';
      }
      return issue.expected === 'number' ||
        issue.expected === 'integer' ||
        issue.expected === 'bigint' ||
        issue.expected === 'nan'
        ? 'یک عدد صحیح و معتبر وارد کنید'
        : null;
    case 'not_finite':
    case 'not_multiple_of':
      return 'یک عدد صحیح و معتبر وارد کنید';
    case 'invalid_string':
      return 'نویسه‌های واردشده مجاز نیست';
    case 'invalid_enum_value':
    case 'invalid_literal':
    case 'invalid_union_discriminator':
      return 'یکی از گزینه‌های موجود را انتخاب کنید';
    default:
      return null;
  }
}

/** The text a person may read for one issue; never Zod's own English. */
export function formIssueMessage(issue: z.ZodIssue): string {
  const shared = CONTRACT_MESSAGES.get(issue.message);
  if (shared !== undefined) return shared;
  if (!isZodDefault(issue) && isPersianSentence(issue.message)) return issue.message;
  return boundMessage(issue) ?? GENERIC_FIELD_MESSAGE;
}

/**
 * The error map for resolvers that read Zod's messages themselves
 * (react-hook-form's Zod resolver, via its `errorMap` option). A message the schema wrote wins over
 * any map, so this only ever replaces Zod's defaults; {@link persianResolver}
 * normalises the rest.
 */
export const persianErrorMap: z.ZodErrorMap = (issue, ctx) => ({
  message: formIssueMessage({ ...issue, message: ctx.defaultError } as z.ZodIssue),
});

/**
 * The first issue per field of a failed parse, as Persian text. `accepts` is
 * the form's field list or a type guard; an issue whose first path segment is
 * not a field of the form (a numeric array index, an unknown key) is dropped.
 */
export function firstIssuePerField<F extends string>(
  error: z.ZodError,
  accepts: readonly F[] | ((value: string) => value is F),
): Partial<Record<F, string>> {
  const isField =
    typeof accepts === 'function'
      ? accepts
      : (value: string): value is F => (accepts as readonly string[]).includes(value);
  const fieldErrors: Partial<Record<F, string>> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && isField(field) && fieldErrors[field] === undefined) {
      fieldErrors[field] = formIssueMessage(issue);
    }
  }
  return fieldErrors;
}

/**
 * react-hook-form's resolver for a Zod schema, with every error message passed
 * through {@link formIssueMessage}: the schema's own messages (a contract's
 * English «Contains unsupported characters» included) are normalised too, which
 * an error map cannot do because a message the schema wrote bypasses the map.
 */
export function persianResolver<TOutput>(schema: z.ZodType<TOutput, z.ZodTypeDef, unknown>) {
  return async (
    values: unknown,
    _context: unknown,
    options: Parameters<typeof toNestErrors>[1],
  ) => {
    const result = await schema.safeParseAsync(values);
    if (result.success) return { values: result.data, errors: {} };
    const flat: Record<string, FieldError> = Object.create(null) as Record<string, FieldError>;
    for (const issue of result.error.issues) {
      const key = issue.path.join('.');
      if (flat[key] === undefined) {
        flat[key] = { type: issue.code, message: formIssueMessage(issue) };
      }
    }
    return { values: {}, errors: toNestErrors(flat, options) };
  };
}
