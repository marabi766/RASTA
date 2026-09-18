import { ulid } from 'ulid';
import { bandFor, dedupeKeyFor, EXPIRY_BANDS_DAYS } from './dedupe';
import { INSURANCE_EXPIRING_RULE } from './rules';

describe('expiry banding', () => {
  it('uses the documented five bands', () => {
    // ADR-054 § 3 names the ladder; a change here is a change to how many
    // reminders a person gets and belongs in the ADR first.
    expect([...EXPIRY_BANDS_DAYS]).toEqual([30, 14, 7, 3, 1]);
  });

  it.each([
    [30, 30],
    [29, 30],
    [15, 30],
    [14, 14],
    [10, 14],
    [8, 14],
    [7, 7],
    [4, 7],
    [3, 3],
    [2, 3],
    [1, 1],
    [0, 1],
    [-2, 1],
  ])('maps %i days remaining to the %i-day band', (days, band) => {
    expect(bandFor(days)).toBe(band);
  });

  it('folds anything past the widest band into it', () => {
    // An operator who raises EXPIRY_WARNING_DAYS to 60 gets one reminder for
    // the 60→30 stretch, not thirty of them.
    expect(bandFor(45)).toBe(30);
    expect(bandFor(365)).toBe(30);
  });

  it('accepts bands in any order and refuses none at all', () => {
    expect(bandFor(5, [1, 30, 7])).toBe(7);
    expect(() => bandFor(5, [])).toThrow(/at least one band/);
  });
});

describe('semantic dedupe key', () => {
  const base = {
    organizationId: 'ORG_A',
    ruleKey: 'insurance.expiring',
    subjectType: 'InsurancePolicy',
    subjectId: 'POL_1',
    bucket: 'band:30',
  };

  it('is a 64-hex SHA-256 of the fact, and deterministic', () => {
    const key = dedupeKeyFor(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(dedupeKeyFor({ ...base })).toBe(key);
  });

  it('changes when any part of the fact changes, and only then', () => {
    const key = dedupeKeyFor(base);
    expect(dedupeKeyFor({ ...base, organizationId: 'ORG_B' })).not.toBe(key);
    expect(dedupeKeyFor({ ...base, ruleKey: 'inspection.expiring' })).not.toBe(key);
    expect(dedupeKeyFor({ ...base, subjectType: 'TechnicalInspection' })).not.toBe(key);
    expect(dedupeKeyFor({ ...base, subjectId: 'POL_2' })).not.toBe(key);
    expect(dedupeKeyFor({ ...base, bucket: 'band:14' })).not.toBe(key);
  });

  it('is content-based: the event id plays no part', () => {
    // The whole point of layer 2. Two distinct events describing the same fact
    // produce the same key, because the key never sees the event.
    const first = dedupeKeyFor(base);
    const second = dedupeKeyFor(base);
    expect(first).toBe(second);
  });

  it('refuses an empty part or one containing the separator', () => {
    expect(() => dedupeKeyFor({ ...base, subjectId: '' })).toThrow(/subjectId/);
    expect(() => dedupeKeyFor({ ...base, bucket: 'a|b' })).toThrow(/bucket/);
  });
});

describe('the 120-emission regression (ADR-054 § Context)', () => {
  it('collapses a 30-day sweep at four emissions a day into at most five keys', () => {
    // The producer's arithmetic: EXPIRY_WARNING_DAYS = 30, sweep every six
    // hours. Each emission is a fresh event id; `daysRemaining` is what the
    // payload carries. Distinct keys are what become notifications.
    const organizationId = 'ORG_SWEEP';
    const policyId = 'POL_SWEEP';
    const keys = new Set<string>();
    const eventIds = new Set<string>();

    for (let hour = 0; hour < 30 * 24; hour += 6) {
      const daysRemaining = 30 - Math.floor(hour / 24);
      eventIds.add(ulid());
      const payload = {
        assetId: 'AST_1',
        organizationId,
        policyId,
        insurerName: 'Insurer',
        validTo: '2026-10-17T00:00:00.000Z',
        daysRemaining,
      };
      keys.add(
        dedupeKeyFor({
          organizationId,
          ruleKey: INSURANCE_EXPIRING_RULE.ruleKey,
          subjectType: INSURANCE_EXPIRING_RULE.subjectType,
          subjectId: INSURANCE_EXPIRING_RULE.subjectId(payload),
          bucket: INSURANCE_EXPIRING_RULE.dedupeBucket(payload),
        }),
      );
    }

    expect(eventIds.size).toBe(120);
    expect(keys.size).toBeLessThanOrEqual(5);
    expect(keys.size).toBe(5);
  });

  it('keeps two policies apart even inside the same band', () => {
    const payload = (policyId: string) => ({
      assetId: 'AST_1',
      organizationId: 'ORG_X',
      policyId,
      insurerName: 'Insurer',
      validTo: '2026-10-17T00:00:00.000Z',
      daysRemaining: 20,
    });
    const keyFor = (policyId: string) =>
      dedupeKeyFor({
        organizationId: 'ORG_X',
        ruleKey: INSURANCE_EXPIRING_RULE.ruleKey,
        subjectType: INSURANCE_EXPIRING_RULE.subjectType,
        subjectId: INSURANCE_EXPIRING_RULE.subjectId(payload(policyId)),
        bucket: INSURANCE_EXPIRING_RULE.dedupeBucket(payload(policyId)),
      });

    expect(keyFor('POL_A')).not.toBe(keyFor('POL_B'));
  });
});
