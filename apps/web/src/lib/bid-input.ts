import { IRR, parseMoneyInput, toPersianDigits } from './format';
import {
  BID_ANSWER_MAX,
  BID_ANSWERS_MAX,
  BID_NOTE_MAX,
  NOTE_FIELD,
  PRICE_FIELD,
  answerField,
  criterionField,
} from './bid-fields';

/**
 * Reading a bid's form — client-safe, because the unconfirmed view re-sends
 * exactly what the first send carried, and the action reads the same form the
 * same way.
 *
 * What is read is `bid.dto.ts`'s `bidContentSchema`, as its DTO reads it: a
 * price in whole rials (a decimal string, never a number), an answer per
 * criterion, an optional note. Text is only **trimmed**, as the DTO trims it:
 * the content is sealed as sent and its commitment is over those bytes, so the
 * portal never rewrites a letter of it. Whether a criterion code is one the
 * tender has is the service's to say (`UNKNOWN_CRITERION`); which criteria
 * are answered is the bidder's to choose — the DTO requires none.
 *
 * The tender, the bid and the revision the page showed come from the signed
 * replay stamp, never from this form (`server/bid-replay.ts`).
 */

export interface BidAnswer {
  readonly criterionCode: string;
  readonly response: string;
}

/** `bidContentSchema`. */
export interface BidContent {
  /** Whole minor units (rials), a decimal string. */
  readonly priceMinor: string;
  readonly answers: readonly BidAnswer[];
  readonly note?: string;
}

/** One criterion row as typed: its code (hidden) and the answer. */
export interface AnswerValues {
  readonly criterionCode: string;
  readonly response: string;
}

export interface BidFormValues {
  readonly priceMinor: string;
  readonly note: string;
  readonly answers: readonly AnswerValues[];
}

export type BidFormErrors = Partial<Record<string, string>>;

export type ParsedBid =
  | {
      readonly ok: true;
      readonly content: BidContent;
      /** For each sent answer, the form row it came from — so a service path lands on its field. */
      readonly rows: readonly number[];
    }
  | { readonly ok: false; readonly fieldErrors: BidFormErrors };

/** The largest amount the DTO takes (`9223372036854775807`). */
const MAX_PRICE_MINOR = 9_223_372_036_854_775_807n;

export const BID_INPUT_MESSAGES = {
  price: 'مبلغ پیشنهاد را به ریال و به‌صورت عدد صحیح بنویسید.',
  answer: `هر پاسخ حداکثر ${toPersianDigits(String(BID_ANSWER_MAX))} نویسه است.`,
  note: `یادداشت حداکثر ${toPersianDigits(String(BID_NOTE_MAX))} نویسه است.`,
  criterion: 'معیاری که این پاسخ به آن داده شده خوانده نشد. صفحه را تازه کنید.',
} as const;

/** The typed fields of a bid form, as strings; rows past the last criterion are not read. */
export function bidFormValues(form: FormData): BidFormValues {
  const text = (name: string): string => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  const answers: AnswerValues[] = [];
  for (let row = 0; row < BID_ANSWERS_MAX; row += 1) {
    const code = form.get(criterionField(row));
    if (typeof code !== 'string') break;
    answers.push({ criterionCode: code, response: text(answerField(row)) });
  }
  return { priceMinor: text(PRICE_FIELD), note: text(NOTE_FIELD), answers };
}

/**
 * The content as the DTO reads it, or the errors to put on the form. A blank
 * answer is no answer: it is left out, not sent empty (the DTO refuses an
 * empty response).
 */
export function parseBid(values: BidFormValues): ParsedBid {
  const errors: BidFormErrors = {};

  let price: bigint | null;
  try {
    price = parseMoneyInput(values.priceMinor, IRR);
  } catch {
    price = null;
  }
  if (price === null || price < 0n || price > MAX_PRICE_MINOR) {
    errors[PRICE_FIELD] = BID_INPUT_MESSAGES.price;
    price = null;
  }

  const answers: BidAnswer[] = [];
  const rows: number[] = [];
  const seen = new Set<string>();
  values.answers.forEach((row, index) => {
    const response = row.response.trim();
    if (response.length === 0) return;
    const code = row.criterionCode.trim();
    if (code.length < 1 || code.length > 64 || seen.has(code)) {
      errors[answerField(index)] = BID_INPUT_MESSAGES.criterion;
      return;
    }
    if (response.length > BID_ANSWER_MAX) {
      errors[answerField(index)] = BID_INPUT_MESSAGES.answer;
      return;
    }
    seen.add(code);
    answers.push({ criterionCode: code, response });
    rows.push(index);
  });

  const note = values.note.trim();
  if (note.length > BID_NOTE_MAX) errors[NOTE_FIELD] = BID_INPUT_MESSAGES.note;

  if (Object.keys(errors).length > 0 || price === null) return { ok: false, fieldErrors: errors };
  return {
    ok: true,
    content: { priceMinor: price.toString(), answers, ...(note ? { note } : {}) },
    rows,
  };
}
