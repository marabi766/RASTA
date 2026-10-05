import { RastaError } from '@rasta/nest-common';
import { ERROR_CODES } from '@rasta/contracts';
import type { TenderWorkflowKey } from '../approval/approval.state-machine';

/** 409 with a closed code: what was approved is no longer what would be executed. Nothing was executed. */
export function approvalStale(workflowKey: TenderWorkflowKey): RastaError {
  return new RastaError(
    ERROR_CODES.CONFLICT,
    'Approval refused: APPROVAL_STALE. What was approved is no longer what this command would ' +
      'execute (the tender changed, or the command is not the one approved); ask for approval again',
    { internalContext: { refusals: ['APPROVAL_STALE'], workflowKey } },
  );
}

/** 422 with a closed code: no approval path exists, and the platform never approves by default (Q-84). */
export function approvalPolicyRequired(
  workflowKey: TenderWorkflowKey,
  reason: 'NO_POLICY' | 'NO_APPLICABLE_STEP' = 'NO_POLICY',
): RastaError {
  return RastaError.businessRule(
    reason === 'NO_POLICY'
      ? `Approval refused: APPROVAL_POLICY_REQUIRED. There is no active ${workflowKey} approval ` +
          'policy in this organization; the platform never approves by default'
      : `Approval refused: APPROVAL_POLICY_REQUIRED. The active ${workflowKey} approval policy has ` +
          'no step that applies (a step with an amount range has no amount to be judged on here); ' +
          'the platform never approves by default',
    { workflowKey, reason, refusals: ['APPROVAL_POLICY_REQUIRED'] },
  );
}
