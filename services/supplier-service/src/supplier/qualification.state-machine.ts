import { RastaError } from '@rasta/nest-common';

/**
 * The qualification lifecycle, as data (AGENTS.md A-11).
 *
 * ```
 *                    ApproveQualification
 *                  ┌──────────────────────► APPROVED  (terminal)
 *                  │
 *   SubmitQualification
 *   ──────────► SUBMITTED
 *                  │
 *                  └──────────────────────► REJECTED  (terminal)
 *                    RejectQualification
 * ```
 *
 * ## Why exactly three states
 *
 * This is the smallest lifecycle that the approved commands require, and it was
 * derived from them rather than from what a qualification process usually looks
 * like. Three commands exist — `SubmitQualification`, `ApproveQualification`,
 * `RejectQualification` (`docs/04` § 4.10) — so there is one state before a
 * decision and one per decision, and nothing else is truthful yet.
 *
 * ## What is absent, and why each absence is a decision
 *
 *   DRAFT            There is no command that creates a qualification without
 *                    submitting it. A draft state would exist only to be
 *                    skipped.
 *   WITHDRAWN        No command withdraws a submission. Adding one would be
 *                    adding scope, and it is not obvious who may do it — the
 *                    supplier alone, or a reviewer clearing a queue?
 *   EXPIRED          Would require a validity period. No accepted document
 *                    states one, and inventing "qualifications last a year"
 *                    is inventing regulatory fact (AGENTS.md § 9).
 *   RENEWAL_DUE      Same, one step further.
 *   PROVISIONAL      Would mean the platform grants a partial qualification on
 *                    its own judgement. It has no judgement to grant it with.
 *   AUTO_APPROVED    Explicitly refused. Approval and rejection are human
 *                    decisions; nothing in this service decides on its own,
 *                    and there is no timer, threshold or score that can.
 *
 * ## Terminality, and what it forces
 *
 * `APPROVED` and `REJECTED` have no outgoing edges. A decided qualification is
 * never re-decided, so a reviewer cannot quietly flip a rejection to an
 * approval and leave one row that says only the second thing. Changing a
 * decision means a **new submission**, which carries its own actor, its own
 * timestamp and its own correlation id — and leaves the first decision
 * standing in the record.
 *
 * That is also why re-qualification is refused while an `APPROVED` row exists
 * for the same capability ({@link assertNoBlockingQualification}): with no
 * expiry rule, a second approval for something already approved would mean the
 * platform had invented a renewal cycle.
 *
 * ## Suspension is a different axis
 *
 * Nothing here mentions suspension. A suspended supplier's qualification is not
 * revoked — see `suspension.state-machine.ts` and {@link isCurrentlyQualified}.
 */

export const QUALIFICATION_STATES = ['SUBMITTED', 'APPROVED', 'REJECTED'] as const;

export type QualificationStateName = (typeof QUALIFICATION_STATES)[number];

export const QUALIFICATION_TRANSITIONS: Readonly<
  Record<QualificationStateName, readonly QualificationStateName[]>
> = {
  SUBMITTED: ['APPROVED', 'REJECTED'],
  APPROVED: [],
  REJECTED: [],
} as const;

/** States a qualification can never leave. */
export const TERMINAL_QUALIFICATION_STATES: readonly QualificationStateName[] = [
  'APPROVED',
  'REJECTED',
];

export function isTerminalQualificationState(state: QualificationStateName): boolean {
  return TERMINAL_QUALIFICATION_STATES.includes(state);
}

export function canTransitionQualification(
  from: QualificationStateName,
  to: QualificationStateName,
): boolean {
  return QUALIFICATION_TRANSITIONS[from].includes(to);
}

/**
 * Refuses an illegal transition with the platform's business-rule code.
 *
 * `422` rather than `409`: the request is well-formed and the caller is allowed
 * to make it — the qualification is simply not in a state where the command
 * means anything. A `409` would suggest retrying, which will never help, since
 * both end states are terminal.
 */
export function assertQualificationTransition(
  qualificationId: string,
  from: QualificationStateName,
  to: QualificationStateName,
): void {
  if (canTransitionQualification(from, to)) return;

  throw RastaError.businessRule(
    isTerminalQualificationState(from)
      ? `Qualification ${qualificationId} was already ${from.toLowerCase()} and cannot be decided again`
      : `Qualification ${qualificationId} cannot move from ${from} to ${to}`,
    { qualificationId, from, to },
  );
}

/**
 * Whether an approved qualification counts as *current*.
 *
 * The one place the two axes meet, and it is a function rather than a stored
 * flag on purpose: a stored flag would have to be maintained on both suspension
 * and reinstatement, and the first missed update would leave a suspended
 * supplier answering `ListQualifiedFor`.
 *
 * "A suspended supplier cannot be returned as currently qualified" is therefore
 * one expression, used by the read model and by the directory projection alike.
 * The approval itself is untouched — suspension does not revoke it, and
 * reinstating restores exactly what was there before with no new decision.
 */
export function isCurrentlyQualified(input: {
  state: QualificationStateName;
  supplierSuspended: boolean;
}): boolean {
  return input.state === 'APPROVED' && !input.supplierSuspended;
}

/**
 * Refuses a second submission for a capability that already has one open or
 * approved.
 *
 * Two open submissions for one capability could be decided differently by two
 * reviewers, leaving the supplier both approved and rejected for one thing.
 * A submission against an existing approval would be a renewal, and no accepted
 * document defines renewal.
 *
 * A previously **rejected** submission blocks nothing: refusal is not a
 * permanent bar, and re-applying after fixing whatever was wrong is the obvious
 * next step for a supplier. Each attempt stays in the record.
 */
export function assertNoBlockingQualification(
  capability: string,
  existing: readonly { state: QualificationStateName }[],
): void {
  const open = existing.find((row) => row.state === 'SUBMITTED');
  if (open) {
    throw RastaError.businessRule(
      `A qualification for ${capability} is already awaiting a decision`,
      { capability, blockingState: 'SUBMITTED' },
    );
  }

  const approved = existing.find((row) => row.state === 'APPROVED');
  if (approved) {
    throw RastaError.businessRule(`This supplier is already qualified for ${capability}`, {
      capability,
      blockingState: 'APPROVED',
    });
  }
}
