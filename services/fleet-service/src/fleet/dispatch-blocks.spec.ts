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
    THIRD_PARTY: [{ policyId, validFrom, validTo }],
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
      PASSENGER_ACCIDENT: [
        {
          policyId: 'INS_PA',
          validFrom: '2026-01-01T00:00:00.000Z',
          validTo: '2027-01-01T00:00:00.000Z',
        },
      ],
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

  describe('recorded windows, one per policy', () => {
    const current = {
      policyId: 'INS_CURRENT',
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2027-01-01T00:00:00.000Z',
    };
    const renewal = {
      policyId: 'INS_RENEWAL',
      validFrom: '2027-01-01T00:00:00.000Z',
      validTo: '2028-01-01T00:00:00.000Z',
    };

    it('keeps the policy in force when a later-ending renewal is recorded ahead of time', () => {
      // The review's case: keeping only the later-ending window hid the
      // current policy, and a delayed lapse of a third policy then blocked a
      // machine that was insured.
      const cover = withRecordedPolicy(
        withRecordedPolicy({}, 'THIRD_PARTY', current, now),
        'THIRD_PARTY',
        renewal,
        now,
      );
      expect(cover.THIRD_PARTY).toHaveLength(2);
      expect(unresolvedLapses(['THIRD_PARTY'], cover, now)).toEqual([]);
    });

    it('gives the same set whichever order two policies arrive in', () => {
      const ab = withRecordedPolicy(
        withRecordedPolicy({}, 'THIRD_PARTY', current, now),
        'THIRD_PARTY',
        renewal,
        now,
      );
      const ba = withRecordedPolicy(
        withRecordedPolicy({}, 'THIRD_PARTY', renewal, now),
        'THIRD_PARTY',
        current,
        now,
      );
      expect(ab).toEqual(ba);
    });

    it('replaces a policy recorded again instead of adding a second window', () => {
      const amended = { ...current, validTo: '2026-12-01T00:00:00.000Z' };
      const cover = withRecordedPolicy(
        withRecordedPolicy({}, 'THIRD_PARTY', current, now),
        'THIRD_PARTY',
        amended,
        now,
      );
      expect(cover.THIRD_PARTY).toEqual([amended]);
    });

    it('drops windows that have already ended, so the column does not grow for ever', () => {
      const ended = {
        policyId: 'INS_OLD',
        validFrom: '2025-01-01T00:00:00.000Z',
        validTo: '2026-01-01T00:00:00.000Z',
      };
      const cover = withRecordedPolicy({ THIRD_PARTY: [ended] }, 'THIRD_PARTY', current, now);
      expect(cover.THIRD_PARTY).toEqual([current]);
      expect(withRecordedPolicy({}, 'THIRD_PARTY', ended, now)).toEqual({});
    });
  });

  it('reads a malformed stored cover as not covered, never as an error', () => {
    expect(parseCover(null)).toEqual({});
    expect(parseCover([])).toEqual({});
    expect(parseCover({ THIRD_PARTY: { policyId: 'INS_1', validFrom: 5 } })).toEqual({});
    expect(parseCover({ THIRD_PARTY: [{ policyId: 'INS_1' }] })).toEqual({});
    expect(unresolvedLapses(['THIRD_PARTY'], parseCover('garbage'), now)).toEqual(['THIRD_PARTY']);
  });

  it('reads a single stored window as a list of one', () => {
    const window = {
      policyId: 'INS_1',
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2027-01-01T00:00:00.000Z',
    };
    expect(parseCover({ THIRD_PARTY: window })).toEqual({ THIRD_PARTY: [window] });
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

    describe('configurable blocking coverages (docs/24 Q-65)', () => {
      const lapsed = { ...clean, insuranceLapsedCoverages: ['PASSENGER_ACCIDENT'] };

      it('blocks on every coverage by default, the behaviour before Q-65', () => {
        expect(activeDispatchBlocks(lapsed, now)).toHaveLength(1);
      });

      it('ignores a lapse of a coverage the configuration does not list', () => {
        const policy = { blockingCoverages: ['THIRD_PARTY'] };
        expect(activeDispatchBlocks(lapsed, now, policy)).toEqual([]);
        expect(
          activeDispatchBlocks(
            { ...clean, insuranceLapsedCoverages: ['THIRD_PARTY'] },
            now,
            policy,
          ),
        ).toHaveLength(1);
      });

      it('still blocks on an UNKNOWN lapse, which might be any coverage', () => {
        const policy = { blockingCoverages: ['THIRD_PARTY'] };
        expect(
          activeDispatchBlocks(
            { ...clean, insuranceLapsedCoverages: [UNKNOWN_COVERAGE] },
            now,
            policy,
          ),
        ).toHaveLength(1);
      });
    });
  });
});
