import { RastaError } from '@rasta/nest-common';

/**
 * Policy and approval lifecycles (AGENTS.md A-11, ADR-063, Q-70).
 *
 * ## Approval policy (Q-70 (7), decided 2026-09-26)
 *
 * ```
 *   create        submit                           approve (SYSTEM_ADMIN)
 *   ────► DRAFT ─────────► PENDING_PLATFORM_APPROVAL ──────────────────► ACTIVE
 *                                   │                                      │
 *                                   └─reject(reason)─► REJECTED            │
 *                                                            approve(next) | retire
 *                                                                          ▼
 *                                                                       RETIRED
 * ```
 *
 * A union administrator (for its own organization or one beneath it) or the
 * platform administrator writes a policy; only a platform administrator puts
 * it in force. A DRAFT, PENDING or REJECTED policy never governs a project.
 * A policy is written once and never edited: a change is a new version,
 * approved in its place, which retires the old one in the same transaction.
 * An open approval round keeps the steps it copied, so a later policy never
 * changes a round already running (`docs/08` § 8.9).
 *
 * ## Approval (one step of one round)
 *
 * ```
 *   QUEUED ──(previous step granted)──► PENDING ──grant──► GRANTED
 *     │                                   │
 *     │                                   └──reject──► REJECTED
 *     └────────(round ends)──────► SUPERSEDED ◄──(round ends)──┘ (from PENDING)
 * ```
 *
 * Steps are strictly sequential: only the lowest undecided step of a round is
 * PENDING. Nothing here moves on a timer — silence is not consent (ADR-043,
 * Q-73) — and there is no automatic grant of any kind.
 */

export const WORKFLOW_KEYS = ['project.execution', 'project.completion'] as const;
export type WorkflowKey = (typeof WORKFLOW_KEYS)[number];

export const POLICY_STATES = [
  'DRAFT',
  'PENDING_PLATFORM_APPROVAL',
  'ACTIVE',
  'REJECTED',
  'RETIRED',
] as const;
export type PolicyStateName = (typeof POLICY_STATES)[number];

export const POLICY_TRANSITIONS: Readonly<Record<PolicyStateName, readonly PolicyStateName[]>> = {
  DRAFT: ['PENDING_PLATFORM_APPROVAL'],
  PENDING_PLATFORM_APPROVAL: ['ACTIVE', 'REJECTED'],
  ACTIVE: ['RETIRED'],
  REJECTED: [],
  RETIRED: [],
} as const;

/** The only state in which a policy governs a project. */
export const GOVERNING_POLICY_STATE: PolicyStateName = 'ACTIVE';

export const APPROVAL_STATES = ['QUEUED', 'PENDING', 'GRANTED', 'REJECTED', 'SUPERSEDED'] as const;
export type ApprovalStateName = (typeof APPROVAL_STATES)[number];

export const APPROVAL_TRANSITIONS: Readonly<
  Record<ApprovalStateName, readonly ApprovalStateName[]>
> = {
  QUEUED: ['PENDING', 'SUPERSEDED'],
  PENDING: ['GRANTED', 'REJECTED', 'SUPERSEDED'],
  GRANTED: [],
  REJECTED: [],
  SUPERSEDED: [],
} as const;

/** Undecided steps of a round: what ends when the round ends. */
export const OPEN_APPROVAL_STATES: readonly ApprovalStateName[] = ['QUEUED', 'PENDING'];

export function canTransitionPolicy(from: PolicyStateName, to: PolicyStateName): boolean {
  return POLICY_TRANSITIONS[from].includes(to);
}

export function canTransitionApproval(from: ApprovalStateName, to: ApprovalStateName): boolean {
  return APPROVAL_TRANSITIONS[from].includes(to);
}

export function assertPolicyTransition(
  policyId: string,
  from: PolicyStateName,
  to: PolicyStateName,
): void {
  if (canTransitionPolicy(from, to)) return;
  throw RastaError.businessRule(`Approval policy ${policyId} cannot move from ${from} to ${to}`, {
    policyId,
    from,
    to,
  });
}

/** Only a PENDING step can be decided; anything else is refused with 422. */
export function assertDecidable(approvalId: string, status: ApprovalStateName): void {
  if (status === 'PENDING') return;
  throw RastaError.businessRule(
    status === 'QUEUED'
      ? `Approval ${approvalId} has not been requested yet: an earlier step is still undecided`
      : `Approval ${approvalId} is ${status.toLowerCase()} and cannot be decided again`,
    { approvalId, status },
  );
}

/** The step bounds a policy step carries (`min` inclusive, `max` exclusive). */
export interface StepBounds {
  readonly minAmountMinor: bigint | null;
  readonly maxAmountMinor: bigint | null;
}

/**
 * Whether a policy step applies to a project with this estimate (Q-70).
 *
 * A step with no bounds always applies. A bounded step applies when
 * `min <= estimate < max`. Without an estimate, a bounded step cannot be
 * judged, so it does not apply — and if that leaves no step, the request is
 * refused rather than approved (the platform never approves by default).
 */
export function stepApplies(step: StepBounds, estimate: bigint | null): boolean {
  if (step.minAmountMinor === null && step.maxAmountMinor === null) return true;
  if (estimate === null) return false;
  if (step.minAmountMinor !== null && estimate < step.minAmountMinor) return false;
  if (step.maxAmountMinor !== null && estimate >= step.maxAmountMinor) return false;
  return true;
}
