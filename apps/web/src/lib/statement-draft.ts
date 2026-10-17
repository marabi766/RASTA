import { IRR, normalizePersianText, parseMoneyInput } from './format';
import {
  FORM_LINE_ROWS,
  LINE_DESCRIPTION_MAX,
  lineField,
  type StatementLineValues,
} from './statement-fields';

/**
 * Reading the draft form — client-safe, because the form remembers exactly
 * what it is about to send before it sends it (`lib/unresolved-statement.ts`),
 * and the action reads the same form the same way. One reader for both, so the
 * remembered lines and the sent lines cannot differ.
 */

/** One parsed line, as contract-service's `draftStatementSchema` takes it. */
export interface StatementLineRequest {
  readonly description: string;
  /** Minor units (rials), a positive decimal string — never a number. */
  readonly amountMinor: string;
  readonly milestoneId?: string;
}

export type DraftFormErrors = Partial<Record<string, string>>;

export type ParsedDraft =
  | {
      readonly ok: true;
      readonly lines: readonly StatementLineRequest[];
      /** The form row each line came from, for placing the service's field errors. */
      readonly rows: readonly number[];
    }
  | { readonly ok: false; readonly fieldErrors: DraftFormErrors; readonly message: string | null };

/** What `plainText()` refuses in a description (`@rasta/contracts`, `WITHOUT_BIDI_CONTROL`). */
const BIDI_CONTROL = /\p{Bidi_Control}/u;

/** The largest amount a `BIGINT` stores (`MAX_AMOUNT_MINOR`). */
const MAX_AMOUNT_MINOR = 9_223_372_036_854_775_807n;

export const DRAFT_MESSAGES = {
  noLine: 'دست‌کم یک ردیف با شرح و مبلغ لازم است.',
  description: 'شرح کار لازم است و حداکثر ۵۰۰ نویسه.',
  characters: 'شرح کار نویسه‌های کنترلی جهت‌نما نمی‌پذیرد.',
  amount: 'مبلغ را به ریال و به‌صورت عدد صحیح مثبت بنویسید.',
  milestone: 'این Milestone از Milestoneهای این قرارداد نیست.',
} as const;

/** The draft form's rows as typed, in order, empty rows included. */
export function draftFormLines(form: FormData): StatementLineValues[] {
  return Array.from({ length: FORM_LINE_ROWS }, (_, index) => {
    const text = (part: keyof StatementLineValues): string => {
      const value = form.get(lineField(index, part));
      return typeof value === 'string' ? value : '';
    };
    return {
      description: text('description'),
      amount: text('amount'),
      milestoneId: text('milestoneId'),
    };
  });
}

/** Lines as they were sent, back as form rows — the unconfirmed view re-sends these. */
export function rowsOfLines(lines: readonly StatementLineRequest[]): StatementLineValues[] {
  return lines.map((line) => ({
    description: line.description,
    amount: line.amountMinor,
    milestoneId: line.milestoneId ?? '',
  }));
}

/**
 * The draft form, read as the service's `draftStatementSchema` reads it: the
 * rows that hold anything, in order, each with a description (trimmed, 1 to
 * 500, no bidi control) and a positive whole amount in rials — typed in any
 * digits, read by `parseMoneyInput`, sent as a decimal string. A milestone is
 * one of `milestoneIds` (the contract's own), when the caller knows them, or
 * none; with `null` the service alone checks it (`MILESTONE_NOT_OF_CONTRACT`).
 *
 * Deductions are not offered: no route lists or writes the employer's
 * deduction rules (Q-125), so a draft from this portal applies none.
 */
export function parseDraft(
  values: readonly StatementLineValues[],
  milestoneIds: readonly string[] | null,
): ParsedDraft {
  const fieldErrors: DraftFormErrors = {};
  const lines: StatementLineRequest[] = [];
  const rows: number[] = [];
  values.forEach((row, index) => {
    const description = normalizePersianText(row.description).trim();
    const amount = row.amount.trim();
    const milestoneId = row.milestoneId.trim();
    if (description === '' && amount === '' && milestoneId === '') return;

    let valid = true;
    if (description.length === 0 || description.length > LINE_DESCRIPTION_MAX) {
      fieldErrors[lineField(index, 'description')] = DRAFT_MESSAGES.description;
      valid = false;
    } else if (BIDI_CONTROL.test(description)) {
      fieldErrors[lineField(index, 'description')] = DRAFT_MESSAGES.characters;
      valid = false;
    }
    let minor: bigint | null;
    try {
      minor = parseMoneyInput(amount, IRR);
    } catch {
      minor = null;
    }
    if (minor === null || minor <= 0n || minor > MAX_AMOUNT_MINOR) {
      fieldErrors[lineField(index, 'amount')] = DRAFT_MESSAGES.amount;
      valid = false;
    }
    if (milestoneId !== '' && milestoneIds !== null && !milestoneIds.includes(milestoneId)) {
      fieldErrors[lineField(index, 'milestoneId')] = DRAFT_MESSAGES.milestone;
      valid = false;
    }
    if (!valid || minor === null) return;
    lines.push({
      description,
      amountMinor: minor.toString(),
      ...(milestoneId !== '' ? { milestoneId } : {}),
    });
    rows.push(index);
  });
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors, message: null };
  if (lines.length === 0) return { ok: false, fieldErrors, message: DRAFT_MESSAGES.noLine };
  return { ok: true, lines, rows };
}
