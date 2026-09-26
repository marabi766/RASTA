/**
 * Records the reward evaluation cutover if none is recorded yet, and returns
 * the one in force (ADR-061 § 4.2).
 *
 * For development and test databases only. In production the operator records
 * the cutover once the old reward consumers are drained
 * (docs/runbooks/reward-evaluation-cutover.md); the seed that calls this runs
 * behind the demo-seed guard and never there. On a freshly migrated database
 * nothing was consumed before now, so now is a correct cutover. Without one the
 * reward consumer fails closed, and rewards would silently never work in
 * development.
 *
 * Never moves an existing cutover: a second run leaves it exactly as it is,
 * and the database refuses a backward move anyway.
 */
export async function recordCutoverIfMissing(
  store: CutoverStore,
  at: Date,
): Promise<{ cutoverAt: Date; recorded: boolean }> {
  const { count } = await store.rewardEvaluationCutover.createMany({
    data: [{ singleton: true, cutoverAt: at }],
    skipDuplicates: true,
  });
  const row = await store.rewardEvaluationCutover.findUniqueOrThrow({
    where: { singleton: true },
  });
  return { cutoverAt: row.cutoverAt, recorded: count === 1 };
}

/** The one table this touches, so the seed's client and the service's both fit. */
export interface CutoverStore {
  rewardEvaluationCutover: {
    createMany(args: {
      data: { singleton: boolean; cutoverAt: Date }[];
      skipDuplicates: boolean;
    }): PromiseLike<{ count: number }>;
    findUniqueOrThrow(args: { where: { singleton: boolean } }): PromiseLike<{ cutoverAt: Date }>;
  };
}
