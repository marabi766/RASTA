import type { Statement, StatementStep } from '@/server/contract-statements';

/**
 * A contract's statement as contract-service sends it, and the people of the
 * statement specs — one fixture for the server, action and screen specs, so
 * they read the same statement.
 *
 * The employer is ORG-DEH-0001, the contractor ORG-CON-0001; the technical
 * chain's one step is the employer's ORGANIZATION_ADMIN, the financial
 * chain's the employer's FLEET_MANAGER.
 */

export const EMPLOYER = 'ORG-DEH-0001';
export const CONTRACTOR = 'ORG-CON-0001';
export const STRANGER = 'ORG-DEH-0002';
export const CONTRACT_ID = 'CTR_01JCONTRACTAAAAAAAAAAAAAA';
export const STATEMENT_ID = 'STM_01JSTATEMENTAAAAAAAAAAAA';

export function step(
  stepOrder: number,
  authorityRole: string,
  decision: StatementStep['decision'] = null,
  authorityOrganizationId = EMPLOYER,
): StatementStep {
  return {
    stepOrder,
    authorityOrganizationId,
    authorityRole,
    authorityLabel: `مرجع ${authorityRole}`,
    decision,
  };
}

const APPROVED_AT = '2026-10-16T08:30:00.000Z';

export const approvedStep = (stepOrder: number, role: string): StatementStep =>
  step(stepOrder, role, { outcome: 'APPROVED', decidedAt: APPROVED_AT });

/** A submitted statement: two lines, one 5% deduction, both chains undecided. */
export const SUBMITTED: Statement = {
  id: STATEMENT_ID,
  contractId: CONTRACT_ID,
  organizationId: EMPLOYER,
  contractorOrganizationId: CONTRACTOR,
  statementNumber: 1,
  status: 'SUBMITTED',
  grossMinor: '1500000000',
  deductionsMinor: '75000000',
  netMinor: '1425000000',
  lines: [
    { lineNumber: 1, description: 'آسفالت', amountMinor: '1100000000', milestoneId: 'MST_1' },
    { lineNumber: 2, description: 'جدول‌گذاری', amountMinor: '400000000', milestoneId: null },
  ],
  deductions: [
    {
      deductionRuleId: 'DDR_1',
      name: 'حسن انجام کار',
      rateBp: 500,
      base: 'GROSS',
      amountMinor: '75000000',
    },
  ],
  createdAt: '2026-10-15T07:00:00.000Z',
  submittedAt: '2026-10-15T09:00:00.000Z',
  approvalChains: {
    technical: { policyId: 'POL_T', policyVersion: 1, steps: [step(1, 'ORGANIZATION_ADMIN')] },
    financial: { policyId: 'POL_F', policyVersion: 2, steps: [step(1, 'FLEET_MANAGER')] },
  },
  updatedAt: '2026-10-15T09:00:00.000Z',
  version: 2,
};

export const DRAFTED: Statement = {
  ...SUBMITTED,
  status: 'DRAFT',
  submittedAt: null,
  approvalChains: null,
  version: 1,
};

export const TECHNICALLY_APPROVED: Statement = {
  ...SUBMITTED,
  status: 'TECHNICALLY_APPROVED',
  approvalChains: {
    technical: {
      policyId: 'POL_T',
      policyVersion: 1,
      steps: [approvedStep(1, 'ORGANIZATION_ADMIN')],
    },
    financial: SUBMITTED.approvalChains!.financial,
  },
  version: 3,
};

export const SIGNED_CONTRACT = {
  organizationId: EMPLOYER,
  contractorOrganizationId: CONTRACTOR,
  status: 'SIGNED',
};

/** An unsigned token with these claims — the portal only reads it (`realm-roles.ts`). */
export const jwt = (claims: unknown): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

/** A person's token: acting for `org`, holding `roles` there, a member of `memberships`. */
export function tokenFor(
  org: string,
  roles: readonly string[],
  options: { memberships?: readonly string[]; realm?: readonly string[]; uid?: boolean } = {},
): string {
  const memberships = options.memberships ?? [org];
  return jwt({
    org_id: org,
    org_ids: memberships,
    org_roles: roles.map((role) => `${org}:${role}`),
    realm_access: { roles: options.realm ?? [] },
    ...(options.uid === false ? {} : { rasta_uid: 'USR-1' }),
  });
}
