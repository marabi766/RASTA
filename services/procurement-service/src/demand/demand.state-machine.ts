import type { ShortfallPolicy } from '../config/env';

/**
 * The demand and aggregation lifecycles as explicit tables (AGENTS.md A-11, ADR-070 § 2).
 *
 * Data, not branches: every transition is a row, read-only, and the unit test walks every
 * (from, to) pair, so a transition nobody declared cannot exist and one that is declared cannot be
 * forgotten. Every real transition is then a compare-and-set in the repository (`organization_id`,
 * `id`, `status` and `version` in the predicate), with its event in the same transaction.
 *
 * Both lifecycles are declared whole now and stored as text under a `CHECK` (never an enum: a
 * value added to a PostgreSQL enum cannot be rolled back, ADR-068 § 2). COM-007 PR 1 reaches
 * `submit`, `withdraw` and the end of a window found by a demand that arrives after it; the
 * sweeper (PR 2), `cancel` (PR 2) and `issueRfq` (PR 6) join the same tables later.
 */

export const DEMAND_STATES = ['SUBMITTED', 'WITHDRAWN', 'REFERRED', 'LAPSED'] as const;
export type DemandStateName = (typeof DEMAND_STATES)[number];

export const DEMAND_COMMANDS = ['withdraw', 'refer', 'lapse'] as const;
export type DemandCommandName = (typeof DEMAND_COMMANDS)[number];

export interface DemandTransition {
  readonly from: DemandStateName;
  readonly to: DemandStateName;
  readonly command: DemandCommandName;
}

/** A demand is created SUBMITTED; `refer` and `lapse` come only from its aggregation's window end. */
export const DEMAND_TRANSITIONS: readonly DemandTransition[] = Object.freeze([
  Object.freeze({ from: 'SUBMITTED', to: 'WITHDRAWN', command: 'withdraw' } as const),
  Object.freeze({ from: 'SUBMITTED', to: 'REFERRED', command: 'refer' } as const),
  Object.freeze({ from: 'SUBMITTED', to: 'LAPSED', command: 'lapse' } as const),
]);

export const INITIAL_DEMAND_STATE: DemandStateName = 'SUBMITTED';

export const FINAL_DEMAND_STATES: readonly DemandStateName[] = Object.freeze([
  'WITHDRAWN',
  'REFERRED',
  'LAPSED',
]);

export const AGGREGATION_STATES = [
  'OPEN',
  'READY',
  'RFQ_ISSUED',
  'REFERRED',
  'LAPSED',
  'CANCELLED',
] as const;
export type AggregationStateName = (typeof AGGREGATION_STATES)[number];

export const AGGREGATION_COMMANDS = [
  'reachThreshold',
  'extend',
  'refer',
  'lapse',
  'issueRfq',
  'cancel',
] as const;
export type AggregationCommandName = (typeof AGGREGATION_COMMANDS)[number];

export interface AggregationTransition {
  readonly from: AggregationStateName;
  readonly to: AggregationStateName;
  readonly command: AggregationCommandName;
}

export const AGGREGATION_TRANSITIONS: readonly AggregationTransition[] = Object.freeze([
  Object.freeze({ from: 'OPEN', to: 'READY', command: 'reachThreshold' } as const),
  Object.freeze({ from: 'OPEN', to: 'OPEN', command: 'extend' } as const),
  Object.freeze({ from: 'OPEN', to: 'REFERRED', command: 'refer' } as const),
  Object.freeze({ from: 'OPEN', to: 'LAPSED', command: 'lapse' } as const),
  Object.freeze({ from: 'READY', to: 'RFQ_ISSUED', command: 'issueRfq' } as const),
  Object.freeze({ from: 'READY', to: 'CANCELLED', command: 'cancel' } as const),
]);

export const INITIAL_AGGREGATION_STATE: AggregationStateName = 'OPEN';

export const FINAL_AGGREGATION_STATES: readonly AggregationStateName[] = Object.freeze([
  'RFQ_ISSUED',
  'REFERRED',
  'LAPSED',
  'CANCELLED',
]);

export function canTransitionDemand(from: DemandStateName, to: DemandStateName): boolean {
  return DEMAND_TRANSITIONS.some((entry) => entry.from === from && entry.to === to);
}

export function canTransitionAggregation(
  from: AggregationStateName,
  to: AggregationStateName,
): boolean {
  return AGGREGATION_TRANSITIONS.some((entry) => entry.from === from && entry.to === to);
}

/** The settings a window was opened with: its snapshot, never the configuration of today. */
export interface WindowSnapshot {
  readonly windowHours: number;
  readonly minQuantity: number;
  readonly shortfallPolicy: ShortfallPolicy;
}

/** What is left in a window when it ends: the demands still SUBMITTED. */
export interface WindowContents {
  readonly liveDemands: number;
  readonly totalQuantity: bigint;
}

export type WindowOutcome =
  | { readonly command: 'reachThreshold'; readonly to: 'READY' }
  | { readonly command: 'lapse'; readonly to: 'LAPSED'; readonly demandsTo: 'LAPSED' }
  | { readonly command: 'refer'; readonly to: 'REFERRED'; readonly demandsTo: 'REFERRED' }
  | { readonly command: 'extend'; readonly to: 'OPEN'; readonly windows: number };

const HOUR_MS = 3_600_000;

/**
 * What the end of a window does (ADR-070 § 2), from the window's own snapshot and what it holds —
 * never from the configuration of the moment:
 *
 * - no live demand left: LAPSED, whatever the policy;
 * - at least one live demand and the total at or past the threshold: READY;
 * - short of it: the snapshot's shortfall policy — EXTEND (the window moves on by its own length,
 *   as many times as it takes to reach past `now`: one window per elapsed length, each counted),
 *   REFER or CLOSE (LAPSED), the live demands following the aggregation.
 *
 * `closesAt` and `now` are the database's: `now` is read after the aggregation's row lock.
 */
export function windowOutcome(
  snapshot: WindowSnapshot,
  contents: WindowContents,
  closesAt: Date,
  now: Date,
): WindowOutcome {
  if (contents.liveDemands === 0) {
    return { command: 'lapse', to: 'LAPSED', demandsTo: 'LAPSED' };
  }
  if (contents.totalQuantity >= BigInt(snapshot.minQuantity)) {
    return { command: 'reachThreshold', to: 'READY' };
  }
  switch (snapshot.shortfallPolicy) {
    case 'REFER':
      return { command: 'refer', to: 'REFERRED', demandsTo: 'REFERRED' };
    case 'CLOSE':
      return { command: 'lapse', to: 'LAPSED', demandsTo: 'LAPSED' };
    case 'EXTEND': {
      const length = snapshot.windowHours * HOUR_MS;
      const behind = now.getTime() - closesAt.getTime();
      // Half-open [openedAt, closesAt): at `closesAt` exactly the window is over, so one more.
      const windows = Math.floor(behind / length) + 1;
      return { command: 'extend', to: 'OPEN', windows };
    }
  }
}

/** The instant a window opened at `openedAt` with `windowHours` closes (exclusive). */
export function closingInstant(openedAt: Date, windowHours: number): Date {
  return new Date(openedAt.getTime() + windowHours * HOUR_MS);
}

/** `closesAt` moved on by `windows` lengths of the snapshot. */
export function extendedClosingInstant(closesAt: Date, windowHours: number, windows: number): Date {
  return new Date(closesAt.getTime() + windows * windowHours * HOUR_MS);
}
