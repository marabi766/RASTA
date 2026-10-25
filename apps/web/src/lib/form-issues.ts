import type { z } from 'zod';
import { legacyIssues, type LegacyIssue } from '@rasta/contracts';

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
 * Rules, in order:
 *  1. A message the schema's author wrote in Persian (it holds an Arabic-script
 *     letter) is shown as written — those are the specific, field-aware
 *     sentences («نام سازمان را وارد کنید»). Zod's defaults and a message
 *     written in English hold none and never pass.
 *  2. Otherwise a specific sentence from the issue's code and its bounds
 *     («حداکثر ۲۰۰ نویسه مجاز است»), which names the limit and never the input.
 *  3. Otherwise one generic sentence.
 *
 * No hamza letters and no U+0654 in any sentence here (docs/16 text policy).
 */

/** The fallback for an issue nothing above can describe. */
export const GENERIC_FIELD_MESSAGE = 'مقدار واردشده معتبر نیست';

// Detection only (is this sentence Persian?), not an allow-list of what may be typed:
// the Arabic blocks, so `display-text-sites.spec.ts` keeps its one-definition rule.
const ARABIC_SCRIPT_LETTER = /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/;

const digits = (value: number | bigint): string => toPersianDigits(String(value));

function boundMessage(issue: LegacyIssue): string | null {
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

/**
 * The text a person may read for one issue; never Zod's own English. The
 * issue is read in zod 3's vocabulary ({@link legacyIssues}) — the codes and
 * bounds these sentences were written against; a missing field is told from a
 * wrong one by the value the issue was raised on, which a parse reports when
 * it runs with `LEGACY_PARSE` (every form parser here does).
 */
export function formIssueMessage(issue: z.core.$ZodIssue, schema?: z.ZodType): string {
  const [legacy] = legacyIssues([issue], schema);
  const message = legacy?.message ?? issue.message;
  if (ARABIC_SCRIPT_LETTER.test(message)) return message;
  return (legacy && boundMessage(legacy)) ?? GENERIC_FIELD_MESSAGE;
}

/**
 * The error map for resolvers that read Zod's messages themselves
 * (react-hook-form's Zod resolver, via its `error` option). A message the schema wrote wins over
 * any map, so this only ever replaces Zod's defaults. The issue reaches a map
 * before it is finished: it still carries the schema that raised it, which
 * tells a literal from an enum, and the value it was raised on.
 */
export const persianErrorMap: z.core.$ZodErrorMap = (issue) => {
  const raw = issue as z.core.$ZodRawIssue & { inst?: z.ZodType };
  const finished = { ...raw, path: [], message: '' } as unknown as z.core.$ZodIssue;
  return formIssueMessage(finished, raw.inst);
};

/**
 * The first issue per field of a failed parse, as Persian text. `accepts` is
 * the form's field list or a type guard; an issue whose first path segment is
 * not a field of the form (a numeric array index, an unknown key) is dropped.
 * `schema` is the schema parsed (with `LEGACY_PARSE`): it tells a literal from
 * an enum and holds the bounds zod 3 checked a non-finite number against.
 */
export function firstIssuePerField<F extends string>(
  error: z.ZodError,
  accepts: readonly F[] | ((value: string) => value is F),
  schema: z.ZodType,
): Partial<Record<F, string>> {
  const isField =
    typeof accepts === 'function'
      ? accepts
      : (value: string): value is F => (accepts as readonly string[]).includes(value);
  const fieldErrors: Partial<Record<F, string>> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && isField(field) && fieldErrors[field] === undefined) {
      fieldErrors[field] = formIssueMessage(issue, schema);
    }
  }
  return fieldErrors;
}
