/**
 * The safety blocks that keep a machine off the dispatch list, and the one
 * rule that decides whether they currently hold (L3-02).
 *
 * There are two independent causes and they never share a field:
 *
 *   **Inspection.** `INSPECTION_FAILED` sets it; `MAINTENANCE_COMPLETED`
 *   clears it. Nothing about insurance touches it.
 *
 *   **Insurance.** Kept per coverage type, because asset-service records four
 *   (`THIRD_PARTY`, `COMPREHENSIVE`, `PASSENGER_ACCIDENT`, `LIABILITY`) and a
 *   renewal of one says nothing about another. `INSURANCE_EXPIRED` adds the
 *   lapsed coverage to a set; only an `INSURANCE_RECORDED` policy of the same
 *   coverage, valid now, resolves it. Which coverages ought to gate dispatch
 *   at all is a business rule nobody has stated — docs/24 **Q-64**; until it
 *   is answered every lapse blocks, exactly as before this change.
 *
 * The insurance answer is worked out when it is asked, not stored, because
 * the event that ends a lapse does not always arrive after it. A policy is
 * normally renewed *before* the old one runs out: the new policy's
 * `INSURANCE_RECORDED` comes first, the old one's `INSURANCE_EXPIRED` weeks
 * later. A stored flag would block that machine for good on the day its
 * cover changed hands; a window read at dispatch time sees the new policy and
 * does not. The same read makes a renewal that starts next week count from
 * next week, rather than from the moment it was typed in.
 */

/** A lapse whose coverage the event did not say — only from producers that predate Q-64. */
export const UNKNOWN_COVERAGE = 'UNKNOWN';

/** One recorded policy's validity, as `INSURANCE_RECORDED` carried it. */
// A type alias rather than an interface: it is written to a JSON column, and
// only an alias satisfies Prisma's JSON input type.
export type CoverWindow = {
  policyId: string;
  validFrom: string;
  validTo: string;
};

/** The latest-ending recorded window per coverage type. */
export type InsuranceCover = Record<string, CoverWindow>;

export const INSPECTION_BLOCK_REASON = 'The most recent technical inspection failed';

/**
 * Reads the stored JSON back into a cover map.
 *
 * Defensive rather than asserted: the column is written only by this service,
 * but a malformed entry must read as "not covered" — the answer that keeps a
 * machine off the road — and never as a thrown error that takes the whole
 * availability listing down with it.
 */
export function parseCover(value: unknown): InsuranceCover {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const cover: InsuranceCover = {};
  for (const [coverage, window] of Object.entries(value as Record<string, unknown>)) {
    if (!window || typeof window !== 'object') continue;
    const { policyId, validFrom, validTo } = window as Record<string, unknown>;
    if (typeof policyId !== 'string' || typeof validFrom !== 'string') continue;
    if (typeof validTo !== 'string') continue;
    cover[coverage] = { policyId, validFrom, validTo };
  }
  return cover;
}

/**
 * Adds a recorded policy to the map, keeping the later-ending window per
 * coverage. Order-independent on purpose: two policies of one coverage can
 * arrive in either order, and the answer must not depend on which came last.
 */
export function withRecordedPolicy(
  cover: InsuranceCover,
  coverage: string,
  window: CoverWindow,
): InsuranceCover {
  const current = cover[coverage];
  if (current && Date.parse(current.validTo) >= Date.parse(window.validTo)) return cover;
  return { ...cover, [coverage]: window };
}

/** Whether a window is in force at `now`: started, and not yet ended. */
export function isInForce(window: CoverWindow | undefined, now: Date): boolean {
  if (!window) return false;
  const from = Date.parse(window.validFrom);
  const to = Date.parse(window.validTo);
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  return from <= now.getTime() && now.getTime() < to;
}

/**
 * The lapsed coverages that no recorded policy currently answers.
 *
 * `UNKNOWN` is answered by a policy of any coverage in force: it only exists
 * for lapses recorded before the producer said which coverage lapsed, and a
 * rule that nothing could ever satisfy would strand those machines with no
 * way back short of editing the database (Q-64 records the trade-off).
 */
export function unresolvedLapses(
  lapsed: readonly string[],
  cover: InsuranceCover,
  now: Date,
): string[] {
  const anyInForce = Object.values(cover).some((window) => isInForce(window, now));
  return [...new Set(lapsed)].filter((coverage) =>
    coverage === UNKNOWN_COVERAGE ? !anyInForce : !isInForce(cover[coverage], now),
  );
}

/** The replica fields the two causes live in. */
export interface DispatchBlockFields {
  inspectionBlockedReason: string | null;
  insuranceLapsedCoverages: readonly string[];
  insuranceCover: unknown;
}

/** One reason a machine may not be dispatched, one entry per cause. */
export interface DispatchBlock {
  cause: 'INSPECTION' | 'INSURANCE';
  detail: string;
}

/**
 * Every safety block in force for a machine at `now`, one per cause — never
 * merged into one, so a caller that lists them names each fact that has to
 * change.
 */
export function activeDispatchBlocks(asset: DispatchBlockFields, now: Date): DispatchBlock[] {
  const blocks: DispatchBlock[] = [];
  if (asset.inspectionBlockedReason) {
    blocks.push({ cause: 'INSPECTION', detail: asset.inspectionBlockedReason });
  }
  const lapses = unresolvedLapses(
    asset.insuranceLapsedCoverages,
    parseCover(asset.insuranceCover),
    now,
  );
  if (lapses.length > 0) {
    blocks.push({
      cause: 'INSURANCE',
      detail: `The insurance policy has expired (${lapses.sort().join(', ')})`,
    });
  }
  return blocks;
}
