/**
 * The statement lifecycle as an explicit table (AGENTS.md A-11, ADR-068 § 5; CON-003 PR 4).
 *
 * Data, not branches, like the contract's and the amendment's: every transition is a row,
 * read-only, and the unit test walks every (from, to) pair. ADR-068 § 5 declares
 * `DRAFT → SUBMITTED → TECHNICALLY_APPROVED → APPROVED | REJECTED`; all five states exist in the
 * database now (an enum value cannot be removed), and this change reaches `SUBMITTED` only — the
 * two approval chains that take a statement further are the next change's (ADR-068 § 9, PR 5).
 * The contractor drafts and submits (Q-96). The migration's header lists the same table and its
 * guard allows exactly it; the unit test fails if the two differ.
 */

export const STATEMENT_STATES = [
  'DRAFT',
  'SUBMITTED',
  'TECHNICALLY_APPROVED',
  'APPROVED',
  'REJECTED',
] as const;
export type StatementStateName = (typeof STATEMENT_STATES)[number];

export const STATEMENT_COMMANDS = ['submit'] as const;
export type StatementCommandName = (typeof STATEMENT_COMMANDS)[number];

export interface StatementTransition {
  readonly from: StatementStateName;
  readonly to: StatementStateName;
  readonly command: StatementCommandName;
}

export const STATEMENT_TRANSITIONS: readonly StatementTransition[] = Object.freeze([
  Object.freeze({ from: 'DRAFT', to: 'SUBMITTED', command: 'submit' } as const),
]);

/** The state a statement is drafted in, by the contractor and by nothing else. */
export const INITIAL_STATEMENT_STATE: StatementStateName = 'DRAFT';

export function statementTransitionFor(
  from: StatementStateName,
  command: StatementCommandName,
): StatementTransition | undefined {
  return STATEMENT_TRANSITIONS.find((entry) => entry.from === from && entry.command === command);
}

export function canStatementTransition(from: StatementStateName, to: StatementStateName): boolean {
  return STATEMENT_TRANSITIONS.some((entry) => entry.from === from && entry.to === to);
}
