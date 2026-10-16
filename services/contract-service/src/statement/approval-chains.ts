import { STATEMENT_CHAINS, type StatementChain } from '../policy/policy.state-machine';

/**
 * Which steps of the policies in force make a statement's two approval chains (ADR-068 § 5,
 * Q-96 (1)) — the one place that decides it, pure, so the submission and its tests read the same
 * rule. The database checks the same at commit (`statement_approval_step_guard`,
 * `statement_submission_consistent`).
 *
 * - A chain is the steps of its policy that **apply** to the statement's gross: `minAmountMinor`
 *   inclusive, `maxAmountMinor` exclusive, a step with neither applies always (construction's rule,
 *   Q-70 (3); the basis is the gross, Q-134). They are kept in the policy's order.
 * - No policy in force for a chain, or no step of it that applies, refuses the submission: the
 *   platform never approves by default and never invents an approver.
 * - A step that applies and names the contractor's own organization refuses it too: the contractor
 *   would be approving its own claim. Fail closed — leaving the step out would silently shorten the
 *   chain the employer's policy wrote (Q-134).
 */

export interface ChainPolicyStep {
  readonly stepOrder: number;
  readonly authorityOrganizationId: string;
  readonly authorityRole: string;
  readonly authorityLabel: string;
  readonly minAmountMinor: bigint | null;
  readonly maxAmountMinor: bigint | null;
}

export interface ChainPolicy {
  readonly id: string;
  readonly policyVersion: number;
  readonly steps: readonly ChainPolicyStep[];
}

export interface SnapshottedChain {
  readonly policyId: string;
  readonly policyVersion: number;
  readonly steps: readonly ChainPolicyStep[];
}

export type ChainRefusal =
  | 'TECHNICAL_POLICY_REQUIRED'
  | 'FINANCIAL_POLICY_REQUIRED'
  | 'TECHNICAL_STEP_NOT_APPLICABLE'
  | 'FINANCIAL_STEP_NOT_APPLICABLE'
  | 'APPROVAL_STEP_NAMES_CONTRACTOR';

export type ChainSnapshot =
  | { readonly ok: true; readonly chains: Readonly<Record<StatementChain, SnapshottedChain>> }
  | { readonly ok: false; readonly refusals: readonly ChainRefusal[] };

/** Whether a step applies to a statement of this gross (`min` inclusive, `max` exclusive). */
export function stepApplies(
  step: Pick<ChainPolicyStep, 'minAmountMinor' | 'maxAmountMinor'>,
  grossMinor: bigint,
): boolean {
  if (step.minAmountMinor !== null && grossMinor < step.minAmountMinor) return false;
  if (step.maxAmountMinor !== null && grossMinor >= step.maxAmountMinor) return false;
  return true;
}

const POLICY_REQUIRED: Readonly<Record<StatementChain, ChainRefusal>> = {
  TECHNICAL: 'TECHNICAL_POLICY_REQUIRED',
  FINANCIAL: 'FINANCIAL_POLICY_REQUIRED',
};
const STEP_NOT_APPLICABLE: Readonly<Record<StatementChain, ChainRefusal>> = {
  TECHNICAL: 'TECHNICAL_STEP_NOT_APPLICABLE',
  FINANCIAL: 'FINANCIAL_STEP_NOT_APPLICABLE',
};

/**
 * Both chains for a statement of `grossMinor` whose contractor is `contractorOrganizationId`, or
 * every reason they cannot be made — technical first, then financial, then the contractor's step.
 */
export function snapshotChains(
  policies: Readonly<Record<StatementChain, ChainPolicy | null>>,
  grossMinor: bigint,
  contractorOrganizationId: string,
): ChainSnapshot {
  const refusals: ChainRefusal[] = [];
  const chains: Partial<Record<StatementChain, SnapshottedChain>> = {};
  let namesContractor = false;
  for (const chain of STATEMENT_CHAINS) {
    const policy = policies[chain];
    if (!policy) {
      refusals.push(POLICY_REQUIRED[chain]);
      continue;
    }
    const steps = [...policy.steps]
      .sort((a, b) => a.stepOrder - b.stepOrder)
      .filter((step) => stepApplies(step, grossMinor));
    if (steps.length === 0) {
      refusals.push(STEP_NOT_APPLICABLE[chain]);
      continue;
    }
    if (steps.some((step) => step.authorityOrganizationId === contractorOrganizationId)) {
      namesContractor = true;
    }
    chains[chain] = { policyId: policy.id, policyVersion: policy.policyVersion, steps };
  }
  if (namesContractor) refusals.push('APPROVAL_STEP_NAMES_CONTRACTOR');
  if (refusals.length > 0 || !chains.TECHNICAL || !chains.FINANCIAL) {
    return { ok: false, refusals };
  }
  return { ok: true, chains: { TECHNICAL: chains.TECHNICAL, FINANCIAL: chains.FINANCIAL } };
}
