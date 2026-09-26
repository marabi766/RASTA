import { RastaError } from '@rasta/nest-common';

/**
 * The project-need lifecycle (AGENTS.md A-11, Q-68).
 *
 * ```
 *   add                  submit
 *   ───► DRAFT ─────────────────────► SUBMITTED
 *          │                              │
 *          └──── withdraw(reason) ────────┴──► WITHDRAWN  (terminal)
 * ```
 *
 * A need is one line of what a project requires (Q-68, provisional). It is
 * drafted, then submitted into the project's scope; a submitted need is what a
 * later approval request covers (PR 2).
 *
 * ## Every transition also needs an editable project
 *
 * The need's own table says which edges exist. Whether any of them may be
 * taken **now** also depends on the parent: needs change only while the project
 * is `DRAFT` or `CHANGES_REQUESTED`. That rule lives in the service, which
 * locks the project row for the whole transaction, so a need cannot change
 * under an approval request that is being made at the same moment.
 *
 * ## What is absent
 *
 *   editing a SUBMITTED need  Changing a line after it was submitted would
 *                             leave no trace of what was submitted. Withdraw
 *                             it and add a new one: both steps are recorded.
 *   APPROVED / FULFILLED      Approval is of the project, not of each line
 *                             (`docs/03` § 3.3), and nothing in CON-001
 *                             fulfils a need.
 *   deleting                  Never. Withdrawn is the record that it existed.
 */

export const NEED_STATES = ['DRAFT', 'SUBMITTED', 'WITHDRAWN'] as const;

export type NeedStateName = (typeof NEED_STATES)[number];

export const NEED_TRANSITIONS: Readonly<Record<NeedStateName, readonly NeedStateName[]>> = {
  DRAFT: ['SUBMITTED', 'WITHDRAWN'],
  SUBMITTED: ['WITHDRAWN'],
  WITHDRAWN: [],
} as const;

/** States in which a need's own fields may change. */
export const EDITABLE_NEED_STATES: readonly NeedStateName[] = ['DRAFT'];

export function canTransitionNeed(from: NeedStateName, to: NeedStateName): boolean {
  return NEED_TRANSITIONS[from].includes(to);
}

export function isTerminalNeedState(state: NeedStateName): boolean {
  return NEED_TRANSITIONS[state].length === 0;
}

export function assertNeedTransition(needId: string, from: NeedStateName, to: NeedStateName): void {
  if (canTransitionNeed(from, to)) return;

  throw RastaError.businessRule(
    isTerminalNeedState(from)
      ? `Need ${needId} was withdrawn and cannot change state`
      : `Need ${needId} cannot move from ${from} to ${to}`,
    { needId, from, to },
  );
}

export function assertNeedEditable(needId: string, state: NeedStateName): void {
  if (EDITABLE_NEED_STATES.includes(state)) return;

  throw RastaError.businessRule(
    `Need ${needId} is ${state} and can no longer be edited; withdraw it and add a new one`,
    { needId, state },
  );
}
