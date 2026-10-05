import { RastaError } from '@rasta/nest-common';
import { ERROR_CODES } from '@rasta/contracts';
import type { TenderWorkflowKey } from '../approval/approval.state-machine';
import { refusal, ruleRefusal } from '../shared/refusal';

/** The closed reasons an approval gate, or a decision or read of an approval, is refused for. */
export const TENDER_APPROVAL_REFUSALS = [
  'APPROVAL_POLICY_REQUIRED',
  'APPROVAL_STALE',
  'CONFLICT_OF_INTEREST',
  'APPROVER_IS_EVALUATOR',
  'READ_ROLE_NOT_HELD',
] as const;
export type TenderApprovalRefusal = (typeof TENDER_APPROVAL_REFUSALS)[number];

/** 409 with a closed code: what was approved is no longer what would be executed. Nothing was executed. */
export function approvalStale(workflowKey: TenderWorkflowKey): RastaError {
  return refusal(
    ERROR_CODES.CONFLICT,
    'Approval refused: APPROVAL_STALE. What was approved is no longer what this command would ' +
      'execute (the tender changed, or the command is not the one approved); ask for approval again',
    'approval',
    ['APPROVAL_STALE'],
    { workflowKey },
  );
}

/** 422 with a closed code: no approval path exists, and the platform never approves by default (Q-84). */
export function approvalPolicyRequired(
  workflowKey: TenderWorkflowKey,
  reason: 'NO_POLICY' | 'NO_APPLICABLE_STEP' = 'NO_POLICY',
): RastaError {
  return ruleRefusal(
    reason === 'NO_POLICY'
      ? `Approval refused: APPROVAL_POLICY_REQUIRED. There is no active ${workflowKey} approval ` +
          'policy in this organization; the platform never approves by default'
      : `Approval refused: APPROVAL_POLICY_REQUIRED. The active ${workflowKey} approval policy has ` +
          'no step that applies (a step with an amount range has no amount to be judged on here); ' +
          'the platform never approves by default',
    'approval',
    ['APPROVAL_POLICY_REQUIRED'],
    { workflowKey, reason },
  );
}
