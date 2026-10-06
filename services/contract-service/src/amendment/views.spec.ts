import type { Amendment } from '../generated/prisma';
import { amendmentViewSchema } from './dto';
import { toAmendmentView } from './views';

const AT = new Date('2026-10-07T08:00:00.000Z');

function row(overrides: Partial<Amendment> = {}): Amendment {
  return {
    id: 'AMD_01',
    organizationId: 'ORG_EMPLOYER',
    contractId: 'CTR_01',
    amendmentNumber: 1,
    deltaMinor: 9_223_372_036_854_775_807n,
    reasonCode: 'SCOPE_CHANGE',
    reasonText: 'Extra pile work',
    status: 'PROPOSED',
    proposedBy: 'USR_PROPOSER',
    proposedAt: AT,
    proposedCorrelationId: 'COR_01',
    effectiveAt: null,
    updatedAt: AT,
    version: 1,
    ...overrides,
  };
}

describe('toAmendmentView', () => {
  it('sends the amount as a decimal string that loses no digit', () => {
    const view = toAmendmentView(row());
    expect(view.deltaMinor).toBe('9223372036854775807');
    expect(typeof view.deltaMinor).toBe('string');
    expect(amendmentViewSchema.safeParse(view).success).toBe(true);
  });

  it('shows when each side signed and never who, nor who proposed', () => {
    const employerAt = new Date('2026-10-07T09:00:00.000Z');
    const contractorAt = new Date('2026-10-07T10:00:00.000Z');
    expect(toAmendmentView(row())).toMatchObject({
      employerSignedAt: null,
      contractorSignedAt: null,
      authorityReviewRequired: false,
      effectiveAt: null,
    });
    const view = toAmendmentView(row({ status: 'EFFECTIVE', effectiveAt: contractorAt }), [
      { side: 'CONTRACTOR', signedAt: contractorAt },
      { side: 'EMPLOYER', signedAt: employerAt },
    ]);
    expect(view).toMatchObject({
      employerSignedAt: '2026-10-07T09:00:00.000Z',
      contractorSignedAt: '2026-10-07T10:00:00.000Z',
      effectiveAt: '2026-10-07T10:00:00.000Z',
      status: 'EFFECTIVE',
    });
    expect(JSON.stringify(view)).not.toMatch(/signedBy|signer|proposedBy|USR_PROPOSER|COR_01/i);
  });

  it('flags a signature the authority of which may have changed while it was made', () => {
    const view = toAmendmentView(row(), [{ side: 'EMPLOYER', signedAt: AT, reviewRequired: true }]);
    expect(view.authorityReviewRequired).toBe(true);
  });

  it('is exactly what the published schema accepts, and no more', () => {
    expect(
      amendmentViewSchema.safeParse({ ...toAmendmentView(row()), proposedBy: 'x' }).success,
    ).toBe(false);
  });
});
