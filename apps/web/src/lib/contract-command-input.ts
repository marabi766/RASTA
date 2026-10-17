import { BIDI_CONTROL, IRR, normalizePersianText, parseMoneyInput, toLatinDigits } from './format';
import {
  AMENDMENT_REASON_MAX,
  CANCEL_NOTE_MAX,
  CONTRACT_FIELDS,
  MILESTONE_TITLE_MAX,
  PLANNED_SHARE_BP_MAX,
  type ContractCommand,
  type ContractField,
} from './contract-command-fields';

/**
 * Reading the contract command forms — client-safe, because a form remembers
 * exactly what it is about to send before it sends it
 * (`lib/unresolved-contract-command.ts`), and the action reads the same form
 * the same way. One reader for both, so the remembered body and the sent body
 * cannot differ.
 *
 * Only what a person types is read here. What a command acts on — the
 * contract, the amendment, the milestone, the version the page showed, the
 * side signed for — comes from the replay stamp the page signed, never from
 * the posted form (`server/contract-command-replay.ts`).
 */

/** `POST …/cancel`, less `expectedVersion`. */
export interface CancelInput {
  readonly reasonCode: string;
  readonly note?: string;
}

/** `POST …/amendments`, less `expectedVersion`. */
export interface AmendmentInput {
  /** Minor units (rials), a positive decimal string — never a number. */
  readonly deltaMinor: string;
  readonly reasonCode: string;
  readonly reasonText: string;
}

/**
 * `POST …/milestones` and `PATCH …/milestones/{id}`, less `expectedVersion`.
 * `plannedShareBp: null` is no share: left out of a plan, sent as `null` in a
 * change, which clears it.
 */
export interface MilestoneInput {
  readonly title: string;
  /** A calendar day, `YYYY-MM-DD` — never an instant. */
  readonly plannedDate: string;
  readonly plannedShareBp: number | null;
}

/** What a command's form adds to its body; null for the two signatures, which type nothing. */
export type CommandInput = CancelInput | AmendmentInput | MilestoneInput | null;

/** The fields of each command's form, in the order they are drawn. */
export const COMMAND_FIELDS: Readonly<Record<ContractCommand, readonly ContractField[]>> = {
  SIGN: [],
  CANCEL: ['reasonCode', 'note'],
  PROPOSE_AMENDMENT: ['deltaMinor', 'reasonCode', 'reasonText'],
  SIGN_AMENDMENT: [],
  PLAN_MILESTONE: ['title', 'plannedDate', 'plannedShareBp'],
  CHANGE_MILESTONE: ['title', 'plannedDate', 'plannedShareBp'],
};

export type ContractFormValues = Partial<Record<ContractField, string>>;
export type ContractFormErrors = Partial<Record<ContractField, string>>;

export type ParsedInput =
  | { readonly ok: true; readonly input: CommandInput }
  | {
      readonly ok: false;
      readonly fieldErrors: ContractFormErrors;
      readonly message: string | null;
    };

/** The largest amount a `BIGINT` stores (`MAX_AMOUNT_MINOR`). */
const MAX_AMOUNT_MINOR = 9_223_372_036_854_775_807n;

/** A closed code, as the DTOs take it. */
const REASON_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export const INPUT_MESSAGES = {
  reasonCode: 'یکی از دلیل‌ها را انتخاب کنید.',
  note: 'یادداشت حداکثر ۱۰۰۰ نویسه است.',
  deltaMinor: 'مبلغ را به ریال و به‌صورت عدد صحیح مثبت بنویسید.',
  reasonText: 'شرح دلیل لازم است و حداکثر ۱۰۰۰ نویسه.',
  title: 'عنوان لازم است و حداکثر ۲۰۰ نویسه.',
  plannedDate: 'روز برنامه‌ریزی‌شده را از تقویم انتخاب کنید.',
  plannedShareBp: 'سهم را به درصد بنویسید: بیشتر از صفر، تا ۱۰۰ و حداکثر دو رقم اعشار.',
  characters: 'این متن نویسه‌های کنترلی جهت‌نما نمی‌پذیرد.',
} as const;

/** The typed fields of `command`'s form, as strings; the fields it does not draw are not read. */
export function commandFormValues(form: FormData, command: ContractCommand): ContractFormValues {
  const values: ContractFormValues = {};
  for (const field of COMMAND_FIELDS[command]) {
    const value = form.get(field);
    values[field] = typeof value === 'string' ? value : '';
  }
  return values;
}

/** A body's input back as form values — the unconfirmed view re-sends these. */
export function valuesOfInput(command: ContractCommand, input: CommandInput): ContractFormValues {
  if (input === null) return {};
  switch (command) {
    case 'CANCEL': {
      const cancel = input as CancelInput;
      return { reasonCode: cancel.reasonCode, note: cancel.note ?? '' };
    }
    case 'PROPOSE_AMENDMENT': {
      const amendment = input as AmendmentInput;
      return {
        deltaMinor: amendment.deltaMinor,
        reasonCode: amendment.reasonCode,
        reasonText: amendment.reasonText,
      };
    }
    case 'PLAN_MILESTONE':
    case 'CHANGE_MILESTONE': {
      const milestone = input as MilestoneInput;
      return {
        title: milestone.title,
        plannedDate: milestone.plannedDate,
        plannedShareBp:
          milestone.plannedShareBp === null ? '' : shareText(milestone.plannedShareBp),
      };
    }
    default:
      return {};
  }
}

