/**
 * The amendment lifecycle as an explicit table (AGENTS.md A-11, ADR-068 § 9; CON-003 PR 3).
 *
 * Data, not branches, like the contract's (`contract.state-machine.ts`): every transition is a row,
 * read-only, and the unit test walks every (from, to) pair. An amendment is **proposed** by the
 * employer and becomes **effective** when both parties have signed it — the second signature makes
 * that transition, in the transaction that records it. There is no withdrawal, rejection or
 * reversal: no document defines one (Q-100), and an effective amendment never changes (the
 * database keeps that too: `ck_amendment_immutable`). The migration's header lists the same table;
 * the unit test fails if the two differ.
 */

export const AMENDMENT_STATES = ['PROPOSED', 'EFFECTIVE'] as const;
export type AmendmentStateName = (typeof AMENDMENT_STATES)[number];

export const AMENDMENT_COMMANDS = ['sign'] as const;
export type AmendmentCommandName = (typeof AMENDMENT_COMMANDS)[number];

export interface AmendmentTransition {
  readonly from: AmendmentStateName;
  readonly to: AmendmentStateName;
  readonly command: AmendmentCommandName;
}

export const AMENDMENT_TRANSITIONS: readonly AmendmentTransition[] = Object.freeze([
  Object.freeze({ from: 'PROPOSED', to: 'EFFECTIVE', command: 'sign' } as const),
]);

/** An effective amendment is history: nothing about it changes again. */
export const FINAL_AMENDMENT_STATES: readonly AmendmentStateName[] = Object.freeze(['EFFECTIVE']);

/** The state an amendment is proposed in, by the employer and by nothing else. */
export const INITIAL_AMENDMENT_STATE: AmendmentStateName = 'PROPOSED';

export function amendmentTransitionFor(
  from: AmendmentStateName,
  command: AmendmentCommandName,
): AmendmentTransition | undefined {
  return AMENDMENT_TRANSITIONS.find((entry) => entry.from === from && entry.command === command);
}

export function canAmendmentTransition(from: AmendmentStateName, to: AmendmentStateName): boolean {
  return AMENDMENT_TRANSITIONS.some((entry) => entry.from === from && entry.to === to);
}
