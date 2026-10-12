import { toContractView } from './views';
import { contractViewSchema } from './dto';
import type { Contract } from '../generated/prisma';

const AT = new Date('2026-10-05T08:00:00.000Z');

function row(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 'CTR_01',
    organizationId: 'ORG_EMPLOYER',
    tenderId: 'TND_01',
    projectId: 'PRJ_01',
    winningBidId: 'BID_01',
    contractorOrganizationId: 'ORG_CONTRACTOR',
    amountMinor: 12_345_678_901_234_567n,
    amendmentsTotalMinor: 0n,
    approvedTotalMinor: 0n,
    matrixDigest: 'a'.repeat(64),
    awardedBy: 'USR_AWARDER',
    awardedAt: AT,
    status: 'DRAFT',
    statusChangedAt: AT,
    statusChangedBy: 'service:contract-service',
    sourceEventId: 'EVT_01',
    createdAt: AT,
    createdBy: 'service:contract-service',
    createdCorrelationId: 'COR_01',
    updatedAt: AT,
    cancelReasonCode: null,
    cancelNote: null,
    version: 1,
    ...overrides,
  };
}

describe('toContractView', () => {
  it('sends money as a decimal string that loses no digit a number would', () => {
    const view = toContractView(row());
    expect(view.amountMinor).toBe('12345678901234567');
    expect(typeof view.amountMinor).toBe('string');
  });

  it('shows the amendments total and the price the contract stands at, exactly, past 2^53', () => {
    const view = toContractView(row({ amountMinor: 9_000_000_000_000_001n }));
    expect(view).toMatchObject({
      amendmentsTotalMinor: '0',
      currentAmountMinor: '9000000000000001',
    });
    // The two ends of what a bigint stores: the sum is exact and never a rounded number.
    const edge = toContractView(
      row({ amountMinor: 1n, amendmentsTotalMinor: 9_223_372_036_854_775_806n }),
    );
    expect(edge.currentAmountMinor).toBe('9223372036854775807');
    expect(contractViewSchema.safeParse(edge).success).toBe(true);
  });

  it('shows no approved total: it is the cap’s second counter and belongs to statements', () => {
    expect(toContractView(row({ approvedTotalMinor: 5n }))).not.toHaveProperty(
      'approvedTotalMinor',
    );
  });

  it('sends instants as ISO 8601 in UTC', () => {
    expect(toContractView(row()).awardedAt).toBe('2026-10-05T08:00:00.000Z');
  });

  it('shows a party nothing of who awarded, what it was awarded on or who drafted it', () => {
    const view = toContractView(row()) as Record<string, unknown>;
    for (const hidden of [
      'awardedBy',
      'matrixDigest',
      'createdBy',
      'statusChangedBy',
      'sourceEventId',
      'createdCorrelationId',
    ]) {
      expect(view).not.toHaveProperty(hidden);
    }
  });

  it('shows when each side accepted and never who', () => {
    const EMPLOYER_AT = new Date('2026-10-05T09:00:00.000Z');
    const CONTRACTOR_AT = new Date('2026-10-05T10:00:00.000Z');
    expect(toContractView(row())).toMatchObject({
      employerSignedAt: null,
      contractorSignedAt: null,
    });
    const view = toContractView(row(), [
      { side: 'CONTRACTOR', signedAt: CONTRACTOR_AT },
      { side: 'EMPLOYER', signedAt: EMPLOYER_AT },
    ]);
    expect(view).toMatchObject({
      employerSignedAt: '2026-10-05T09:00:00.000Z',
      contractorSignedAt: '2026-10-05T10:00:00.000Z',
    });
    expect(JSON.stringify(view)).not.toMatch(/signedBy|signer/i);
  });

  it('shows why a cancelled draft was cancelled', () => {
    const view = toContractView(
      row({ status: 'CANCELLED', cancelReasonCode: 'TERMS_NOT_AGREED', cancelNote: 'No deal' }),
    );
    expect(view).toMatchObject({
      status: 'CANCELLED',
      cancelReasonCode: 'TERMS_NOT_AGREED',
      cancelNote: 'No deal',
    });
    expect(contractViewSchema.safeParse(view).success).toBe(true);
  });

  it('is exactly what the published schema accepts, and no more', () => {
    expect(contractViewSchema.safeParse(toContractView(row())).success).toBe(true);
    expect(
      contractViewSchema.safeParse({ ...toContractView(row()), awardedBy: 'USR_AWARDER' }).success,
    ).toBe(false);
  });
});
