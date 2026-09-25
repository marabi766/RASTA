/**
 * The safety blocks that keep a machine off the dispatch list, and the one
 * rule that decides whether they currently hold (L3-02).
 *
 * There are two independent causes and they never share a field:
 *
 *   **Inspection.** `INSPECTION_FAILED` sets it; `MAINTENANCE_COMPLETED`
 *   clears it, but only a repair completed *after* the failure it would clear.
 *   Both sides are dated by the event's `occurredAt`, not by when fleet
 *   happened to consume it, so a completion that arrives late cannot undo a
 *   newer failure. Nothing about insurance touches it.
 *
 *   **Insurance.** Kept per coverage type, because asset-service records four
 *   (`THIRD_PARTY`, `COMPREHENSIVE`, `PASSENGER_ACCIDENT`, `LIABILITY`) and a
 *   renewal of one says nothing about another. `INSURANCE_EXPIRED` adds the
 *   lapsed coverage to a set; only an `INSURANCE_RECORDED` policy of the same
 *   coverage, valid now, resolves it. Which coverages ought to gate dispatch
 *   at all is a business rule nobody has stated — docs/24 **Q-65** — so it is
 *   configuration (`FLEET_DISPATCH_BLOCKING_COVERAGES`, AGENTS.md § 9). The
 *   default is all four, which is how it behaved before this change.
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

/** A lapse whose coverage the event did not say — only from producers that predate Q-65. */
export const UNKNOWN_COVERAGE = 'UNKNOWN';

/** One recorded policy's validity, as `INSURANCE_RECORDED` carried it. */
// A type alias rather than an interface: it is written to a JSON column, and
// only an alias satisfies Prisma's JSON input type.
export type CoverWindow = {
  policyId: string;
  validFrom: string;
  validTo: string;
};

/**
 * Every recorded window per coverage type, one per policy.
 *
 * All of them, not only the latest-ending one. A renewal recorded ahead of
 * time ends later than the current policy but has not started yet; keeping
 * only the later window would hide the policy that is in force today.
 */
export type InsuranceCover = Record<string, CoverWindow[]>;

/** The coverages asset-service records (its `InsuranceCoverage` enum). */
export const INSURANCE_COVERAGES = [
  'THIRD_PARTY',
  'COMPREHENSIVE',
  'PASSENGER_ACCIDENT',
  'LIABILITY',
] as const;

/**
 * Which lapses keep a machine off the road (docs/24 Q-65).
 *
 * Injected, not a constant: the answer is a regulatory fact the repository
 * does not state. The default, every coverage, is the behaviour before Q-65.
 * `UNKNOWN` lapses block whatever this says, because nobody knows which
 * coverage they were.
 */
export interface DispatchPolicy {
  readonly blockingCoverages: readonly string[];
}

export const DEFAULT_DISPATCH_POLICY: DispatchPolicy = {
  blockingCoverages: INSURANCE_COVERAGES,
};

/** Nest injection token for the {@link DispatchPolicy}. */
export const DISPATCH_POLICY = Symbol('DISPATCH_POLICY');

export const INSPECTION_BLOCK_REASON = 'The most recent technical inspection failed';

/**
 * Reads the stored JSON back into a cover map.
 *
 * Defensive rather than asserted: the column is written only by this service,
 * but a malformed entry must read as "not covered" — the answer that keeps a
 * machine off the road — and never as a thrown error that takes the whole
 * availability listing down with it. A single window object, the shape an
 * earlier draft of this change wrote, reads as a list of one.
 */
export function parseCover(value: unknown): InsuranceCover {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const cover: InsuranceCover = {};
  for (const [coverage, entry] of Object.entries(value as Record<string, unknown>)) {
    const windows = (Array.isArray(entry) ? entry : [entry]).flatMap((window) => {
      const parsed = parseWindow(window);
      return parsed ? [parsed] : [];
    });
    if (windows.length > 0) cover[coverage] = windows;
  }
  return cover;
}

function parseWindow(window: unknown): CoverWindow | null {
  if (!window || typeof window !== 'object') return null;
  const { policyId, validFrom, validTo } = window as Record<string, unknown>;
  if (typeof policyId !== 'string' || typeof validFrom !== 'string') return null;
  if (typeof validTo !== 'string') return null;
  return { policyId, validFrom, validTo };
}

/**
 * Adds a recorded policy to the map, one window per policy.
 *
 * A policy recorded again replaces its own window. Windows that have already
 * ended are dropped: they can never answer a lapse again, and keeping them
 * would grow the column for ever. Order-independent: two policies of one
 * coverage can arrive in either order, and the result is the same set.
 */
export function withRecordedPolicy(
  cover: InsuranceCover,
  coverage: string,
  window: CoverWindow,
  now: Date,
): InsuranceCover {
  const others = (cover[coverage] ?? []).filter(
    (existing) => existing.policyId !== window.policyId && !hasEnded(existing, now),
  );
  const windows = hasEnded(window, now) ? others : [...others, window];
  const sorted = windows.sort((a, b) => a.policyId.localeCompare(b.policyId));
  const next = { ...cover };
  if (sorted.length > 0) next[coverage] = sorted;
  else delete next[coverage];
  return next;
}

function hasEnded(window: CoverWindow, now: Date): boolean {
  const to = Date.parse(window.validTo);
  return Number.isNaN(to) || to <= now.getTime();
}

/** Whether a window is in force at `now`: started, and not yet ended. */
export function isInForce(window: CoverWindow | undefined, now: Date): boolean {
  if (!window) return false;
  const from = Date.parse(window.validFrom);
  const to = Date.parse(window.validTo);
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  return from <= now.getTime() && now.getTime() < to;
}

/** Whether any recorded policy of the coverage is in force at `now`. */
export function isCovered(windows: readonly CoverWindow[] | undefined, now: Date): boolean {
  return (windows ?? []).some((window) => isInForce(window, now));
}

/**
 * The lapsed coverages that no recorded policy currently answers.
 *
 * `UNKNOWN` is answered by a policy of any coverage in force: it only exists
 * for lapses recorded before the producer said which coverage lapsed, and a
 * rule that nothing could ever satisfy would strand those machines with no
 * way back short of editing the database (Q-65 records the trade-off).
 */
export function unresolvedLapses(
  lapsed: readonly string[],
  cover: InsuranceCover,
  now: Date,
): string[] {
  const anyInForce = Object.values(cover).some((windows) => isCovered(windows, now));
  return [...new Set(lapsed)].filter((coverage) =>
    coverage === UNKNOWN_COVERAGE ? !anyInForce : !isCovered(cover[coverage], now),
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
export function activeDispatchBlocks(
  asset: DispatchBlockFields,
  now: Date,
  policy: DispatchPolicy = DEFAULT_DISPATCH_POLICY,
): DispatchBlock[] {
  const blocks: DispatchBlock[] = [];
  if (asset.inspectionBlockedReason) {
    blocks.push({ cause: 'INSPECTION', detail: asset.inspectionBlockedReason });
  }
  // A lapse of a coverage that does not gate dispatch stays recorded, so that
  // widening the configuration later brings it back, but it blocks nothing.
  const lapses = unresolvedLapses(
    asset.insuranceLapsedCoverages,
    parseCover(asset.insuranceCover),
    now,
  ).filter(
    (coverage) => coverage === UNKNOWN_COVERAGE || policy.blockingCoverages.includes(coverage),
  );
  if (lapses.length > 0) {
    blocks.push({
      cause: 'INSURANCE',
      detail: `The insurance policy has expired (${lapses.sort().join(', ')})`,
    });
  }
  return blocks;
}
