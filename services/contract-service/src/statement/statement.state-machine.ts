/**
 * The statement lifecycle as an explicit table (AGENTS.md A-11, ADR-068 § 5; CON-003 PR 4 to 6).
 *
 * Data, not branches, like the contract's and the amendment's: every transition is a row,
 * read-only, and the unit test walks every (from, to) pair. ADR-068 § 5 declares
 * `DRAFT → SUBMITTED → TECHNICALLY_APPROVED → APPROVED | REJECTED`:
 *
 * - the contractor submits a draft (`submit`), in the transaction that snapshots both approval
 *   chains from the policies in force;
 * - the approval of the technical chain's last step completes it (`approve_technical`), the
 *   approval of the financial chain's last step completes the statement (`approve_financial`) —
 *   the financial chain opens only after the technical one is done (Q-96 (2));
 * - a rejection at any step of either chain rejects the statement (`reject`), final for that
 *   number (Q-96 (7)).
 *
 * A decision that completes no chain is recorded without a transition. APPROVED and REJECTED are
 * final. The latest migration's header lists the same table and its guard allows exactly it; the
 * unit test fails if the two differ.
 */

export const STATEMENT_STATES = [
  'DRAFT',
  'SUBMITTED',
  'TECHNICALLY_APPROVED',
  'APPROVED',
  'REJECTED',
] as const;
export type StatementStateName = (typeof STATEMENT_STATES)[number];

export const STATEMENT_COMMANDS = [
  'submit',
  'approve_technical',
  'approve_financial',
  'reject',
] as const;
export type StatementCommandName = (typeof STATEMENT_COMMANDS)[number];

export interface StatementTransition {
  readonly from: StatementStateName;
  readonly to: StatementStateName;
  readonly command: StatementCommandName;
}

export const STATEMENT_TRANSITIONS: readonly StatementTransition[] = Object.freeze([
  Object.freeze({ from: 'DRAFT', to: 'SUBMITTED', command: 'submit' } as const),
  Object.freeze({
    from: 'SUBMITTED',
    to: 'TECHNICALLY_APPROVED',
    command: 'approve_technical',
  } as const),
  Object.freeze({ from: 'SUBMITTED', to: 'REJECTED', command: 'reject' } as const),
  Object.freeze({
    from: 'TECHNICALLY_APPROVED',
    to: 'APPROVED',
    command: 'approve_financial',
  } as const),
  Object.freeze({ from: 'TECHNICALLY_APPROVED', to: 'REJECTED', command: 'reject' } as const),
]);

/** The state a statement is drafted in, by the contractor and by nothing else. */
export const INITIAL_STATEMENT_STATE: StatementStateName = 'DRAFT';

/** The states nothing moves a statement out of. */
export const FINAL_STATEMENT_STATES: readonly StatementStateName[] = Object.freeze([
  'APPROVED',
  'REJECTED',
]);

export function statementTransitionFor(
  from: StatementStateName,
  command: StatementCommandName,
): StatementTransition | undefined {
  return STATEMENT_TRANSITIONS.find((entry) => entry.from === from && entry.command === command);
}

export function canStatementTransition(from: StatementStateName, to: StatementStateName): boolean {
  return STATEMENT_TRANSITIONS.some((entry) => entry.from === from && entry.to === to);
}
