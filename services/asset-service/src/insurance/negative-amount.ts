import { RastaError } from '@rasta/nest-common';

/**
 * The non-negative CHECK constraints on the insurance money columns (migration
 * 20261005120000_insurance_money_non_negative, audit L7-36), each with the
 * request field whose value it refuses.
 *
 * Not `asset_timeline_entry.amount_minor`: no such constraint exists there (the
 * timeline accepts a signed amount from its producers), so nothing is mapped.
 */
export const NON_NEGATIVE_AMOUNT_CONSTRAINTS = {
  ck_policy_premium_non_negative: 'premiumMinor',
  ck_policy_insured_value_non_negative: 'insuredValueMinor',
  ck_claim_claimed_amount_non_negative: 'claimedAmountMinor',
  ck_claim_approved_amount_non_negative: 'approvedAmountMinor',
} as const;

/**
 * What `amountMinorSchema` answers for a negative amount: its regex's issue
 * code and message, so a refusal by the database reads exactly as the API's.
 */
const NEGATIVE_AMOUNT_ISSUE = {
  code: 'invalid_string',
  message: 'Amount must be a non-negative integer string in minor units',
} as const;

/**
 * PostgreSQL's `violates check constraint "<name>"`. Each quote may be
 * escaped: Prisma's unknown request error prints the driver error in its debug
 * form, `\"<name>\"`.
 */
const VIOLATED_CHECK = /violates check constraint \\?"([a-z0-9_]+)\\?"/;

/**
 * Which of these constraints refused the write, and the field it guards — or
 * `undefined` when the error is anything else.
 *
 * Matched on the constraint's name in the driver's text: Prisma reports a
 * CHECK violation as `P2010` from raw SQL and as an unknown request error from
 * `create`/`updateMany`, and both carry the PostgreSQL message. That text also
 * carries the failing row, amount included, so nothing else is read from it.
 */
export function violatedAmountConstraint(
  error: unknown,
): { constraint: NonNegativeAmountConstraint; path: NonNegativeAmountField } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const text = [
    (error as { message?: unknown }).message,
    (error as { meta?: { message?: unknown } }).meta?.message,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join('\n');

  const constraint = VIOLATED_CHECK.exec(text)?.[1];
  if (constraint === undefined || !Object.hasOwn(NON_NEGATIVE_AMOUNT_CONSTRAINTS, constraint)) {
    return undefined;
  }
  const known = constraint as NonNegativeAmountConstraint;
  return { constraint: known, path: NON_NEGATIVE_AMOUNT_CONSTRAINTS[known] };
}

export type NonNegativeAmountConstraint = keyof typeof NON_NEGATIVE_AMOUNT_CONSTRAINTS;
export type NonNegativeAmountField =
  (typeof NON_NEGATIVE_AMOUNT_CONSTRAINTS)[NonNegativeAmountConstraint];

/**
 * The 400 a negative amount gets, when it is one of these constraints that
 * refused a write of the caller's own amounts (a new policy or claim);
 * `undefined` for any other error, which the caller rethrows.
 *
 * The API refuses a negative amount before any service runs, so this is the
 * answer for a write that reached the database another way (an in-process
 * caller) — the 400 it is, never a 500. Built from the field name alone (S-09).
 */
export function negativeAmountRefusal(error: unknown): RastaError | undefined {
  const violated = violatedAmountConstraint(error);
  if (violated === undefined) return undefined;
  return RastaError.validation([{ path: violated.path, ...NEGATIVE_AMOUNT_ISSUE }]);
}

/**
 * What an UPDATE of a stored policy or claim gets when one of these constraints
 * refused it; `undefined` for any other error, which the caller rethrows.
 *
 * PostgreSQL checks a constraint on every UPDATE of a row — even a NOT VALID
 * one, and whichever columns the UPDATE sets. So the refused amount is either
 * one this UPDATE wrote (`written` sets the guarded field to a negative value):
 * the caller's, and the API's 400 for it; or one the row already held, which
 * the request never mentioned: a closed 422 that names no amount and no field,
 * since the caller sent neither and cannot correct a stored amount through the
 * API (#222 r1). The constraint and the record go to the server log only.
 */
export function storedAmountRefusal(
  error: unknown,
  written: Readonly<Record<string, unknown>>,
  record: InsuranceRecord,
): RastaError | undefined {
  const violated = violatedAmountConstraint(error);
  if (violated === undefined) return undefined;
  if (isNegative(written[violated.path])) {
    return RastaError.validation([{ path: violated.path, ...NEGATIVE_AMOUNT_ISSUE }]);
  }
  return storedAmountInvalid(violated.constraint, record);
}

/** The closed 422 for a stored amount the database refuses to keep. */
export function storedAmountInvalid(constraint: string, record: InsuranceRecord): RastaError {
  return RastaError.businessRule(STORED_AMOUNT_INVALID_MESSAGE, {
    rule: STORED_AMOUNT_INVALID,
    constraint,
    resourceType: record.type,
    ...(record.id === undefined ? {} : { id: record.id }),
    ...(record.assetId === undefined ? {} : { assetId: record.assetId }),
  });
}

/** The record a refused UPDATE touched, as far as the caller knows it. */
export interface InsuranceRecord {
  type: 'InsurancePolicy' | 'InsuranceClaim';
  id?: string;
  assetId?: string;
}

/** The rule a stored negative amount breaks; in the log, never in the answer. */
export const STORED_AMOUNT_INVALID = 'STORED_INSURANCE_AMOUNT_INVALID';

/**
 * Says what the caller can act on — the record must be corrected first — and
 * nothing about which amount or what it holds.
 */
export const STORED_AMOUNT_INVALID_MESSAGE =
  'An insurance record involved holds an invalid stored amount; it must be corrected by an operator before this change can be made.';

function isNegative(value: unknown): boolean {
  if (typeof value === 'bigint') return value < 0n;
  if (typeof value === 'number') return value < 0;
  if (typeof value === 'string') return value.trim().startsWith('-');
  return false;
}
