import {
  confirmApproval,
  confirmStatementApproval,
  confirmCompletion,
  confirmTenant,
  confirmUsage,
  noObligationReason,
  rewardSubject,
  statementNoObligationReason,
  type ApprovalClaim,
  type StatementApprovalClaim,
} from './confirm';
import type { MaintenanceRequestFact, StatementFact, UsageRecordFact } from './source-facts.client';

/**
 * Every branch that decides whether an event may make money (ADR-061 § 4).
 */
describe('confirming an event against its owner', () => {
  const claim: ApprovalClaim = {
    requestId: 'MNT_1',
    organizationId: 'ORG-A',
    assetId: 'AST_1',
    approvedBy: 'USR-APPROVER',
    approvedAt: '2026-09-25T10:00:00.000Z',
    workshopOrganizationId: 'ORG-WORKSHOP',
    totalCostMinor: '450000',
    currency: 'IRR',
  };

  const approved: MaintenanceRequestFact = {
    id: 'MNT_1',
    organizationId: 'ORG-A',
    assetId: 'AST_1',
    type: 'CORRECTIVE',
    scheduleId: null,
    status: 'APPROVED',
    completedAt: '2026-09-25T09:00:00.000Z',
    completedBy: 'USR-MECHANIC',
    downtimeMinutes: 120,
    approvedAt: '2026-09-25T10:00:00.000Z',
    approvedBy: 'USR-APPROVER',
    totalCostMinor: '450000',
    currency: 'IRR',
    workshopOrganizationId: 'ORG-WORKSHOP',
  };

  describe("the envelope's tenant (ADR-061 § 5)", () => {
    it('is confirmed only when it is the organization the payload names', () => {
      expect(confirmTenant('ORG-A', 'ORG-A')).toEqual({ confirmed: true });
      // Envelope for A, payload naming a fact in B: refused before any token
      // is minted for B (PR #110 review #3).
      expect(confirmTenant('ORG-A', 'ORG-B')).toEqual({
        confirmed: false,
        mismatch: 'tenant_mismatch',
      });
      // No tenant is not a pass.
      expect(confirmTenant(undefined, 'ORG-A')).toMatchObject({ mismatch: 'tenant_mismatch' });
      expect(confirmTenant('', 'ORG-A')).toMatchObject({ mismatch: 'tenant_mismatch' });
    });
  });

  describe('whether a confirmed approval creates an obligation', () => {
    // Read from the owner's record, never the event's (PR #110 review #2).
    it('does for a positive amount owed to another organization', () => {
      expect(noObligationReason(approved)).toBeNull();
    });

    it('does not when the owner recorded no workshop, no cost, or the payer’s own workshop', () => {
      expect(noObligationReason({ ...approved, workshopOrganizationId: null })).toBe('no_workshop');
      expect(noObligationReason({ ...approved, totalCostMinor: '0' })).toBe('no_cost');
      expect(noObligationReason({ ...approved, workshopOrganizationId: 'ORG-A' })).toBe('in_house');
    });

    it('is not decided by an event that claims no workshop for an approval that has one', () => {
      // The event's claim meets the owner's record in confirmApproval first,
      // and a disagreement there is a refusal, not a skip.
      expect(confirmApproval({ ...claim, workshopOrganizationId: null }, approved)).toEqual({
        confirmed: false,
        mismatch: 'workshop_mismatch',
      });
      expect(confirmApproval({ ...claim, totalCostMinor: '0' }, approved)).toMatchObject({
        mismatch: 'amount_mismatch',
      });
    });
  });

  describe('an approval', () => {
    it('is confirmed only when the owner says exactly what the event says', () => {
      expect(confirmApproval(claim, approved)).toEqual({ confirmed: true });
      // The same instant written differently is the same approval.
      expect(
        confirmApproval({ ...claim, approvedAt: '2026-09-25T13:30:00+03:30' }, approved),
      ).toEqual({ confirmed: true });
    });

    it.each<[string, Partial<MaintenanceRequestFact> | null, string]>([
      ['no such request in that organization', null, 'not_found'],
      ['another organization', { organizationId: 'ORG-B' }, 'organization_mismatch'],
      ['another machine', { assetId: 'AST_2' }, 'asset_mismatch'],
      ['work not yet approved', { status: 'COMPLETED' }, 'status_mismatch'],
      ['work cancelled', { status: 'CANCELLED' }, 'status_mismatch'],
      ['another amount', { totalCostMinor: '450001' }, 'amount_mismatch'],
      ['another currency', { currency: 'USD' }, 'currency_mismatch'],
      ['another payee', { workshopOrganizationId: 'ORG-ELSEWHERE' }, 'workshop_mismatch'],
      ['no outside payee at all', { workshopOrganizationId: null }, 'workshop_mismatch'],
      ['another approver', { approvedBy: 'USR-SOMEONE-ELSE' }, 'approval_mismatch'],
      ['another instant', { approvedAt: '2026-09-25T10:00:00.001Z' }, 'approval_mismatch'],
      ['no approval instant', { approvedAt: null }, 'approval_mismatch'],
    ])('is refused for %s', (_case, change, mismatch) => {
      const fact = change === null ? null : { ...approved, ...change };
      expect(confirmApproval(claim, fact)).toEqual({ confirmed: false, mismatch });
    });

    it('compares amounts as integers, not as text', () => {
      // A leading zero is the same amount, and must not dead-letter an approval.
      expect(confirmApproval({ ...claim, totalCostMinor: '0450000' }, approved)).toEqual({
        confirmed: true,
      });
    });
  });

  describe('a completion', () => {
    const completion = { organizationId: 'ORG-A', assetId: 'AST_1' };

    it('is confirmed for completed work, and for work since approved', () => {
      expect(confirmCompletion(completion, { ...approved, status: 'COMPLETED' })).toEqual({
        confirmed: true,
      });
      expect(confirmCompletion(completion, approved)).toEqual({ confirmed: true });
    });

    it('is refused for work that is not complete, or is somebody else’s', () => {
      expect(
        confirmCompletion(completion, { ...approved, status: 'IN_PROGRESS', completedAt: null }),
      ).toEqual({ confirmed: false, mismatch: 'status_mismatch' });
      expect(confirmCompletion(completion, { ...approved, organizationId: 'ORG-B' })).toEqual({
        confirmed: false,
        mismatch: 'organization_mismatch',
      });
      expect(confirmCompletion(completion, null)).toEqual({
        confirmed: false,
        mismatch: 'not_found',
      });
    });
  });

  describe('a usage record', () => {
    const record: UsageRecordFact = {
      id: 'USG_1',
      organizationId: 'ORG-A',
      assetId: 'AST_1',
      driverId: null,
      assignmentId: null,
      periodStart: '2026-09-25T06:00:00.000Z',
      periodEnd: '2026-09-25T14:00:00.000Z',
      hours: '7.5',
      kilometres: null,
      hourMeter: null,
      odometer: null,
      source: 'MANUAL',
      recordedAt: '2026-09-25T14:05:00.000Z',
      recordedBy: 'USR-RECORDER',
    };

    it('is confirmed on its identity alone, because nothing else is read from the event', () => {
      expect(confirmUsage({ organizationId: 'ORG-A', assetId: 'AST_1' }, record)).toEqual({
        confirmed: true,
      });
      expect(confirmUsage({ organizationId: 'ORG-A', assetId: 'AST_9' }, record)).toEqual({
        confirmed: false,
        mismatch: 'asset_mismatch',
      });
      expect(confirmUsage({ organizationId: 'ORG-A', assetId: 'AST_1' }, null)).toEqual({
        confirmed: false,
        mismatch: 'not_found',
      });
    });
  });

  describe('an approved contract statement (ADR-068 § 6 (2))', () => {
    const announced: StatementApprovalClaim = {
      statementId: 'STM_1',
      contractId: 'CTR_1',
      organizationId: 'ORG-EMPLOYER',
      contractorOrganizationId: 'ORG-CONTRACTOR',
      approvedAt: '2026-10-16T11:00:00.000Z',
    };
    const stated: StatementFact = {
      statementId: 'STM_1',
      contractId: 'CTR_1',
      status: 'APPROVED',
      netMinor: '7350000',
      currency: 'IRR',
      payerOrganizationId: 'ORG-EMPLOYER',
      beneficiaryOrganizationId: 'ORG-CONTRACTOR',
      approvedAt: '2026-10-16T11:00:00.000+00:00',
    };

    it('is confirmed when the owner states what the event claims, the same instant in any notation', () => {
      expect(confirmStatementApproval(announced, stated)).toEqual({ confirmed: true });
    });

    it.each<[string, Partial<StatementFact> | null, string]>([
      ['no such statement for that employer', null, 'not_found'],
      ['another payer', { payerOrganizationId: 'ORG-OTHER' }, 'organization_mismatch'],
      ['another contract', { contractId: 'CTR_2' }, 'contract_mismatch'],
      ['a draft', { status: 'DRAFT', approvedAt: null }, 'status_mismatch'],
      ['a submitted statement', { status: 'SUBMITTED', approvedAt: null }, 'status_mismatch'],
      [
        'a technically approved one',
        { status: 'TECHNICALLY_APPROVED', approvedAt: null },
        'status_mismatch',
      ],
      ['a rejected one', { status: 'REJECTED', approvedAt: null }, 'status_mismatch'],
      ['a status this side does not know', { status: 'SETTLED' }, 'status_mismatch'],
      ['another contractor', { beneficiaryOrganizationId: 'ORG-ELSE' }, 'beneficiary_mismatch'],
      ['another approval instant', { approvedAt: '2026-10-16T11:00:00.001Z' }, 'approval_mismatch'],
      ['an approval with no instant', { approvedAt: null }, 'approval_mismatch'],
      ['a currency no wallet is kept in', { currency: 'USD' }, 'currency_mismatch'],
    ])('refuses %s', (_case, override, mismatch) => {
      const fact = override === null ? null : { ...stated, ...override };
      expect(confirmStatementApproval(announced, fact)).toEqual({ confirmed: false, mismatch });
    });

    it('refuses an employer that is its own contractor, even when the event claims the same', () => {
      const self = { ...stated, beneficiaryOrganizationId: 'ORG-EMPLOYER' };
      expect(
        confirmStatementApproval({ ...announced, contractorOrganizationId: 'ORG-EMPLOYER' }, self),
      ).toEqual({ confirmed: false, mismatch: 'beneficiary_mismatch' });
    });

    it('creates no obligation only for a net of zero, decided from the owner’s figure', () => {
      expect(statementNoObligationReason({ ...stated, netMinor: '0' })).toBe('no_cost');
      expect(statementNoObligationReason({ ...stated, netMinor: '1' })).toBeNull();
      expect(
        statementNoObligationReason({ ...stated, netMinor: '9223372036854775807' }),
      ).toBeNull();
    });
  });

  describe('the reward subject', () => {
    it('is the user the owner recorded, and nobody when no user acted', () => {
      expect(rewardSubject('USR-RECORDER')).toBe('USR-RECORDER');
      expect(rewardSubject('SYSTEM')).toBeNull();
      expect(rewardSubject(null)).toBeNull();
      expect(rewardSubject('')).toBeNull();
    });
  });
});
