/**
 * The contract lifecycle as an explicit table (AGENTS.md A-11, ADR-068 § 2).
 *
 * Data, not branches: every transition is a row, read-only, and the unit test walks
 * every (from, to) pair, so a transition nobody declared cannot exist and one that
 * is declared cannot be forgotten. Every real transition is then a compare-and-set
 * in the repository (`organization_id`, `id`, `status` and `version` in the
 * predicate), publishing its event in the same transaction.
 *
 * The whole lifecycle is declared now — a value cannot be added to a PostgreSQL
 * enum in a reversible migration — but CON-003 PR 1 reaches `DRAFT` only, and only
 * the consumer of `TENDER_AWARDED` creates one (ADR-068 § 3; Q-95 (3)). The other
 * transitions are written down here so the first one built has a table to join, and
 * so the unit test already refuses a table that lets a contract leave a final state.
 */

export const CONTRACT_STATES = ['DRAFT', 'SIGNED', 'COMPLETED', 'SETTLED', 'CANCELLED'] as const;
export type ContractStateName = (typeof CONTRACT_STATES)[number];

/** The commands that move a contract; each is built in the PR named in ADR-068 § 9. */
export const CONTRACT_COMMANDS = ['sign', 'cancel', 'complete', 'settle'] as const;
export type ContractCommandName = (typeof CONTRACT_COMMANDS)[number];

export interface ContractTransition {
  readonly from: ContractStateName;
  readonly to: ContractStateName;
  readonly command: ContractCommandName;
}

export const CONTRACT_TRANSITIONS: readonly ContractTransition[] = Object.freeze([
  Object.freeze({ from: 'DRAFT', to: 'SIGNED', command: 'sign' } as const),
  Object.freeze({ from: 'DRAFT', to: 'CANCELLED', command: 'cancel' } as const),
  Object.freeze({ from: 'SIGNED', to: 'COMPLETED', command: 'complete' } as const),
  Object.freeze({ from: 'COMPLETED', to: 'SETTLED', command: 'settle' } as const),
]);

/** States with no way out: a settled or cancelled contract is history. */
export const FINAL_CONTRACT_STATES: readonly ContractStateName[] = Object.freeze([
  'SETTLED',
  'CANCELLED',
]);

/** The state a contract is created in, by the consumer of `TENDER_AWARDED` and by nothing else. */
export const INITIAL_CONTRACT_STATE: ContractStateName = 'DRAFT';

/** The transition a command makes from a state, if the table has one. */
export function transitionFor(
  from: ContractStateName,
  command: ContractCommandName,
): ContractTransition | undefined {
  return CONTRACT_TRANSITIONS.find((entry) => entry.from === from && entry.command === command);
}

export function canTransition(from: ContractStateName, to: ContractStateName): boolean {
  return CONTRACT_TRANSITIONS.some((entry) => entry.from === from && entry.to === to);
}