/** Basis points as the percentage a person types: `2550` → `25.5`. Latin digits. */
export function shareText(shareBp: number): string {
  const whole = Math.trunc(shareBp / 100);
  const fraction = String(shareBp % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** Free text as `plainText()` keeps it: Persian letters normalised, trimmed, no bidi control. */
function text(
  raw: string | undefined,
  max: number,
  field: ContractField,
  errors: ContractFormErrors,
  required: boolean,
): string | null {
  const value = normalizePersianText(raw ?? '').trim();
  if (value.length === 0) {
    if (required) errors[field] = INPUT_MESSAGES[field as keyof typeof INPUT_MESSAGES];
    return null;
  }
  if (value.length > max) {
    errors[field] = INPUT_MESSAGES[field as keyof typeof INPUT_MESSAGES];
    return null;
  }
  if (BIDI_CONTROL.test(value)) {
    errors[field] = INPUT_MESSAGES.characters;
    return null;
  }
  return value;
}

function reasonCode(raw: string | undefined, errors: ContractFormErrors): string | null {
  const value = (raw ?? '').trim();
  if (!REASON_CODE.test(value)) {
    errors.reasonCode = INPUT_MESSAGES.reasonCode;
    return null;
  }
  return value;
}

/**
 * A calendar day that exists, `YYYY-MM-DD`, years 1000 to 9999 — the DTO's
 * `calendarDate`. The browser's date control gives exactly this shape.
 */
export function calendarDay(raw: string): string | null {
  const value = toLatinDigits(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1000) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? value
    : null;
}

/**
 * A percentage, as typed — Persian or Latin digits, `.` or `٫` as the decimal
 * mark, at most two decimals — in basis points, 1 to 10000. Blank is no share.
 * `undefined` when it is not one.
 */
export function shareBasisPoints(raw: string): number | null | undefined {
  const value = toLatinDigits(raw).replace('٫', '.').trim();
  if (value === '') return null;
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return undefined;
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return basisPoints >= 1 && basisPoints <= PLANNED_SHARE_BP_MAX ? basisPoints : undefined;
}

/**
 * The typed part of `command`'s body, read as the service's DTO reads it, or
 * the errors to put on the form. Whether a reason code is one the service
 * lists is the service's to check (`CANCEL_REASON_NOT_ALLOWED`,
 * `AMENDMENT_REASON_NOT_ALLOWED`): the form offers only those it was told of.
 */
export function parseCommandInput(
  command: ContractCommand,
  values: ContractFormValues,
): ParsedInput {
  const errors: ContractFormErrors = {};
  const done = (input: CommandInput): ParsedInput =>
    Object.keys(errors).length > 0
      ? { ok: false, fieldErrors: errors, message: null }
      : { ok: true, input };

  switch (command) {
    case 'SIGN':
    case 'SIGN_AMENDMENT':
      return { ok: true, input: null };
    case 'CANCEL': {
      const code = reasonCode(values.reasonCode, errors);
      const note = text(values.note, CANCEL_NOTE_MAX, 'note', errors, false);
      return done(code === null ? null : { reasonCode: code, ...(note !== null ? { note } : {}) });
    }
    case 'PROPOSE_AMENDMENT': {
      let minor: bigint | null;
      try {
        minor = parseMoneyInput(values.deltaMinor ?? '', IRR);
      } catch {
        minor = null;
      }
      if (minor === null || minor <= 0n || minor > MAX_AMOUNT_MINOR) {
        errors.deltaMinor = INPUT_MESSAGES.deltaMinor;
        minor = null;
      }
      const code = reasonCode(values.reasonCode, errors);
      const reason = text(values.reasonText, AMENDMENT_REASON_MAX, 'reasonText', errors, true);
      return done(
        minor === null || code === null || reason === null
          ? null
          : { deltaMinor: minor.toString(), reasonCode: code, reasonText: reason },
      );
    }
    case 'PLAN_MILESTONE':
    case 'CHANGE_MILESTONE': {
      const title = text(values.title, MILESTONE_TITLE_MAX, 'title', errors, true);
      const day = calendarDay(values.plannedDate ?? '');
      if (day === null) errors.plannedDate = INPUT_MESSAGES.plannedDate;
      const share = shareBasisPoints(values.plannedShareBp ?? '');
      if (share === undefined) errors.plannedShareBp = INPUT_MESSAGES.plannedShareBp;
      return done(
        title === null || day === null || share === undefined
          ? null
          : { title, plannedDate: day, plannedShareBp: share },
      );
    }
  }
}

/** Whether `value` is a body input `command` could have sent — for a record read back from storage. */
export function isCommandInput(command: ContractCommand, value: unknown): value is CommandInput {
  if (COMMAND_FIELDS[command].length === 0) return value === null;
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry);
  if (!keys.every((key) => (CONTRACT_FIELDS as readonly string[]).includes(key))) return false;
  const values: ContractFormValues = {};
  for (const field of COMMAND_FIELDS[command]) {
    const raw = entry[field];
    if (field === 'plannedShareBp') {
      if (raw !== null && (typeof raw !== 'number' || !Number.isInteger(raw))) return false;
      values.plannedShareBp = raw === null ? '' : shareText(raw);
    } else if (raw === undefined) {
      values[field] = '';
    } else if (typeof raw === 'string') {
      values[field] = raw;
    } else {
      return false;
    }
  }
  const parsed = parseCommandInput(command, values);
  return parsed.ok && JSON.stringify(parsed.input) === JSON.stringify(value);
}
