import {
  UNKNOWN_COVERAGE,
  activeDispatchBlocks,
  parseCover,
  unresolvedLapses,
  withRecordedPolicy,
  type InsuranceCover,
} from './dispatch-blocks';

/**
 * The rule that decides whether a machine may be dispatched (L3-02). Each case
 * here is a real ordering of asset-service events, not a synthetic one.
 */
describe('dispatch blocks', () => {
  const now = new Date('2026-09-25T12:00:00.000Z');
  const thirdParty = (validFrom: string, validTo: string, policyId = 'INS_NEW') => ({
    THIRD_PARTY: { policyId, validFrom, validTo },
  });
  const clean = { inspectionBlockedReason: null, insuranceLapsedCoverages: [], insuranceCover: {} };

  it('blocks on a lapse no recorded policy answers', () => {
    expect(unresolvedLapses(['THIRD_PARTY'], {}, now)).toEqual(['THIRD_PARTY']);
  });

  it('does not block when the renewal was recorded before the old policy lapsed', () => {
    // The normal order: renewed in advance, then the sweep expires the old
    // policy weeks later. A stored flag would block this machine for good.
    const cover = thirdParty('2026-09-01T00:00:00.000Z', '2027-09-01T00:00:00.000Z');
    expect(unresolvedLapses(['THIRD_PARTY'], cover, now)).toEqual([]);
  });

  it('keeps blocking until a future-dated renewal starts, then stops', () => {
    const cover = thirdParty('2026-10-01T00:00:00.000Z', '2027-10-01T00:00:00.000Z');
    expect(unresolvedLapses(['THIRD_PARTY'], cover, now)).toEqual(['THIRD_PARTY']);
    expect(unresolvedLapses(['THIRD_PARTY'], cover, new Date('2026-10-01T00:00:00.000Z'))).toEqual(
      [],
    );
  });

  it('blocks again once the renewal itself has run out, even before its own lapse arrives', () => {
    const cover = thirdParty('2025-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    expect(unresolvedLapses(['THIRD_PARTY'], cover, now)).toEqual(['THIRD_PARTY']);
  });

  it('does not let one coverage answer the lapse of another', () => {
    const cover: InsuranceCover = {
      PASSENGER_ACCIDENT: {
        policyId: 'INS_PA',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2027-01-01T00:00:00.000Z',
      },
    };
    expect(unresolvedLapses(['THIRD_PARTY'], cover, now)).toEqual(['THIRD_PARTY']);
  });

  it('answers an UNKNOWN lapse with any policy in force, and nothing else', () => {
    const inForce = thirdParty('2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
    const expired = thirdParty('2025-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    expect(unresolvedLapses([UNKNOWN_COVERAGE], inForce, now)).toEqual([]);
    expect(unresolvedLapses([UNKNOWN_COVERAGE], expired, now)).toEqual([UNKNOWN_COVERAGE]);
    expect(unresolvedLapses([UNKNOWN_COVERAGE], {}, now)).toEqual([UNKNOWN_COVERAGE]);
  });

  it('keeps the later-ending window whichever order two policies arrive in', () => {
    const early = {
      policyId: 'INS_A',
      validFrom: '2025-09-01T00:00:00Z',
      validTo: '2026-09-01T00:00:00Z',
    };
    const late = {
      policyId: 'INS_B',
      validFrom: '2026-09-01T00:00:00Z',
      validTo: '2027-09-01T00:00:00Z',
    };
    const ab = withRecordedPolicy(
      withRecordedPolicy({}, 'THIRD_PARTY', early),
      'THIRD_PARTY',
      late,
    );
    const ba = withRecordedPolicy(
      withRecordedPolicy({}, 'THIRD_PARTY', late),
      'THIRD_PARTY',
      early,
    );
    expect(ab.THIRD_PARTY).toEqual(late);
    expect(ba.THIRD_PARTY).toEqual(late);
  });

  it('reads a malformed stored cover as not covered, never as an error', () => {
    expect(parseCover(null)).toEqual({});
    expect(parseCover([])).toEqual({});
    expect(parseCover({ THIRD_PARTY: { policyId: 'INS_1', validFrom: 5 } })).toEqual({});
    expect(unresolvedLapses(['THIRD_PARTY'], parseCover('garbage'), now)).toEqual(['THIRD_PARTY']);
  });

  describe('activeDispatchBlocks', () => {
    it('reports nothing for a clean machine', () => {
      expect(activeDispatchBlocks(clean, now)).toEqual([]);
    });

    it('reports each cause separately, never merged', () => {
      expect(
        activeDispatchBlocks(
          {
            inspectionBlockedReason: 'The most recent technical inspection failed',
            insuranceLapsedCoverages: ['THIRD_PARTY', 'COMPREHENSIVE'],
            insuranceCover: {},
          },
          now,
        ),
      ).toEqual([
        { cause: 'INSPECTION', detail: 'The most recent technical inspection failed' },
        {
          cause: 'INSURANCE',
          detail: 'The insurance policy has expired (COMPREHENSIVE, THIRD_PARTY)',
        },
      ]);
    });

    it('names only the coverages still unanswered', () => {
      const blocks = activeDispatchBlocks(
        {
          ...clean,
          insuranceLapsedCoverages: ['THIRD_PARTY', 'COMPREHENSIVE'],
          insuranceCover: thirdParty('2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'),
        },
        now,
      );
      expect(blocks).toEqual([
        { cause: 'INSURANCE', detail: 'The insurance policy has expired (COMPREHENSIVE)' },
      ]);
    });
  });
});
