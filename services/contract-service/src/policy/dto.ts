import { z } from 'zod';
import { amountMinorSchema, cursorPaginationSchema } from '@rasta/contracts';
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
 * An authority role: any platform role except the oversight role and the platform operator, for
 * every workflow. The oversight role has aggregate access only; the platform creates no legal
 * authority of its own (CLAUDE.md principle 9), so it neither accepts a contract for a party nor
 * approves a tenant's statement — Q-96 (1) as clarified for CON-003 PR 5. The database refuses
 * the same two (`ck_step_authority_not_oversight`).
 */
const NEVER_AUTHORITY: readonly string[] = ['AUDITOR', 'SYSTEM_ADMIN'];
const AUTHORITY_ROLES = PLATFORM_ROLES.filter((role) => !NEVER_AUTHORITY.includes(role)) as [
  string,
  ...string[],
];
// An enum, so the published schema lists exactly the roles that can be named. The two excluded
// roles are refused first, with the reason: the validation pipe rebuilds an enum's own message
// from its options (S-09), and keeps a custom message only when it does not repeat the input.
const authorityRole = z.preprocess((role, context) => {
  if (typeof role === 'string' && NEVER_AUTHORITY.includes(role)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      fatal: true,
      message:
        'The oversight role and the platform operator are never an approval authority: the ' +
        'platform creates no legal authority, so it approves no tenant contract or statement',
    });
  }
  return role;
}, z.enum(AUTHORITY_ROLES));

export const MAX_POLICY_STEPS = 20;

/** A bound in minor units: a non-negative integer as a decimal string, within a bigint. */
const amountBound = amountMinorSchema.describe(
  'A statement gross in minor units (rials), a decimal string; never a float.',
);

export const policyStepInput = z
  .object({
    /**
     * The authority's organization. For `contract.signature` it is the governed organization
     * itself — the employer decides which of its own roles accept a contract for it; anything
     * else is refused when the policy is written. For a statement chain it may be any
     * organization — a supervising consultant, say (Q-96 (1)) — but a step that names the
     * contractor of a statement is refused when that statement is submitted.
     */
    authorityOrganizationId: z.string().trim().min(1).max(64),
    authorityRole,
    /** How the tenant names the authority, e.g. «مدیر عامل». */
    authorityLabel: z.string().trim().min(2).max(200),
    /**
     * Statement chains only: the step applies to a statement whose gross is ≥ this (inclusive).
     * A signing step with a bound is refused (`AMOUNT_BOUNDS_NOT_APPLICABLE`).
     */
    minAmountMinor: amountBound.optional(),
    /** Statement chains only: the step applies to a statement whose gross is < this (exclusive). */
    maxAmountMinor: amountBound
      .refine((value) => !/^0+$/.test(value), 'An exclusive maximum of 0 applies to nothing')
      .optional(),
  })
  .strict()
  .superRefine((step, context) => {
    // Zod runs this even when a bound failed its own pattern, with the raw text: `BigInt('12.5')`
    // would throw — a 500 whose message, the client's text, reaches the log. Two bounds are
    // compared only once both are amounts; a malformed one is already reported as such.
    const { minAmountMinor: min, maxAmountMinor: max } = step;
    if (min === undefined || max === undefined) return;
    if (!amountBound.safeParse(min).success || !amountBound.safeParse(max).success) return;
    if (BigInt(min) < BigInt(max)) return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxAmountMinor'],
      message: 'minAmountMinor must be less than maxAmountMinor',
    });
  });

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
    /**
     * The authorities. For `contract.signature` they are alternatives: any one may sign, so each
     * (organization, role) is named once. For a statement chain they are its steps, asked in this
     * order (Q-96 (1)); two of them may name the same (organization, role), for two people.
     */
    steps: z.array(policyStepInput).min(1).max(MAX_POLICY_STEPS),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.workflowKey !== 'contract.signature') return;
    // The database refuses the same row (`ck_step_signing_authority_once`).
    const named = new Set<string>();
    policy.steps.forEach((step, index) => {
      const authority = JSON.stringify([step.authorityOrganizationId, step.authorityRole]);
      if (named.has(authority)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', index],
          message: 'A signing policy names each authority once: its steps are alternatives',
        });
      }
      named.add(authority);
    });
  });
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
    /** A statement chain step's bounds on the gross (min inclusive, max exclusive), or null. */
    minAmountMinor: z.string().nullable(),
    maxAmountMinor: z.string().nullable(),
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
