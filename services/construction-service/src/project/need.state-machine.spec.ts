import { isRastaError } from '@rasta/nest-common';
import {
  EDITABLE_NEED_STATES,
  NEED_STATES,
  NEED_TRANSITIONS,
  assertNeedEditable,
  assertNeedTransition,
  canTransitionNeed,
  isTerminalNeedState,
  type NeedStateName,
} from './need.state-machine';

const LEGAL: ReadonlyArray<readonly [NeedStateName, NeedStateName]> = [
  ['DRAFT', 'SUBMITTED'],
  ['DRAFT', 'WITHDRAWN'],
  ['SUBMITTED', 'WITHDRAWN'],
];

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return isRastaError(error) ? error.code : `NOT_A_PLATFORM_ERROR: ${String(error)}`;
  }
  return 'NO_ERROR';
}

describe('the need transition table', () => {
  it.each(NEED_STATES.flatMap((from) => NEED_STATES.map((to) => [from, to] as const)))(
    '%s → %s is legal exactly when the design note says so',
    (from, to) => {
      const legal = LEGAL.some(([a, b]) => a === from && b === to);
      expect(canTransitionNeed(from, to)).toBe(legal);
      expect(codeOf(() => assertNeedTransition('PND_1', from, to))).toBe(
        legal ? 'NO_ERROR' : 'BUSINESS_RULE_VIOLATION',
      );
    },
  );

  it('has exactly the legal edges', () => {
    const edges = NEED_STATES.flatMap((from) =>
      NEED_TRANSITIONS[from].map((to) => `${from}→${to}`),
    );
    expect(edges.sort()).toEqual(LEGAL.map(([a, b]) => `${a}→${b}`).sort());
  });

  it('makes WITHDRAWN the only terminal state, and says so', () => {
    expect(NEED_STATES.filter(isTerminalNeedState)).toEqual(['WITHDRAWN']);
    expect(() => assertNeedTransition('PND_1', 'WITHDRAWN', 'SUBMITTED')).toThrow(
      /withdrawn and cannot change state/,
    );
  });

  it('never submits a need twice', () => {
    expect(codeOf(() => assertNeedTransition('PND_1', 'SUBMITTED', 'SUBMITTED'))).toBe(
      'BUSINESS_RULE_VIOLATION',
    );
  });
});

describe('need editability', () => {
  it('allows edits only in DRAFT', () => {
    expect(EDITABLE_NEED_STATES).toEqual(['DRAFT']);
    expect(codeOf(() => assertNeedEditable('PND_1', 'DRAFT'))).toBe('NO_ERROR');
  });

  it.each(['SUBMITTED', 'WITHDRAWN'] as const)('refuses an edit while %s', (state) => {
    expect(codeOf(() => assertNeedEditable('PND_1', state))).toBe('BUSINESS_RULE_VIOLATION');
    expect(() => assertNeedEditable('PND_1', state)).toThrow(/withdraw it and add a new one/);
  });
});
