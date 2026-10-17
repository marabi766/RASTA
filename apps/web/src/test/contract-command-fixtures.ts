import type { SigningPolicy } from '@/server/contract-commands';
import type { Amendment, ContractDetail, Milestone } from '@/server/contracts';

import { CONTRACT_ID, CONTRACTOR, EMPLOYER } from './statement-fixtures';

/**
 * A contract, its amendments and milestones and the employer's signing
 * policy, as contract-service sends them — one fixture for the server, action
 * and screen specs of the contract commands. The parties are those of
 * `statement-fixtures.ts`: ORG-DEH-0001 employs ORG-CON-0001.
 */

export { CONTRACT_ID, CONTRACTOR, EMPLOYER, STRANGER, tokenFor } from './statement-fixtures';

export const AMENDMENT_ID = 'AMD_01JAMENDMENTAAAAAAAAAAAA';
export const MILESTONE_ID = 'MST_01JMILESTONEAAAAAAAAAAAA';

/** A draft nobody has signed yet. */
export const DRAFT: ContractDetail = {
  id: CONTRACT_ID,
  organizationId: EMPLOYER,
  contractorOrganizationId: CONTRACTOR,
  tenderId: 'TND_1',
  projectId: 'PRJ_1',
  status: 'DRAFT',
  amountMinor: '5000000000',
  currentAmountMinor: '5000000000',
  awardedAt: '2026-10-01T08:00:00.000Z',
  statusChangedAt: '2026-10-01T08:00:00.000Z',
  winningBidId: 'BID_1',
  amendmentsTotalMinor: '0',
  employerSignedAt: null,
  contractorSignedAt: null,
  authorityReviewRequired: false,
  authorityReviewReason: null,
  cancelReasonCode: null,
  cancelNote: null,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
  version: 1,
};

export const CONTRACTOR_SIGNED: ContractDetail = {
  ...DRAFT,
  contractorSignedAt: '2026-10-02T07:00:00.000Z',
};

export const SIGNED: ContractDetail = {
  ...DRAFT,
  status: 'SIGNED',
  employerSignedAt: '2026-10-02T08:00:00.000Z',
  contractorSignedAt: '2026-10-02T07:00:00.000Z',
  statusChangedAt: '2026-10-02T08:00:00.000Z',
  updatedAt: '2026-10-02T08:00:00.000Z',
  version: 2,
};

export const CANCELLED: ContractDetail = {
  ...DRAFT,
  status: 'CANCELLED',
  cancelReasonCode: 'TERMS_NOT_AGREED',
  cancelNote: null,
  version: 2,
};

export const PROPOSED: Amendment = {
  id: AMENDMENT_ID,
  contractId: CONTRACT_ID,
  organizationId: EMPLOYER,
  amendmentNumber: 1,
  deltaMinor: '2000000',
  reasonCode: 'SCOPE_CHANGE',
  reasonText: 'افزایش محدودهٔ کار',
  status: 'PROPOSED',
  employerSignedAt: null,
  contractorSignedAt: null,
  authorityReviewRequired: false,
  proposedAt: '2026-10-03T08:00:00.000Z',
  effectiveAt: null,
  updatedAt: '2026-10-03T08:00:00.000Z',
  version: 1,
};

export const MILESTONE: Milestone = {
  id: MILESTONE_ID,
  contractId: CONTRACT_ID,
  organizationId: EMPLOYER,
  title: 'تحویل فاز یک',
  plannedDate: '2026-12-20',
  plannedShareBp: 2550,
  referenced: false,
  createdAt: '2026-10-03T08:00:00.000Z',
  updatedAt: '2026-10-03T08:00:00.000Z',
  version: 1,
};

/** The employer's `contract.signature` policy in force: its ORGANIZATION_ADMIN signs. */
export const SIGNING_POLICY: SigningPolicy = {
  id: 'POL_SIGNATURE',
  organizationId: EMPLOYER,
  workflowKey: 'contract.signature',
  status: 'ACTIVE',
  steps: [{ authorityOrganizationId: EMPLOYER, authorityRole: 'ORGANIZATION_ADMIN' }],
};

/** The policy as the list route sends it, every field. */
export function policyView(policy: SigningPolicy = SIGNING_POLICY): Record<string, unknown> {
  return {
    ...policy,
    authorOrganizationId: 'ORG-UNION-YAZD',
    authorRole: 'SYSTEM_ADMIN',
    policyVersion: 1,
    label: 'امضای قرارداد',
    rationale: 'آزمون',
    isSample: false,
    steps: policy.steps.map((step, index) => ({
      stepOrder: index + 1,
      ...step,
      authorityLabel: 'مدیر',
      minAmountMinor: null,
      maxAmountMinor: null,
    })),
    createdAt: '2026-09-01T08:00:00.000Z',
    createdBy: 'USR-ADMIN',
    submittedAt: '2026-09-01T09:00:00.000Z',
    submittedBy: 'USR-ADMIN',
    activatedAt: '2026-09-01T10:00:00.000Z',
    activatedBy: 'USR-ADMIN',
    rejectedAt: null,
    rejectedBy: null,
    rejectionReason: null,
    retiredAt: null,
    retiredBy: null,
    version: 3,
  };
}
