import { z } from 'zod';
import { cursorPaginationSchema } from '@rasta/contracts';
import { PLATFORM_ROLES } from '@rasta/nest-common';
import { amountMinorInput } from '../project/dto';
import { APPROVAL_STATES, POLICY_STATES, WORKFLOW_KEYS } from './approval.state-machine';

/**
 * Approval policies and approval decisions at the boundary.
 *
 * `.strict()` everywhere: an approval's authority, a policy's status or an
 * approval's outcome are never taken from a field the client could set on the
 * wrong object. The decider is the authenticated user; the authority is what
 * the policy says; the project's organization is the policy writer's own.
 */

const expectedVersion = z.number().int().min(1).max(2_147_483_647);
const statedReason = z.string().trim().min(8).max(500);

/** An authority role: any platform role except the oversight role. */
const authorityRole = z
  .enum(PLATFORM_ROLES)
  .refine((role) => role !== 'AUDITOR', 'The oversight role can never be an approval authority');

export const MAX_POLICY_STEPS = 20;

export const policyStepInput = z
  .object({
    /** The kind of approval, in the tenant's own words (Q-02, Q-70). */
    approvalType: z.string().trim().min(2).max(200),
    /** The authority's organization. Stored as given; the platform creates no authority. */
    authorityOrganizationId: z.string().trim().min(1).max(64),
    authorityRole,
    /** How the tenant names the authority, e.g. a council's name. */
    authorityLabel: z.string().trim().min(2).max(200),
    /** Applies when the estimate is ≥ this (inclusive). */
    minAmountMinor: amountMinorInput.optional(),
    /** Applies when the estimate is < this (exclusive). */
    maxAmountMinor: amountMinorInput.optional(),
  })
  .strict()
  .refine(
    (step) =>
      step.minAmountMinor === undefined ||
      step.maxAmountMinor === undefined ||
      BigInt(step.minAmountMinor) < BigInt(step.maxAmountMinor),
    { message: 'minAmountMinor must be less than maxAmountMinor', path: ['maxAmountMinor'] },
  );

export const createPolicySchema = z
  .object({
    workflowKey: z.enum(WORKFLOW_KEYS),
    label: z.string().trim().min(2).max(200),
    /** Why — a governance setting without a rationale is unauditable. */
    rationale: z.string().trim().min(8).max(2000),
    /** Demo data: «نمونه — نیازمند تصویب» (ADR-023). */
    isSample: z.boolean().default(false),
    /** In order: the first is asked first (Q-70: strictly sequential). */
    steps: z.array(policyStepInput).min(1).max(MAX_POLICY_STEPS),
  })
  .strict();

export type CreatePolicyDto = z.infer<typeof createPolicySchema>;

export const policyTransitionSchema = z.object({ expectedVersion }).strict();
export type PolicyTransitionDto = z.infer<typeof policyTransitionSchema>;

export const listPoliciesQuerySchema = cursorPaginationSchema
  .extend({
    workflowKey: z.enum(WORKFLOW_KEYS).optional(),
    status: z.enum(POLICY_STATES).optional(),
  })
  .strict();
export type ListPoliciesQuery = z.infer<typeof listPoliciesQuerySchema>;

/** RequestApproval, StartProject, CompleteProject: a precondition only. */
export const projectCommandSchema = z.object({ expectedVersion }).strict();
export type ProjectCommandDto = z.infer<typeof projectCommandSchema>;

export const decisionSchema = z
  .object({
    expectedVersion,
    decision: z.enum(['GRANT', 'REJECT']),
    /** The authority's own reference number for the decision (docs/03 «شماره»). */
    decisionNumber: z.string().trim().min(1).max(100).optional(),
    /** Conditions of a grant (docs/03 «شرایط»). */
    conditions: z.string().trim().min(1).max(2000).optional(),
    /** Required for a rejection. */
    reason: statedReason.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === 'REJECT' && value.reason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'A rejection states its reason',
      });
    }
    if (value.decision === 'REJECT' && value.conditions !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conditions'],
        message: 'Conditions belong to a grant',
      });
    }
    if (value.decision === 'GRANT' && value.reason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'A grant has no reason; use conditions',
      });
    }
  });
export type DecisionDto = z.infer<typeof decisionSchema>;

export const inboxQuerySchema = cursorPaginationSchema
  .extend({ status: z.enum(APPROVAL_STATES).default('PENDING') })
  .strict();
export type InboxQuery = z.infer<typeof inboxQuerySchema>;

export const projectApprovalsQuerySchema = z
  .object({
    workflowKey: z.enum(WORKFLOW_KEYS).optional(),
    round: z.coerce.number().int().min(1).optional(),
  })
  .strict();
export type ProjectApprovalsQuery = z.infer<typeof projectApprovalsQuerySchema>;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export const policyStepViewSchema = z
  .object({
    stepOrder: z.number().int(),
    approvalType: z.string(),
    authorityOrganizationId: z.string(),
    authorityRole: z.string(),
    authorityLabel: z.string(),
    minAmountMinor: z.string().nullable(),
    maxAmountMinor: z.string().nullable(),
  })
  .strict();

export const policyViewSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    workflowKey: z.enum(WORKFLOW_KEYS),
    policyVersion: z.number().int(),
    status: z.enum(POLICY_STATES),
    label: z.string(),
    rationale: z.string(),
    isSample: z.boolean(),
    steps: z.array(policyStepViewSchema),
    createdAt: z.string(),
    createdBy: z.string(),
    activatedAt: z.string().nullable(),
    activatedBy: z.string().nullable(),
    retiredAt: z.string().nullable(),
    retiredBy: z.string().nullable(),
    version: z.number().int(),
  })
  .strict();

export const approvalViewSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    projectOrganizationId: z.string(),
    workflowKey: z.enum(WORKFLOW_KEYS),
    round: z.number().int(),
    stepOrder: z.number().int(),
    policyId: z.string(),
    policyVersion: z.number().int(),
    approvalType: z.string(),
    authorityOrganizationId: z.string(),
    authorityRole: z.string(),
    authorityLabel: z.string(),
    status: z.enum(APPROVAL_STATES),
    requestedAt: z.string().nullable(),
    decidedAt: z.string().nullable(),
    decidedBy: z.string().nullable(),
    decisionNumber: z.string().nullable(),
    conditions: z.string().nullable(),
    reason: z.string().nullable(),
    supersededAt: z.string().nullable(),
    /** Send it back as `expectedVersion` with the decision. */
    version: z.number().int(),
    /**
     * What the authority needs to decide, and nothing more: the project's
     * organization configured this authority, so it has chosen to show it this.
     */
    project: z
      .object({
        title: z.string(),
        operationType: z.string(),
        estimatedCostMinor: z.string().nullable(),
        status: z.string(),
      })
      .strict(),
  })
  .strict();

export type PolicyView = z.infer<typeof policyViewSchema>;
export type ApprovalView = z.infer<typeof approvalViewSchema>;
