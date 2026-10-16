import { RastaError } from '@rasta/nest-common';

/**
 * The approval policy lifecycle (AGENTS.md A-11, ADR-063, ADR-068 § 5, Q-70 (7), Q-83) —
 * construction-service's, including the suspension an `ORGANIZATION_MOVED` causes.
 *
 * ```
 *   create        submit                           approve (SYSTEM_ADMIN)
 *   ────► DRAFT ─────────► PENDING_PLATFORM_APPROVAL ──────────────────► ACTIVE ──retire──► RETIRED
 *                              │         └──reject(reason)──► REJECTED     │
 *                              └────► SUSPENDED (the union no longer governs) ◄────┘
 * ```
 *
 * A union administrator (for its own organization or one beneath it) or the platform
 * administrator writes a policy; only a platform administrator puts it in force, and never one
 * who wrote or submitted it. A DRAFT, PENDING, REJECTED or SUSPENDED policy never governs anything.
 * A union's policy is SUSPENDED — by the system, never a person — when the union no longer governs
 * the organization it was written for (Q-83); it is never revived: a new version goes through
 * write, submit and approve. A policy
 * is written once and never edited: a change is a new version, approved in its place, which
 * retires the old one in the same transaction. A signature keeps the id and version of the policy
 * it was made under, so a later policy never rewrites what a signature rested on.
 *
 * The database keeps the same table (`approval_policy_guard`); `policy.state-machine.spec.ts`
 * fails if the two differ.
 */

/**
 * The workflows a policy can govern: who signs for the employer, and the two approval chains of
 * the employer's statements (ADR-068 § 5, Q-96 (1); CON-003 PR 5). The database keeps the same list
 * (`ck_policy_workflow_key`).
 */
export const WORKFLOW_KEYS = [
  'contract.signature',
  'contract.statement.technical',
  'contract.statement.financial',
] as const;
export type WorkflowKey = (typeof WORKFLOW_KEYS)[number];

export const SIGNATURE_WORKFLOW: WorkflowKey = 'contract.signature';

/**
 * A statement's two approval chains, in the order they run (Q-96 (2): technical, then financial),
 * and the workflow whose policy says each chain's steps.
 */
export const STATEMENT_CHAINS = ['TECHNICAL', 'FINANCIAL'] as const;
export type StatementChain = (typeof STATEMENT_CHAINS)[number];

export const CHAIN_WORKFLOW: Readonly<Record<StatementChain, WorkflowKey>> = Object.freeze({
  TECHNICAL: 'contract.statement.technical',
  FINANCIAL: 'contract.statement.financial',
});

export function isStatementChainWorkflow(workflowKey: string): boolean {
  return Object.values(CHAIN_WORKFLOW).includes(workflowKey as WorkflowKey);
}

export const POLICY_STATES = [
  'DRAFT',
  'PENDING_PLATFORM_APPROVAL',
  'ACTIVE',
  'REJECTED',
  'RETIRED',
  'SUSPENDED',
] as const;
export type PolicyStateName = (typeof POLICY_STATES)[number];

export const POLICY_TRANSITIONS: Readonly<Record<PolicyStateName, readonly PolicyStateName[]>> = {
  DRAFT: ['PENDING_PLATFORM_APPROVAL'],
  PENDING_PLATFORM_APPROVAL: ['ACTIVE', 'REJECTED', 'SUSPENDED'],
  ACTIVE: ['RETIRED', 'SUSPENDED'],
  REJECTED: [],
  RETIRED: [],
  SUSPENDED: [],
} as const;

/** The only state in which a policy governs anything. */
export const GOVERNING_POLICY_STATE: PolicyStateName = 'ACTIVE';

export function canTransitionPolicy(from: PolicyStateName, to: PolicyStateName): boolean {
  return POLICY_TRANSITIONS[from].includes(to);
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
