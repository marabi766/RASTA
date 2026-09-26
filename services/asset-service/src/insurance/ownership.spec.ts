import { assetEnvSchema } from '../config/env';
import {
  DEFAULT_TRANSFER_INSURANCE_POLICY,
  countsForCurrentOwner,
  currentOwnerPolicyFilter,
  everyCoverageFollows,
} from './ownership';

/**
 * docs/24 Q-66, decided by the project owner on 2026-09-25: the insurance
 * follows the vehicle. The list of coverages that follow is configuration.
 */
describe('whether a policy counts for the current owner', () => {
  const narrowed = { coveragesFollowingVehicle: ['THIRD_PARTY'] as const };

  it('counts every policy of an asset that never changed hands', () => {
    expect(
      countsForCurrentOwner({ coverage: 'LIABILITY', ownershipGeneration: 0 }, 0, narrowed),
    ).toBe(true);
  });

  it("counts the previous owner's policy, of any coverage, by default", () => {
    for (const coverage of ['THIRD_PARTY', 'COMPREHENSIVE', 'PASSENGER_ACCIDENT', 'LIABILITY']) {
      expect(
        countsForCurrentOwner(
          { coverage, ownershipGeneration: 0 },
          1,
          DEFAULT_TRANSFER_INSURANCE_POLICY,
        ),
      ).toBe(true);
    }
    // So the query needs no ownership clause at all.
    expect(currentOwnerPolicyFilter(1, DEFAULT_TRANSFER_INSURANCE_POLICY)).toBeUndefined();
  });

  it('counts a coverage left out of a narrowed list only when the current owner recorded it', () => {
    expect(
      countsForCurrentOwner({ coverage: 'THIRD_PARTY', ownershipGeneration: 0 }, 1, narrowed),
    ).toBe(true);
    expect(
      countsForCurrentOwner({ coverage: 'LIABILITY', ownershipGeneration: 0 }, 1, narrowed),
    ).toBe(false);
    expect(
      countsForCurrentOwner({ coverage: 'LIABILITY', ownershipGeneration: 1 }, 1, narrowed),
    ).toBe(true);
    // Two owners back is still not this one.
    expect(
      countsForCurrentOwner({ coverage: 'LIABILITY', ownershipGeneration: 1 }, 2, narrowed),
    ).toBe(false);

    expect(currentOwnerPolicyFilter(2, narrowed)).toEqual({
      OR: [{ coverage: { in: ['THIRD_PARTY'] } }, { ownershipGeneration: 2 }],
    });
  });

  it('asks nothing of the clock: a policy and a transfer in one millisecond are still ordered (round 2 #5)', () => {
    // The previous owner's policy was written in the same millisecond as the
    // transfer. Under the timestamp rule it read as the new owner's; its
    // generation says otherwise.
    const policy = { coverage: 'LIABILITY', ownershipGeneration: 3 };
    expect(countsForCurrentOwner(policy, 4, narrowed)).toBe(false);
  });

  it('detects "every coverage follows" by set, not by length (round 2 #6)', () => {
    const repeated = {
      coveragesFollowingVehicle: ['THIRD_PARTY', 'THIRD_PARTY', 'THIRD_PARTY', 'THIRD_PARTY'],
    } as const;
    expect(everyCoverageFollows(repeated)).toBe(false);
    expect(currentOwnerPolicyFilter(1, repeated)).toEqual({
      OR: [
        { coverage: { in: ['THIRD_PARTY', 'THIRD_PARTY', 'THIRD_PARTY', 'THIRD_PARTY'] } },
        { ownershipGeneration: 1 },
      ],
    });
    // The filter and the per-policy answer agree on an inherited LIABILITY.
    expect(
      countsForCurrentOwner({ coverage: 'LIABILITY', ownershipGeneration: 0 }, 1, repeated),
    ).toBe(false);
    expect(everyCoverageFollows(DEFAULT_TRANSFER_INSURANCE_POLICY)).toBe(true);
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

  it('refuses a coverage listed twice (round 2 #6)', () => {
    expect(() => load('THIRD_PARTY,THIRD_PARTY,THIRD_PARTY,THIRD_PARTY')).toThrow(/more than once/);
  });
});
