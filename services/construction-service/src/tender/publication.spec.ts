import { PUBLICATION_REFUSALS, publicationRefusals, type PublicationFacts } from './publication';

/**
 * When a DRAFT tender may be published (ADR-065 § 1, docs/08 § 8.3): a pure rule,
 * proven on its own. The database clock is an argument here, so the deadline is
 * tested without a clock (ADR-065 § 2).
 */

const NOW = new Date('2026-10-15T09:00:00.000Z');

const READY: PublicationFacts = {
  procurementNature: 'FORMAL_TENDER',
  visibility: 'PUBLIC',
  bidOpeningAt: new Date('2026-10-20T08:00:00.000Z'),
  bidClosingAt: new Date('2026-11-20T08:00:00.000Z'),
  now: NOW,
  minBiddingPeriodSeconds: 0,
  criteriaCount: 3,
  totalWeightBp: 10_000,
  invitationCount: 0,
  approval: 'GRANTED',
};

const refusals = (overrides: Partial<PublicationFacts>) =>
  publicationRefusals({ ...READY, ...overrides });

describe('publicationRefusals', () => {
  it('has nothing to say about a complete public tender', () => {
    expect(publicationRefusals(READY)).toEqual([]);
  });

  it('fails closed on the approval gate: no policy, or a policy nobody has satisfied', () => {
    expect(refusals({ approval: 'NO_POLICY' })).toEqual(['APPROVAL_POLICY_REQUIRED']);
    expect(refusals({ approval: 'NOT_GRANTED' })).toEqual(['APPROVAL_REQUIRED']);
    expect(refusals({ approval: 'GRANTED' })).toEqual([]);
  });

  it('never defaults the nature or the visibility', () => {
    expect(refusals({ procurementNature: null })).toEqual(['NATURE_REQUIRED']);
    expect(refusals({ visibility: null })).toEqual(['VISIBILITY_REQUIRED']);
  });

  it('needs a window, both ends of it', () => {
    expect(refusals({ bidOpeningAt: null, bidClosingAt: null })).toEqual(['WINDOW_REQUIRED']);
    expect(refusals({ bidOpeningAt: null })).toEqual(['WINDOW_REQUIRED']);
    expect(refusals({ bidClosingAt: null })).toEqual(['WINDOW_REQUIRED']);
  });

  it('refuses a window that has already closed, judged at the instant given', () => {
    const closing = READY.bidClosingAt!;
    const justBefore = new Date(closing.getTime() - 1);
    expect(refusals({ now: justBefore })).toEqual([]);
    // Half-open, like the deadline itself: closing at this very instant is closed.
    expect(refusals({ now: closing })).toEqual(['WINDOW_ALREADY_CLOSED']);
    expect(refusals({ now: new Date(closing.getTime() + 1) })).toEqual(['WINDOW_ALREADY_CLOSED']);
  });

  it('accepts a window that has opened but not closed', () => {
    expect(refusals({ now: new Date('2026-10-25T00:00:00.000Z') })).toEqual([]);
  });

  it('enforces the configured minimum period, and only that: none by default', () => {
    const period = READY.bidClosingAt!.getTime() - READY.bidOpeningAt!.getTime();
    expect(refusals({ minBiddingPeriodSeconds: 0 })).toEqual([]);
    expect(refusals({ minBiddingPeriodSeconds: period / 1000 })).toEqual([]);
    expect(refusals({ minBiddingPeriodSeconds: period / 1000 + 1 })).toEqual(['WINDOW_TOO_SHORT']);
  });

  it('needs criteria, and weights that sum to exactly 10000 basis points', () => {
    expect(refusals({ criteriaCount: 0, totalWeightBp: 0 })).toEqual(['CRITERIA_REQUIRED']);
    expect(refusals({ totalWeightBp: 9_999 })).toEqual(['CRITERIA_WEIGHTS_INCOMPLETE']);
    expect(refusals({ totalWeightBp: 10_001 })).toEqual(['CRITERIA_WEIGHTS_INCOMPLETE']);
  });

  it('needs at least one invitation for a restricted tender, and asks nothing of a public one', () => {
    expect(refusals({ visibility: 'RESTRICTED', invitationCount: 0 })).toEqual([
      'INVITATION_REQUIRED',
    ]);
    expect(refusals({ visibility: 'RESTRICTED', invitationCount: 1 })).toEqual([]);
    expect(refusals({ visibility: 'PUBLIC', invitationCount: 0 })).toEqual([]);
  });

  it('reports every reason at once, in a fixed order', () => {
    expect(
      publicationRefusals({
        ...READY,
        procurementNature: null,
        visibility: 'RESTRICTED',
        bidOpeningAt: null,
        bidClosingAt: null,
        criteriaCount: 2,
        totalWeightBp: 5_000,
        invitationCount: 0,
      }),
    ).toEqual([
      'NATURE_REQUIRED',
      'WINDOW_REQUIRED',
      'CRITERIA_WEIGHTS_INCOMPLETE',
      'INVITATION_REQUIRED',
    ]);
  });

  it('only ever names codes from the closed set', () => {
    const everything = publicationRefusals({
      procurementNature: null,
      visibility: null,
      bidOpeningAt: new Date('2026-11-20T08:00:00.000Z'),
      bidClosingAt: new Date('2026-10-01T08:00:00.000Z'),
      now: NOW,
      minBiddingPeriodSeconds: 999_999,
      criteriaCount: 0,
      totalWeightBp: 0,
      invitationCount: 0,
      approval: 'NO_POLICY',
    });
    expect(everything.length).toBeGreaterThan(0);
    for (const code of everything) expect(PUBLICATION_REFUSALS).toContain(code);
  });
});
