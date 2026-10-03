import { z } from 'zod';
import { cursorPaginationSchema } from '@rasta/contracts';
import type { Approval, TenderApprovalRequest } from '../generated/prisma';
import { APPROVAL_STATES, TENDER_WORKFLOW_KEYS } from '../approval/approval.state-machine';
import type { ApprovalBindingView } from '../approval/dto';

/**
 * The owner's side of the tender approval gates (CON-002 PR 11) at the boundary: reading the requests
 * of one's own tender. Opening a request is not a route of its own: it is the command (`publish`,
 * `award`, `cancel`), which opens the round when none is open and uses it up when it is approved.
 */

export const TENDER_REQUEST_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'STALE',
  'CONSUMED',
] as const;
export type TenderRequestStatus = (typeof TENDER_REQUEST_STATUSES)[number];

export const listTenderApprovalsQuerySchema = cursorPaginationSchema
  .extend({ workflowKey: z.enum(TENDER_WORKFLOW_KEYS).optional() })
  .strict();
export type ListTenderApprovalsQuery = z.infer<typeof listTenderApprovalsQuerySchema>;

export const tenderApprovalStepViewSchema = z
  .object({
    approvalId: z.string(),
    stepOrder: z.number().int(),
    approvalType: z.string(),
    authorityOrganizationId: z.string(),
    authorityRole: z.string(),
    authorityLabel: z.string(),
    status: z.enum(APPROVAL_STATES),
    decidedAt: z.string().nullable(),
  })
  .strict();

/**
 * One request of one gate on the owner's tender, with its steps. For an award it shows the **status
 * and the steps only**: the bid it names, the justification and the standing read are what the
 * requester sent and what the authority decides on, and are read there (`GET /v1/approvals/{id}`),
 * under the conflict rules of an award.
 */
export const tenderApprovalRequestViewSchema = z
  .object({
    id: z.string(),
    tenderId: z.string(),
    workflowKey: z.enum(TENDER_WORKFLOW_KEYS),
    round: z.number().int(),
    /** The command must be made on this tender version, or the approval is stale (409). */
    tenderVersion: z.number().int(),
    status: z.enum(TENDER_REQUEST_STATUSES),
    /** A cancellation's closed reason code; `null` for the others. */
    reasonCode: z.enum(['OWNER_REQUEST', 'NO_QUALIFIED_BID']).nullable(),
    requestedBy: z.string(),
    requestedAt: z.string(),
    /** `REJECTED` or `STALE`, with when, once the request ended. */
    endedAt: z.string().nullable(),
    endedReason: z.enum(['REJECTED', 'STALE']).nullable(),
    consumedAt: z.string().nullable(),
    steps: z.array(tenderApprovalStepViewSchema),
  })
  .strict();
export type TenderApprovalRequestView = z.infer<typeof tenderApprovalRequestViewSchema>;

/**
 * What a gated command answers: the thing done (`executed`, 200), or — nothing is executed yet — the approval
 * request that is being decided (202). The command is the same call both times.
 */
export type Gated<T> =
  { executed: true; result: T } | { executed: false; request: TenderApprovalRequestView };

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** Where a request stands, from the row and its steps: used, ended, approved, or still being decided. */
export function requestStatus(
  request: Pick<TenderApprovalRequest, 'consumedAt' | 'endedReason'>,
  steps: readonly Pick<Approval, 'status'>[],
): TenderRequestStatus {
  if (request.consumedAt !== null) return 'CONSUMED';
  if (request.endedReason === 'REJECTED') return 'REJECTED';
  if (request.endedReason === 'STALE') return 'STALE';
  return steps.length > 0 && steps.every((step) => step.status === 'GRANTED')
    ? 'APPROVED'
    : 'PENDING';
}

export function toRequestView(
  request: TenderApprovalRequest,
  steps: readonly Approval[],
): TenderApprovalRequestView {
  return {
    id: request.id,
    tenderId: request.tenderId,
    workflowKey: request.workflowKey as TenderApprovalRequestView['workflowKey'],
    round: request.round,
    tenderVersion: request.tenderVersion,
    status: requestStatus(request, steps),
    reasonCode: request.reasonCode as TenderApprovalRequestView['reasonCode'],
    requestedBy: request.requestedBy,
    requestedAt: request.requestedAt.toISOString(),
    endedAt: iso(request.endedAt),
    endedReason: request.endedReason as TenderApprovalRequestView['endedReason'],
    consumedAt: iso(request.consumedAt),
    steps: steps.map((step) => ({
      approvalId: step.id,
      stepOrder: step.stepOrder,
      approvalType: step.approvalType,
      authorityOrganizationId: step.authorityOrganizationId,
      authorityRole: step.authorityRole,
      authorityLabel: step.authorityLabel,
      status: step.status,
      decidedAt: iso(step.decidedAt),
    })),
  };
}

/** What the authority is shown of the request its step belongs to (`withBid` false: a list, or a conflicted caller). */
export function toBindingView(
  request: TenderApprovalRequest,
  steps: readonly Pick<Approval, 'status'>[],
  withBid: boolean,
): ApprovalBindingView {
  return {
    requestId: request.id,
    tenderVersion: request.tenderVersion,
    status: requestStatus(request, steps),
    requestedBy: request.requestedBy,
    requestedAt: request.requestedAt.toISOString(),
    bid:
      withBid && request.bidId !== null
        ? {
            bidId: request.bidId,
            bidderOrganizationId: request.bidderOrganizationId as string,
            rank: request.rank as number,
            tied: request.tied as boolean,
            justification: request.justification,
            matrixDigest: request.matrixDigest as string,
            standingVerdict: request.standingVerdict as string,
            standingAsOf: (request.standingAsOf as Date).toISOString(),
          }
        : null,
    cancellation:
      request.reason !== null
        ? {
            reason: request.reason,
            reasonCode: request.reasonCode as 'OWNER_REQUEST' | 'NO_QUALIFIED_BID',
          }
        : null,
  };
}
