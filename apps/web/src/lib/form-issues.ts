import {
  isSchemaAuthored,
  requireLegacyRefusal,
  UNSUPPORTED_CHARACTERS,
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
 * Rules, in order — by PROVENANCE, never by what a sentence says or which
 * script it is in (Codex PR-397 r2 F1, PR-439 r1 F1):
 *  1. A shared contract message (`@rasta/contracts`, English, a closed set
 *     matched by exact text) is shown as its Persian translation.
 *  2. A message the schema's author wrote (`isSchemaAuthored`: zod took it
 *     from the schema, PR #444 r5 F6) is shown as written only if the author
 *     also declared it a portal sentence with {@link formMessage}: a literal,
 *     or a template over the portal's own labels and bounds, never over the
 *     input. An authored message that is not declared — one built at parse
 *     time from what was typed (`MoneyInputError` used to quote the amount),
 *     English, or an echo of the value — is not shown.
 *  3. Otherwise a specific sentence from the issue's code and its bounds
 *     («حداکثر ۲۰۰ نویسه مجاز است»), which names the limit and never the input.
 *  4. Otherwise one generic sentence.
 *
 * Persian here follows standard orthography (checklist item 19, owner decision B).
 */

/** The fallback for an issue nothing above can describe. */
export const GENERIC_FIELD_MESSAGE = 'مقدار واردشده معتبر نیست';

/** Rule 1: the shared contract messages, by exact text (a `Map`: own keys only). */
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

/** Rule 2: every sentence an author declared with {@link formMessage}. */
const DECLARED = new Set<string>();

// Directional formatting and other invisible controls (ZWNJ, which Persian
// spelling needs, aside): a declared sentence never carries one.
const INVISIBLE_CONTROL = /(?!\u200c)\p{Cf}|\p{Cc}/u;

/**
 * Declares `text` a sentence the portal's author wrote for a form field, so
 * {@link formIssueMessage} may show it as written when a schema refuses with
 * it. The argument is a literal or a template over the portal's own labels and
 * bounds — never over the value being validated (`form-message-trust.spec.ts`
 * refuses any other argument). Returns `text` unchanged.
 */
export function formMessage(text: string): string {
  if (text === '' || INVISIBLE_CONTROL.test(text)) {
    throw new Error('formMessage: a declared sentence is non-empty and has no control characters');
  }
  DECLARED.add(text);
  return text;
}

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
  if (issue && isSchemaAuthored(issue)) {
    const shared = CONTRACT_MESSAGES.get(issue.message);
    if (shared !== undefined) return shared;
    if (DECLARED.has(issue.message)) return issue.message;
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
    // Own keys only, read and written: a field named `constructor` or
    // `toString` is not already answered by Object.prototype, and `__proto__`
    // is a field, not the prototype (PR-439 r1 addendum C).
    if (typeof field === 'string' && isField(field) && !Object.hasOwn(fieldErrors, field)) {
      Object.defineProperty(fieldErrors, field, {
        value: formIssueMessage(issue),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return fieldErrors;
}
