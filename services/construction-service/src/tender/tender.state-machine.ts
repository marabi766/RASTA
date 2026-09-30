import { RastaError } from '@rasta/nest-common';

/**
 * The tender lifecycle, as data (AGENTS.md A-11, ADR-065).
 *
 * ```
 *   create
 *   ─────► DRAFT ──publish──► PUBLISHED ──close──► CLOSED ──open-bids──► EVALUATING ──evaluate──► EVALUATED ──award──► AWARDED
 *
 *   DRAFT | PUBLISHED | CLOSED | EVALUATING | EVALUATED ──cancel(reason)──► CANCELLED
 * ```
 *
 * ## Only part of this is reachable in CON-002 PR 2
 *
 * PR 2 ships `create`, `update` and `cancel` (from `DRAFT`). `publish`, `close`,
 * `open-bids`, `evaluate` and `award` arrive with the steps ADR-065 lists. The
 * whole table is here anyway so the database enum, the published contract and
 * the cancel rule are written once, and each step adds a command, not a state.
 *
 * ## What is absent, and why
 *
 *   BID_OPEN                 The bidding window is [bid_opening_at, bid_closing_at),
 *                            derived from two timestamps. A stored state would need
 *                            a second timer for no decision it changes.
 *   FAILED                   No qualified bid is CANCELLED with the closed reason
 *                            code `NO_QUALIFIED_BID`.
 *   PENDING_APPROVAL …       Approval of a tender is a step of the approval engine
 *   CONTRACTED … SETTLED     (ADR-063, Q-84), not a tender state; contract and
 *                            settlement belong to CON-003.
 *   automatic transitions    Closing is a command. The sweeper calls it; nothing
 *                            changes state by itself (ADR-065 § 3).
 *
 * ## Terminality
 *
 * `AWARDED` and `CANCELLED` have no outgoing edges.
 */

export const TENDER_STATES = [
  'DRAFT',
  'PUBLISHED',
  'CLOSED',
  'EVALUATING',
  'EVALUATED',
  'AWARDED',
  'CANCELLED',
] as const;

export type TenderStateName = (typeof TENDER_STATES)[number];

export const TENDER_TRANSITIONS: Readonly<Record<TenderStateName, readonly TenderStateName[]>> = {
  DRAFT: ['PUBLISHED', 'CANCELLED'],
  PUBLISHED: ['CLOSED', 'CANCELLED'],
  CLOSED: ['EVALUATING', 'CANCELLED'],
  EVALUATING: ['EVALUATED', 'CANCELLED'],
  EVALUATED: ['AWARDED', 'CANCELLED'],
  AWARDED: [],
  CANCELLED: [],
} as const;

export const TERMINAL_TENDER_STATES: readonly TenderStateName[] = ['AWARDED', 'CANCELLED'];

/** States in which the tender's own content may change: before anyone can bid. */
export const EDITABLE_TENDER_STATES: readonly TenderStateName[] = ['DRAFT'];

/**
 * The closed reason codes a cancellation may carry on the wire. The prose
 * reason stays in the database (no free text on events).
 */
export const CANCELLATION_CODES = ['OWNER_REQUEST', 'NO_QUALIFIED_BID'] as const;
export type CancellationCode = (typeof CANCELLATION_CODES)[number];

export function isTerminalTenderState(state: TenderStateName): boolean {
  return TERMINAL_TENDER_STATES.includes(state);
}

export function isEditableTenderState(state: TenderStateName): boolean {
  return EDITABLE_TENDER_STATES.includes(state);
}

export function canTransitionTender(from: TenderStateName, to: TenderStateName): boolean {
  return TENDER_TRANSITIONS[from].includes(to);
}

/**
 * Refuses an illegal transition with the platform's business-rule code.
 *
 * `422` rather than `409`: the request is well-formed and the caller may make
 * it — the tender is simply not in a state where it means anything, and a retry
 * will not change that. A stale `expectedVersion` is the `409`.
 */
export function assertTenderTransition(
  tenderId: string,
  from: TenderStateName,
  to: TenderStateName,
): void {
  if (canTransitionTender(from, to)) return;

  throw RastaError.businessRule(
    isTerminalTenderState(from)
      ? `Tender ${tenderId} is ${from.toLowerCase()} and cannot change state`
      : `Tender ${tenderId} cannot move from ${from} to ${to}`,
    { tenderId, from, to },
  );
}

/** Refuses a change to a tender that is no longer editable. */
export function assertTenderEditable(tenderId: string, state: TenderStateName): void {
  if (isEditableTenderState(state)) return;

  throw RastaError.businessRule(
    `Tender ${tenderId} is ${state} and can no longer be edited; ` +
      `only a tender in ${EDITABLE_TENDER_STATES.join(' or ')} can change`,
    { tenderId, state },
  );
}
