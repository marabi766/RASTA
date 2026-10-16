/**
 * The statement lifecycle as an explicit table (AGENTS.md A-11, ADR-068 § 5; CON-003 PR 4).
 *
 * Data, not branches, like the contract's and the amendment's: every transition is a row,
 * read-only, and the unit test walks every (from, to) pair. ADR-068 § 5 declares
 * `DRAFT → SUBMITTED → TECHNICALLY_APPROVED → APPROVED | REJECTED`; all five states exist in the
 * database now (an enum value cannot be removed), and **no transition is open in this change**: a
 * statement is drafted and stays a DRAFT. Submission needs the approval policies of both chains
 * and their snapshot at submission (ADR-068 § 5), so it opens with them in the next change, which
 * adds its row here and in the database's guard together. The migration's header lists the same
 * table and its guard allows exactly it; the unit test fails if the two differ.
 */

export const STATEMENT_STATES = [
  'DRAFT',
  'SUBMITTED',
  'TECHNICALLY_APPROVED',
  'APPROVED',
  'REJECTED',
] as const;
export type StatementStateName = (typeof STATEMENT_STATES)[number];

export interface StatementTransition {
  readonly from: StatementStateName;
  readonly to: StatementStateName;
}

export const STATEMENT_TRANSITIONS: readonly StatementTransition[] = Object.freeze([]);

/** The state a statement is drafted in, by the contractor and by nothing else. */
export const INITIAL_STATEMENT_STATE: StatementStateName = 'DRAFT';

export function canStatementTransition(from: StatementStateName, to: StatementStateName): boolean {
  return STATEMENT_TRANSITIONS.some((entry) => entry.from === from && entry.to === to);
}
