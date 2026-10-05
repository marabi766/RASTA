import { z } from 'zod';
import { cursorPaginationSchema } from '@rasta/contracts';
import { PLATFORM_ROLES } from '@rasta/nest-common';
import type { CursorPage } from '../contract/dto';
import { POLICY_STATES, WORKFLOW_KEYS } from './policy.state-machine';

/**
 * Approval policies at the boundary.
 *
 * `.strict()` everywhere: a policy's status, author or version is never taken from a field the
 * client could set on the wrong object. The author is the authenticated user; the governed
 * organization is the one the policy names and the hierarchy confirms.
 */

const expectedVersion = z.number().int().min(1).max(2_147_483_647);
const statedReason = z.string().trim().min(8).max(500);

/**
 * An authority role: any platform role except the oversight role and the platform operator. The
 * database refuses the same two (`ck_step_authority_not_oversight`).
 */
const AUTHORITY_ROLES = PLATFORM_ROLES.filter(
  (role) => role !== 'AUDITOR' && role !== 'SYSTEM_ADMIN',
) as [string, ...string[]];
// An enum rather than a refinement, so the published schema lists exactly the roles that can be named.
const authorityRole = z.enum(AUTHORITY_ROLES, {
  errorMap: () => ({
    message:
      'Not a role that can accept a contract for a party (never the oversight role or the platform operator)',
  }),
});

export const MAX_POLICY_STEPS = 20;

export const policyStepInput = z
  .object({
    /**
     * The authority's organization. For `contract.signature` it is the governed organization
     * itself — the employer decides which of its own roles accept a contract for it; anything
     * else is refused when the policy is written.
     */
    authorityOrganizationId: z.string().trim().min(1).max(64),
    authorityRole,
    /** How the tenant names the authority, e.g. «مدیر عامل». */
    authorityLabel: z.string().trim().min(2).max(200),
  })
  .strict();

export const createPolicySchema = z
  .object({
    /**
     * The organization this policy governs. A union administrator may name its own organization
     * or one beneath it (confirmed with organization-service); a platform administrator may name
     * any existing organization (Q-70 (7)).
     */
    organizationId: z.string().trim().min(1).max(64),
    workflowKey: z.enum(WORKFLOW_KEYS),
    label: z.string().trim().min(2).max(200),
    /** Why — a governance setting without a rationale is unauditable. */
    rationale: z.string().trim().min(8).max(2000),
    /** Demo data: «نمونه — نیازمند تصویب» (ADR-023). */
    isSample: z.boolean().default(false),
    /** The authorities. For `contract.signature` they are alternatives: any one may sign. */
    steps: z.array(policyStepInput).min(1).max(MAX_POLICY_STEPS),
  })
  .strict();
export type CreatePolicyDto = z.infer<typeof createPolicySchema>;

export const policyTransitionSchema = z.object({ expectedVersion }).strict();
export type PolicyTransitionDto = z.infer<typeof policyTransitionSchema>;

/** The platform administrator's refusal; the reason stays with the policy. */
export const policyRejectionSchema = z.object({ expectedVersion, reason: statedReason }).strict();
export type PolicyRejectionDto = z.infer<typeof policyRejectionSchema>;

export const listPoliciesQuerySchema = cursorPaginationSchema
  .extend({
    workflowKey: z.enum(WORKFLOW_KEYS).optional(),
    status: z.enum(POLICY_STATES).optional(),
  })
  .strict();
export type ListPoliciesQuery = z.infer<typeof listPoliciesQuerySchema>;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export const policyStepViewSchema = z
  .object({
    stepOrder: z.number().int(),
    authorityOrganizationId: z.string(),
    authorityRole: z.string(),
    authorityLabel: z.string(),
  })
  .strict();

export const policyViewSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    authorOrganizationId: z.string(),
    authorRole: z.enum(['UNION_ADMIN', 'SYSTEM_ADMIN']),
    workflowKey: z.enum(WORKFLOW_KEYS),
    policyVersion: z.number().int(),
    status: z.enum(POLICY_STATES),
    label: z.string(),
    rationale: z.string(),
    isSample: z.boolean(),
    steps: z.array(policyStepViewSchema),
    createdAt: z.string(),
    createdBy: z.string(),
    submittedAt: z.string().nullable(),
    submittedBy: z.string().nullable(),
    /** The platform approval. */
    activatedAt: z.string().nullable(),
    activatedBy: z.string().nullable(),
    rejectedAt: z.string().nullable(),
    rejectedBy: z.string().nullable(),
    rejectionReason: z.string().nullable(),
    retiredAt: z.string().nullable(),
    retiredBy: z.string().nullable(),
    /** Send it back as `expectedVersion` with the next transition. */
    version: z.number().int(),
  })
  .strict();
export type PolicyView = z.infer<typeof policyViewSchema>;

export type PolicyPage = CursorPage<PolicyView>;
