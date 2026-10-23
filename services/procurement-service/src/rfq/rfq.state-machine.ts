import { RFQ_STATES } from '@rasta/contracts';

/**
 * The RFQ lifecycle as an explicit table (AGENTS.md A-11; ADR-070 § 3 — the table of ADR-065 § 1
 * without DRAFT: the issue is one step).
 *
 * Data, not branches: every transition is a row, read-only, and the unit test walks every (from,
 * to) pair. The whole lifecycle is declared now and stored as text under a `CHECK`
 * (`ck_rfq_status`, never an enum, ADR-068 § 2), the later plan PRs' statuses included; plan PR 6
 * reaches `issue`, `close` and `cancel` from PUBLISHED and CLOSED. `rfq_guard` refuses any change
 * this table does not have, from any write path.
 */

export { RFQ_STATES };
export type RfqStateName = (typeof RFQ_STATES)[number];

export const RFQ_COMMANDS = ['close', 'openQuotations', 'evaluate', 'award', 'cancel'] as const;
export type RfqCommandName = (typeof RFQ_COMMANDS)[number];

export interface RfqTransition {
  readonly from: RfqStateName;
  readonly to: RfqStateName;
  readonly command: RfqCommandName;
}

/** An RFQ is created PUBLISHED by the issue (`INITIAL_RFQ_STATE`); everything after is here. */
export const RFQ_TRANSITIONS: readonly RfqTransition[] = Object.freeze([
  Object.freeze({ from: 'PUBLISHED', to: 'CLOSED', command: 'close' } as const),
  Object.freeze({ from: 'CLOSED', to: 'EVALUATING', command: 'openQuotations' } as const),
  Object.freeze({ from: 'EVALUATING', to: 'EVALUATED', command: 'evaluate' } as const),
  Object.freeze({ from: 'EVALUATED', to: 'AWARDED', command: 'award' } as const),
  Object.freeze({ from: 'PUBLISHED', to: 'CANCELLED', command: 'cancel' } as const),
  Object.freeze({ from: 'CLOSED', to: 'CANCELLED', command: 'cancel' } as const),
  Object.freeze({ from: 'EVALUATING', to: 'CANCELLED', command: 'cancel' } as const),
  Object.freeze({ from: 'EVALUATED', to: 'CANCELLED', command: 'cancel' } as const),
]);

export const INITIAL_RFQ_STATE: RfqStateName = 'PUBLISHED';

export const FINAL_RFQ_STATES: readonly RfqStateName[] = Object.freeze(['AWARDED', 'CANCELLED']);

/** The statuses an RFQ reaches only through its close: closing one of them again changes nothing. */
export const CLOSED_RFQ_STATES: readonly RfqStateName[] = Object.freeze([
  'CLOSED',
  'EVALUATING',
  'EVALUATED',
  'AWARDED',
]);

export function canTransitionRfq(from: RfqStateName, to: RfqStateName): boolean {
  return RFQ_TRANSITIONS.some((entry) => entry.from === from && entry.to === to);
}

/** Whether `command` leads out of `from`, and where. */
export function rfqTransition(from: RfqStateName, command: RfqCommandName): RfqStateName | null {
  return (
    RFQ_TRANSITIONS.find((entry) => entry.from === from && entry.command === command)?.to ?? null
  );
}

/**
 * The deadline (ADR-070 § 3, ADR-065 § 2): half-open, like a window. A quotation is accepted only
 * before `quotationClosingAt`, and the RFQ is closed only at or after it — on the database clock,
 * read after the RFQ's lock, so the two never overlap.
 */
export function deadlinePassed(quotationClosingAt: Date, now: Date): boolean {
  return now.getTime() >= quotationClosingAt.getTime();
}
