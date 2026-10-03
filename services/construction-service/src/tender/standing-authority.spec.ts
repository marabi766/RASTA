import { standingWindowReport, verdictOf } from './standing-authority';

/**
 * The detective control after an award (ADR-067 § 3, residual): what supplier-service's standing
 * says about the window that starts at the instant the pre-check read it. Conservative on purpose.
 */

const FROM = new Date('2026-10-03T08:00:00.000Z');
const APPROVED = '2026-01-01T00:00:00.000Z';

const episode = (suspensionId: string, suspendedAt: string, reinstatedAt: string | null) => ({
  suspensionId,
  suspendedAt,
  reinstatedAt,
});

describe('standingWindowReport', () => {
  it('is clear for a contractor with no suspension and its qualification', () => {
    expect(
      standingWindowReport({ contractingApprovedAt: APPROVED, suspensions: [] }, FROM),
    ).toEqual({
      suspensionIds: [],
      suspensionCount: 0,
      qualificationRemoved: false,
    });
  });

  it('is clear for a suspension that began and ended before the window: the pre-check saw it', () => {
    const report = standingWindowReport(
      {
        contractingApprovedAt: APPROVED,
        suspensions: [episode('SUS_OLD', '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z')],
      },
      FROM,
    );
    expect(report.suspensionCount).toBe(0);
  });

  it('counts a suspension that began inside the window, open or already ended', () => {
    const report = standingWindowReport(
      {
        contractingApprovedAt: APPROVED,
        suspensions: [
          episode('SUS_B', '2026-10-03T08:00:00.500Z', null),
          episode('SUS_A', '2026-10-03T08:00:01.000Z', '2026-10-03T08:00:02.000Z'),
        ],
      },
      FROM,
    );
    expect(report).toEqual({
      suspensionIds: ['SUS_A', 'SUS_B'],
      suspensionCount: 2,
      qualificationRemoved: false,
    });
  });

  it('counts a suspension that began exactly at the start of the window (conservative)', () => {
    const report = standingWindowReport(
      {
        contractingApprovedAt: APPROVED,
        suspensions: [episode('SUS_EQ', FROM.toISOString(), FROM.toISOString())],
      },
      FROM,
    );
    expect(report.suspensionCount).toBe(1);
  });

  it('counts a suspension still open, however old: the pre-check would have refused it', () => {
    const report = standingWindowReport(
      {
        contractingApprovedAt: APPROVED,
        suspensions: [episode('SUS_OPEN', '2026-08-01T00:00:00.000Z', null)],
      },
      FROM,
    );
    expect(report.suspensionIds).toEqual(['SUS_OPEN']);
    expect(
      verdictOf({
        contractingApprovedAt: APPROVED,
        suspensions: [episode('SUS_OPEN', '2026-08-01T00:00:00.000Z', null)],
      }),
    ).toBe('SUSPENDED');
  });

  it('says the qualification is gone when it is no longer approved', () => {
    expect(
      standingWindowReport({ contractingApprovedAt: null, suspensions: [] }, FROM),
    ).toMatchObject({ qualificationRemoved: true, suspensionCount: 0 });
  });

  it('names at most 20 suspensions and counts them all', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      episode(`SUS_${String(i).padStart(2, '0')}`, '2026-10-03T09:00:00.000Z', null),
    );
    const report = standingWindowReport(
      { contractingApprovedAt: APPROVED, suspensions: many },
      FROM,
    );
    expect(report.suspensionIds).toHaveLength(20);
    expect(report.suspensionCount).toBe(25);
  });
});
