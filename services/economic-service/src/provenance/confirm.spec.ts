import {
  confirmApproval,
  confirmCompletion,
  confirmUsage,
  rewardSubject,
  type ApprovalClaim,
} from './confirm';
import type { MaintenanceRequestFact, UsageRecordFact } from './source-facts.client';

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

  describe('the reward subject', () => {
    it('is the user the owner recorded, and nobody when no user acted', () => {
      expect(rewardSubject('USR-RECORDER')).toBe('USR-RECORDER');
      expect(rewardSubject('SYSTEM')).toBeNull();
      expect(rewardSubject(null)).toBeNull();
      expect(rewardSubject('')).toBeNull();
    });
  });
});
