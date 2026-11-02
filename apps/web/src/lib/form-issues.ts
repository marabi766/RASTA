import {
  isSchemaAuthored,
  requireLegacyRefusal,
  type LegacyIssue,
  type LegacyRefusal,
} from '@rasta/contracts';

import { toPersianDigits } from './format/digits';

/**
 * The one Persian boundary for the portal's own (local) validation.
 *
 * A form is parsed here with Zod before anything is sent, and a failed parse
 * puts a message in front of the person. Zod's own sentences are English and
 * can repeat the input («Invalid enum value … received 'x'»), so no parser may
 * copy `issue.message` into a form error: every one goes through
 * {@link formIssueMessage}, `firstIssuePerField` or `legacyFormResolver`.
 * `form-issue-boundary.spec.ts` fails on any other reader of an issue's
 * message, so a new parser cannot reopen the class.
 *
 * Rules, in order:
 *  1. A message the schema's author wrote, in Persian, is shown as written —
 *     those are the specific, field-aware sentences («نام سازمان را وارد
 *     کنید»). Who wrote it is decided by where zod took the message from
 *     (`isSchemaAuthored`), never by what it says: a default of zod's that
 *     repeats a Persian value, option or key is zod's all the same (PR #444
 *     r5 F6), and an issue nobody can vouch for is not the author's. Of the
 *     author's, only one holding an Arabic-script letter passes; one written
 *     in English does not.
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
 * issue is in zod 3's vocabulary — the codes and bounds these sentences were
 * written against — as `legacyParse` translated it (for a form resolver too:
 * `legacyFormResolver`), with the schema that refused and the
 * value each issue was raised on, which is what tells a missing field from a
 * wrong one (PR #444 r1 F1).
 */
export function formIssueMessage(issue: LegacyIssue | undefined): string {
  if (issue && isSchemaAuthored(issue) && ARABIC_SCRIPT_LETTER.test(issue.message)) {
    return issue.message;
  }
  return (issue && boundMessage(issue)) ?? GENERIC_FIELD_MESSAGE;
}

/**
 * The first issue per field of a failed parse, as Persian text. `refusal` is
 * what `legacyParse(schema, values)` returned: it carries the schema that
 * refused (which tells a literal from an enum and holds the bounds zod 3
 * checked a non-finite number against) and each issue's value. `accepts` is
 * the form's field list or a type guard; an issue whose first path segment is
 * not a field of the form (a numeric array index, an unknown key) is dropped.
 */
export function firstIssuePerField<F extends string>(
  refusal: LegacyRefusal,
  accepts: readonly F[] | ((value: string) => value is F),
): Partial<Record<F, string>> {
  const { issues } = requireLegacyRefusal(refusal, 'firstIssuePerField');
  const isField =
    typeof accepts === 'function'
      ? accepts
      : (value: string): value is F => (accepts as readonly string[]).includes(value);
  const fieldErrors: Partial<Record<F, string>> = {};
  for (const issue of issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && isField(field) && fieldErrors[field] === undefined) {
      fieldErrors[field] = formIssueMessage(issue);
    }
  }
  return fieldErrors;
}
