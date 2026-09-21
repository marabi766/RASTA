import { RastaError } from '@rasta/nest-common';
import type { ClaimStatus } from '../asset/dto';

/**
 * The claim state machine (پرونده خسارت), written down so it can be read.
 *
 *     SUBMITTED ──► UNDER_REVIEW ──► APPROVED ──► SETTLED
 *                        │
 *                        └────────► REJECTED
 *
 * Three properties are deliberate:
 *
 *  - **A decision is taken only from UNDER_REVIEW.** Starting the review is
 *    where a named person takes the file; deciding straight from SUBMITTED
 *    would leave no record that anyone looked at it. Two transitions cost one
 *    extra request and buy an audit line that says who reviewed.
 *  - **REJECTED and SETTLED are terminal.** A settled claim is a financial
 *    fact recorded elsewhere; reopening it here would contradict a ledger this
 *    service does not own (AGENTS.md A-06/A-07). A rejected claim is refiled,
 *    not resurrected, so the new decision has its own history.
 *  - **There is no CANCELLED.** The enum does not have one, and adding a status
 *    is a schema change that should follow a product decision (docs/24 Q-59),
 *    not precede it.
 *
 * `SETTLED` records that settlement happened — it never performs one. Money
 * moves only in economic-service.
 */
export const CLAIM_TRANSITIONS: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>> = {
  SUBMITTED: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['SETTLED'],
  REJECTED: [],
  SETTLED: [],
};

export const TERMINAL_CLAIM_STATUSES: readonly ClaimStatus[] = ['REJECTED', 'SETTLED'];

export function canTransitionClaim(from: ClaimStatus, to: ClaimStatus): boolean {
  return CLAIM_TRANSITIONS[from].includes(to);
}

/** Throws `INVALID_STATE_TRANSITION` with a reason a client can act on. */
export function assertClaimTransition(from: ClaimStatus, to: ClaimStatus): void {
  if (canTransitionClaim(from, to)) return;

  const reason = TERMINAL_CLAIM_STATUSES.includes(from)
    ? `A ${from.toLowerCase()} claim is final and cannot be changed`
    : from === 'SUBMITTED' && (to === 'APPROVED' || to === 'REJECTED')
      ? 'A claim is decided only after its review has been started'
      : undefined;

  throw RastaError.invalidStateTransition('InsuranceClaim', from, to, reason);
}
