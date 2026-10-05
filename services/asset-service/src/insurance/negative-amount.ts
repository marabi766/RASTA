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
 * The 400 a negative amount gets, when it is one of these constraints that
 * refused the write; `undefined` for any other error, which the caller rethrows.
 *
 * The API refuses a negative amount before any service runs, so this is the
 * answer for a write that reached the database another way (an in-process
 * caller) — the 400 it is, never a 500. Matched on the constraint's name in the
 * driver's text: Prisma reports a CHECK violation as `P2010` from raw SQL and
 * as an unknown request error from `create`/`updateMany`, and both carry the
 * PostgreSQL message. That text also carries the failing row, amount included,
 * so none of it is passed on (S-09): the answer is built from the field name
 * alone.
 */
export function negativeAmountRefusal(error: unknown): RastaError | undefined {
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
  const path =
    NON_NEGATIVE_AMOUNT_CONSTRAINTS[constraint as keyof typeof NON_NEGATIVE_AMOUNT_CONSTRAINTS];
  return RastaError.validation([{ path, ...NEGATIVE_AMOUNT_ISSUE }]);
}
