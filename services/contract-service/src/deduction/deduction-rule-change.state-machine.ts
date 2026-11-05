import { RastaError } from '@rasta/nest-common';

/**
 * The lifecycle of one proposed change to an employer's deduction rules (CON-003-1, docs/24 Q-125,
 * D-115).
 *
 * ```
 *   propose            approve (another person: a platform SYSTEM_ADMIN)
 *   ────► PENDING_APPROVAL ──────────────────────► APPROVED
 *             ├──reject(reason) (another person)─► REJECTED
 *             └──withdraw (the proposer)─────────► WITHDRAWN
 * ```
 *
 * `deduction_rule` stays the set of rules in force: only APPROVED changes it, in the same
 * transaction, and every state after PENDING_APPROVAL is final. A decided change is never edited;
 * trying again is a new proposal.
 *
 * The database keeps the same table (`deduction_rule_change_guard`); the state machine's spec and
 * `test/deduction-rule-change.int-spec.ts` fail if the two differ.
 */
export const DEDUCTION_CHANGE_STATES = [
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
] as const;
export type DeductionChangeState = (typeof DEDUCTION_CHANGE_STATES)[number];

export const DEDUCTION_CHANGE_TRANSITIONS: Readonly<
  Record<DeductionChangeState, readonly DeductionChangeState[]>
> = {
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'WITHDRAWN'],
  APPROVED: [],
  REJECTED: [],
  WITHDRAWN: [],
} as const;

export function canTransitionDeductionChange(
  from: DeductionChangeState,
  to: DeductionChangeState,
): boolean {
  return DEDUCTION_CHANGE_TRANSITIONS[from].includes(to);
}

export function assertDeductionChangeTransition(
  changeId: string,
  from: DeductionChangeState,
  to: DeductionChangeState,
): void {
  if (canTransitionDeductionChange(from, to)) return;
  throw RastaError.businessRule(
    `Deduction rule change ${changeId} cannot move from ${from} to ${to}`,
    {
      changeId,
      from,
      to,
    },
  );
}
