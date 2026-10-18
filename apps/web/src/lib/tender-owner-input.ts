import {
  DISQUALIFICATION_REASONS,
  DISQUALIFY_TEXT_MAX,
  JUSTIFICATION_FIELD,
  JUSTIFICATION_MAX,
  REASON_CODE_FIELD,
  REASON_TEXT_FIELD,
  SCORE_SCALE,
  scoreField,
} from './tender-evaluation-fields';
import {
  REASON_FIELD,
  REJECT_REASON_MAX,
  REJECT_REASON_MIN,
  REJECTION_COMMANDS,
  type OwnerCommand,
} from './tender-owner-fields';
import { formatScaledDecimal, parseScaledDecimalInput, toPersianDigits } from './format';

/**
 * Reading an owner command's form — client-safe: the form reads it to decide
 * whether a send is remembered, the unconfirmed view re-sends exactly what was
 * read, and the action reads it the same way before anything is sent. Each
 * field is read as its DTO reads it; what the page read (the step, the bid, the
 * revisions, the justification of an approved award) comes from the signed
 * stamp, never from here.
 */

/**
 * A rejection's reason, read as `decisionSchema`'s `statedReason` reads it:
 * trimmed, 8 to 500 characters.
 */
export const REJECT_REASON_MESSAGE = `دلیل رد لازم است: دست‌کم ${toPersianDigits(String(REJECT_REASON_MIN))} و حداکثر ${toPersianDigits(String(REJECT_REASON_MAX))} نویسه.`;

export function parseRejectReason(
  raw: string,
):
  | { readonly ok: true; readonly reason: string }
  | { readonly ok: false; readonly message: string } {
  const reason = raw.trim();
  if (reason.length < REJECT_REASON_MIN || reason.length > REJECT_REASON_MAX) {
    return { ok: false, message: REJECT_REASON_MESSAGE };
  }
  return { ok: true, reason };
}

export const OWNER_INPUT_MESSAGES = {
  reasonCode: 'یکی از دلیل‌های فهرست را برگزینید.',
  reasonText: `شرح دلیل لازم است: حداکثر ${toPersianDigits(String(DISQUALIFY_TEXT_MAX))} نویسه.`,
  justification: `انتخاب این پیشنهاد دلیل نوشته لازم دارد: حداکثر ${toPersianDigits(String(JUSTIFICATION_MAX))} نویسه.`,
  justificationLength: `دلیل حداکثر ${toPersianDigits(String(JUSTIFICATION_MAX))} نویسه است.`,
  scores: 'دست‌کم برای یک معیار امتیاز بنویسید.',
} as const;

/** One criterion of a scoring form: what the page read of it, and of the caller's own cell. */
export interface ScoringCell {
  readonly criterionCode: string;
  readonly maxScore: number;
  /** `PASS_FAIL`: 0 or the maximum, nothing between. */
  readonly passFail: boolean;
  /** The revision of the caller's own cell the page read — 0 for a cell not yet scored. */
  readonly expectedRevision: number;
}

export const scoreMessage = (cell: ScoringCell): string =>
  cell.passFail
    ? `برای این معیار فقط صفر یا ${formatScaledDecimal(String(cell.maxScore), 0)} پذیرفته است.`
    : `امتیاز عددی از صفر تا ${formatScaledDecimal(String(cell.maxScore), 0)} است، با حداکثر دو رقم اعشار.`;

/** What a command's form is read against: from the stamp in the action, from the page in the form. */
export interface OwnerFormContext {
  readonly scoring?: readonly ScoringCell[] | null;
  /** An award to a bid that is not the single first rank: `JUSTIFICATION_REQUIRED`. */
  readonly justificationRequired?: boolean;
  /** An award executing its approved request: the justification is the request's, not the form's. */
  readonly executes?: boolean;
}

export type OwnerValues = Readonly<Record<string, string>>;

/** What a command sends besides what the stamp binds. */
export interface OwnerInput {
  readonly reason?: string;
  readonly disqualification?: { readonly reasonCode: string; readonly reasonText: string };
  readonly scores?: readonly {
    readonly criterionCode: string;
    readonly scoreScaled: number;
    readonly expectedRevision: number;
  }[];
  /** A new award's justification as typed: null when none was. */
  readonly justification?: string | null;
}

export type ParsedOwnerForm =
  | {
      readonly ok: true;
      readonly input: OwnerInput;
      /** The fields as typed, for an unconfirmed re-send; null when the command has none. */
      readonly values: OwnerValues | null;
    }
  | {
      readonly ok: false;
      readonly values: OwnerValues;
      readonly fieldErrors: Partial<Record<string, string>>;
    };

