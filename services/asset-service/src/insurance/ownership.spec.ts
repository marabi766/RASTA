import { assetEnvSchema } from '../config/env';
import {
  DEFAULT_TRANSFER_INSURANCE_POLICY,
  countsForCurrentOwner,
  currentOwnerPolicyFilter,
} from './ownership';

/**
 * docs/24 Q-66, decided by the project owner on 2026-09-25: the insurance
 * follows the vehicle. The list of coverages that follow is configuration.
 */
describe('whether a policy counts for the current owner', () => {
  const transferredAt = new Date('2026-09-01T10:00:00.000Z');
  const before = new Date('2026-08-01T00:00:00.000Z');
  const after = new Date('2026-09-02T00:00:00.000Z');
  const narrowed = { coveragesFollowingVehicle: ['THIRD_PARTY'] as const };

  it('counts every policy of an asset that never changed hands', () => {
    expect(
      countsForCurrentOwner({ coverage: 'LIABILITY', createdAt: before }, null, narrowed),
    ).toBe(true);
    expect(currentOwnerPolicyFilter(null, narrowed)).toBeUndefined();
  });

  it("counts the previous owner's policy, of any coverage, by default", () => {
    for (const coverage of ['THIRD_PARTY', 'COMPREHENSIVE', 'PASSENGER_ACCIDENT', 'LIABILITY']) {
      expect(
        countsForCurrentOwner(
          { coverage, createdAt: before },
          transferredAt,
          DEFAULT_TRANSFER_INSURANCE_POLICY,
        ),
      ).toBe(true);
    }
    // So the query needs no ownership clause at all.
    expect(
      currentOwnerPolicyFilter(transferredAt, DEFAULT_TRANSFER_INSURANCE_POLICY),
    ).toBeUndefined();
  });

  it('counts a coverage left out of a narrowed list only when the current owner recorded it', () => {
    expect(
      countsForCurrentOwner(
        { coverage: 'THIRD_PARTY', createdAt: before },
        transferredAt,
        narrowed,
      ),
    ).toBe(true);
    expect(
      countsForCurrentOwner({ coverage: 'LIABILITY', createdAt: before }, transferredAt, narrowed),
    ).toBe(false);
    expect(
      countsForCurrentOwner({ coverage: 'LIABILITY', createdAt: after }, transferredAt, narrowed),
    ).toBe(true);
    // Recorded at the very instant of the transfer: the current owner's, as
    // the database clock orders a policy write against the transfer's lock.
    expect(
      countsForCurrentOwner(
        { coverage: 'LIABILITY', createdAt: transferredAt },
        transferredAt,
        narrowed,
      ),
    ).toBe(true);

    expect(currentOwnerPolicyFilter(transferredAt, narrowed)).toEqual({
      OR: [{ coverage: { in: ['THIRD_PARTY'] } }, { createdAt: { gte: transferredAt } }],
    });
  });
});

describe('INSURANCE_COVERAGES_FOLLOWING_VEHICLE', () => {
  const field = assetEnvSchema.shape.INSURANCE_COVERAGES_FOLLOWING_VEHICLE;
  const load = (value?: string) => field.parse(value);

  it("defaults to every coverage, the project owner's decision", () => {
    expect(load()).toEqual(['THIRD_PARTY', 'COMPREHENSIVE', 'PASSENGER_ACCIDENT', 'LIABILITY']);
  });

  it('narrows to a list, or to none', () => {
    expect(load(' THIRD_PARTY , LIABILITY ')).toEqual(['THIRD_PARTY', 'LIABILITY']);
    expect(load('')).toEqual([]);
  });

  it('refuses a coverage that does not exist', () => {
    expect(() => load('THIRD_PARTY,BODY')).toThrow();
  });
});
