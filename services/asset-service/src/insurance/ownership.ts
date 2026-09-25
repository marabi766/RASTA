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
 * owner recorded it: its `createdAt` is at or after the latest transfer.
 *
 * Both instants come from one clock, PostgreSQL's (PR #108 review #6):
 * `created_at` defaults to the database's `now()`, and a transfer's
 * `transferred_at` is the database's `clock_timestamp()`, read under the
 * asset's row lock (AssetRepository.databaseClock). Policy writes take the
 * same lock and re-check the owner, so a policy is either recorded before the
 * transfer takes the lock, under the old owner, or refused.
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
 * `ownedSince` is the latest transfer's instant, or `null` when the asset has
 * never changed hands, in which case every policy is its owner's.
 */
export function countsForCurrentOwner(
  policy: { coverage: string; createdAt: Date },
  ownedSince: Date | null,
  rule: TransferInsurancePolicy,
): boolean {
  if (!ownedSince) return true;
  if ((rule.coveragesFollowingVehicle as readonly string[]).includes(policy.coverage)) {
    return true;
  }
  return policy.createdAt >= ownedSince;
}

/**
 * The same rule as a query filter, for "the active policy that counts".
 * `undefined` when every policy counts, so the query carries no extra clause.
 */
export function currentOwnerPolicyFilter(
  ownedSince: Date | null,
  rule: TransferInsurancePolicy,
): { OR: object[] } | undefined {
  if (!ownedSince) return undefined;
  if (rule.coveragesFollowingVehicle.length === INSURANCE_COVERAGES.length) return undefined;
  return {
    OR: [
      { coverage: { in: [...rule.coveragesFollowingVehicle] } },
      { createdAt: { gte: ownedSince } },
    ],
  };
}