/** The fields a command's form posts, as strings. */
export function ownerFields(command: OwnerCommand, context: OwnerFormContext): readonly string[] {
  if (REJECTION_COMMANDS.includes(command)) return [REASON_FIELD];
  switch (command) {
    case 'DISQUALIFY':
      return [REASON_CODE_FIELD, REASON_TEXT_FIELD];
    case 'SCORE':
      return (context.scoring ?? []).map(({ criterionCode }) => scoreField(criterionCode));
    case 'AWARD':
      return context.executes ? [] : [JUSTIFICATION_FIELD];
    default:
      return [];
  }
}

/** A command's typed fields, read from a posted form. */
export function ownerValuesOf(
  command: OwnerCommand,
  form: Pick<FormData, 'get'>,
  context: OwnerFormContext,
): OwnerValues {
  const values: Record<string, string> = {};
  for (const name of ownerFields(command, context)) {
    const value = form.get(name);
    values[name] = typeof value === 'string' ? value : '';
  }
  return values;
}

/** The form of `command`, read as its DTO reads it. */
export function parseOwnerForm(
  command: OwnerCommand,
  values: OwnerValues,
  context: OwnerFormContext,
): ParsedOwnerForm {
  const text = (name: string): string => values[name] ?? '';
  const fail = (fieldErrors: Partial<Record<string, string>>): ParsedOwnerForm => ({
    ok: false,
    values,
    fieldErrors,
  });

  if (REJECTION_COMMANDS.includes(command)) {
    const parsed = parseRejectReason(text(REASON_FIELD));
    if (!parsed.ok) return fail({ [REASON_FIELD]: parsed.message });
    return { ok: true, input: { reason: parsed.reason }, values };
  }

  switch (command) {
    case 'DISQUALIFY': {
      const errors: Record<string, string> = {};
      const reasonCode = text(REASON_CODE_FIELD).trim();
      const reasonText = text(REASON_TEXT_FIELD).trim();
      if (!DISQUALIFICATION_REASONS.includes(reasonCode)) {
        errors[REASON_CODE_FIELD] = OWNER_INPUT_MESSAGES.reasonCode;
      }
      if (reasonText.length < 1 || reasonText.length > DISQUALIFY_TEXT_MAX) {
        errors[REASON_TEXT_FIELD] = OWNER_INPUT_MESSAGES.reasonText;
      }
      if (Object.keys(errors).length > 0) return fail(errors);
      return { ok: true, input: { disqualification: { reasonCode, reasonText } }, values };
    }
    case 'SCORE': {
      const errors: Record<string, string> = {};
      const scores: {
        criterionCode: string;
        scoreScaled: number;
        expectedRevision: number;
      }[] = [];
      for (const cell of context.scoring ?? []) {
        const field = scoreField(cell.criterionCode);
        const raw = text(field).trim();
        // A blank criterion is not scored in this request.
        if (raw === '') continue;
        const scaled = parseScaledDecimalInput(raw, 2);
        const top = cell.maxScore * SCORE_SCALE;
        if (scaled === null || scaled > top || (cell.passFail && scaled !== 0 && scaled !== top)) {
          errors[field] = scoreMessage(cell);
          continue;
        }
        scores.push({
          criterionCode: cell.criterionCode,
          scoreScaled: scaled,
          expectedRevision: cell.expectedRevision,
        });
      }
      if (Object.keys(errors).length > 0) return fail(errors);
      const first = context.scoring?.[0];
      if (scores.length === 0) {
        return fail(
          first ? { [scoreField(first.criterionCode)]: OWNER_INPUT_MESSAGES.scores } : {},
        );
      }
      return { ok: true, input: { scores }, values };
    }
    case 'AWARD': {
      if (context.executes) return { ok: true, input: {}, values: null };
      const justification = text(JUSTIFICATION_FIELD).trim();
      if (justification.length > JUSTIFICATION_MAX) {
        return fail({ [JUSTIFICATION_FIELD]: OWNER_INPUT_MESSAGES.justificationLength });
      }
      if (justification === '' && context.justificationRequired) {
        return fail({ [JUSTIFICATION_FIELD]: OWNER_INPUT_MESSAGES.justification });
      }
      return { ok: true, input: { justification: justification || null }, values };
    }
    default:
      return { ok: true, input: {}, values: null };
  }
}

/** The form context a binding gives: the scoring it read, and an award's terms. */
export function ownerFormContext(binding: {
  readonly scoring?: readonly ScoringCell[] | null;
  readonly award?: {
    readonly justificationRequired: boolean;
    readonly execution: unknown;
  } | null;
}): OwnerFormContext {
  return {
    scoring: binding.scoring ?? null,
    justificationRequired: binding.award?.justificationRequired ?? false,
    executes: (binding.award?.execution ?? null) !== null,
  };
}
