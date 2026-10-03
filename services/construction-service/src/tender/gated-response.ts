import type { Response } from 'express';
import type { Gated } from './tender-approval.dto';

/**
 * What a gated command answers on the wire (CON-002 PR 11): the thing done (200, the command's own body), or —
 * nothing is executed yet — the approval request being decided (202, `TenderApprovalRequestView`). The
 * command is the same call both times; the status says which one happened.
 */
export function answerGated<T>(response: Response, gated: Gated<T>) {
  if (gated.executed) return gated.result;
  response.status(202);
  return gated.request;
}

/** The sentence every gated route's description carries. */
export const GATED_NOTE =
  '**Behind an approval gate (Q-84):** with no active approval policy for this workflow the answer is ' +
  '422 naming APPROVAL_POLICY_REQUIRED. With one, a command that could succeed opens (or finds) the ' +
  'approval request bound to exactly what it would execute and answers **202** with the request ' +
  '(`TenderApprovalRequestView`); the policy names who decides it, and never the person who made it ' +
  '(`POST /v1/approvals/{id}/decision`). Once every step is granted the **same command**, on the same ' +
  'tender version, executes and uses the approval up in the same transaction (200); what changed ' +
  'since the approval is 409 naming APPROVAL_STALE and nothing is executed. An approval is used at most once.';
