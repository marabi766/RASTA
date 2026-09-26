/**
 * Whether an insurance policy counts for the asset's current owner
 * (docs/24 Q-66).
 *
 * The project owner decided on 2026-09-25 that the insurance follows the
 * vehicle: after a transfer, the previous owner's in-force policy counts for
 * the new owner, for every coverage, until its own validTo. Activation, the
 * dossier's active insurance and new claims all ask this one question, so
 * they cannot disagree.
 *
 * Which coverages follow is configuration, `INSURANCE_COVERAGES_FOLLOWING_VEHICLE`,
 * all four by default, so a later legal change narrows it without code
 * (AGENTS.md § 9). A coverage outside the list counts only when the current
 * owner recorded it.
 *
 * "Recorded by the current owner" is a generation, not a time (PR #108 round
 * 2 #5). Each transfer increments `asset.ownership_generation` in its
 * compare-and-set, under the asset's row lock; a policy write takes the same
 * lock and stamps the generation it read. Two timestamps can round to the same
 * millisecond; two generations cannot be equal unless no transfer came between.
 */

/** The coverages asset-service records (its `InsuranceCoverage` enum). */
export const INSURANCE_COVERAGES = [
  'THIRD_PARTY',
  'COMPREHENSIVE',
  'PASSENGER_ACCIDENT',
  'LIABILITY',
] as const;

export type InsuranceCoverage = (typeof INSURANCE_COVERAGES)[number];

export interface TransferInsurancePolicy {
  /** Coverages whose policy keeps counting for the owner after a transfer. */
  readonly coveragesFollowingVehicle: readonly InsuranceCoverage[];
}

/** The project owner's decision: every coverage follows the vehicle. */
export const DEFAULT_TRANSFER_INSURANCE_POLICY: TransferInsurancePolicy = {
  coveragesFollowingVehicle: INSURANCE_COVERAGES,
};

/** Nest injection token for the {@link TransferInsurancePolicy}. */
export const TRANSFER_INSURANCE_POLICY = Symbol('TRANSFER_INSURANCE_POLICY');

/**
 * `assetGeneration` is the asset's current `ownershipGeneration`. A policy
 * stamped with it was recorded by the current owner; one stamped lower, by an
 * earlier one.
 */
export function countsForCurrentOwner(
  policy: { coverage: string; ownershipGeneration: number },
  assetGeneration: number,
  rule: TransferInsurancePolicy,
): boolean {
  if ((rule.coveragesFollowingVehicle as readonly string[]).includes(policy.coverage)) {
    return true;
  }
  return policy.ownershipGeneration === assetGeneration;
}

/**
 * The same rule as a query filter, for "the active policy that counts".
 * `undefined` when every coverage follows the vehicle, so the query carries no
 * extra clause.
 */
export function currentOwnerPolicyFilter(
  assetGeneration: number,
  rule: TransferInsurancePolicy,
): { OR: object[] } | undefined {
  if (everyCoverageFollows(rule)) return undefined;
  return {
    OR: [
      { coverage: { in: [...rule.coveragesFollowingVehicle] } },
      { ownershipGeneration: assetGeneration },
    ],
  };
}

/**
 * Set equality with every coverage, not a length comparison: a list with a
 * repeated entry would otherwise pass for "all four" (PR #108 round 2 #6).
 * The configuration also refuses duplicates; this does not rely on it.
 */
export function everyCoverageFollows(rule: TransferInsurancePolicy): boolean {
  const following = new Set<string>(rule.coveragesFollowingVehicle);
  return INSURANCE_COVERAGES.every((coverage) => following.has(coverage));
}
