import { isRastaError } from '@rasta/nest-common';
import {
  CANCELLABLE_BY_LIFECYCLE,
  EDITABLE_PROJECT_STATES,
  PROJECT_STATES,
  PROJECT_TRANSITIONS,
  assertProjectCancellable,
  assertProjectEditable,
  assertProjectTransition,
  canTransitionProject,
  isEditableProjectState,
  isTerminalProjectState,
  type ProjectStateName,
} from './project.state-machine';

/**
 * The project lifecycle, walked exhaustively.
 *
 * Every (from, to) pair is asserted against one hand-written list of the legal
 * edges, so adding an edge to the table without adding it here — or the other
 * way round — fails. The list is the design note's machine, not the table
 * read back.
 */

const LEGAL: ReadonlyArray<readonly [ProjectStateName, ProjectStateName]> = [
  ['DRAFT', 'PENDING_APPROVAL'],
  ['DRAFT', 'CANCELLED'],
  ['PENDING_APPROVAL', 'APPROVED'],
  ['PENDING_APPROVAL', 'CHANGES_REQUESTED'],
  ['PENDING_APPROVAL', 'CANCELLED'],
  ['CHANGES_REQUESTED', 'PENDING_APPROVAL'],
  ['CHANGES_REQUESTED', 'CANCELLED'],
  ['APPROVED', 'IN_PROGRESS'],
  ['APPROVED', 'CANCELLED'],
  ['IN_PROGRESS', 'COMPLETED'],
];

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return isRastaError(error) ? error.code : `NOT_A_PLATFORM_ERROR: ${String(error)}`;
  }
  return 'NO_ERROR';
}

describe('the project transition table', () => {
  it.each(PROJECT_STATES.flatMap((from) => PROJECT_STATES.map((to) => [from, to] as const)))(
    '%s → %s is legal exactly when the design note says so',
    (from, to) => {
      const legal = LEGAL.some(([a, b]) => a === from && b === to);
      expect(canTransitionProject(from, to)).toBe(legal);
      expect(codeOf(() => assertProjectTransition('PRJ_1', from, to))).toBe(
        legal ? 'NO_ERROR' : 'BUSINESS_RULE_VIOLATION',
      );
    },
  );

  it('has exactly the legal edges and no others', () => {
    const edges = PROJECT_STATES.flatMap((from) =>
      PROJECT_TRANSITIONS[from].map((to) => `${from}→${to}`),
    );
    expect(edges.sort()).toEqual(LEGAL.map(([a, b]) => `${a}→${b}`).sort());
  });

  it('never leaves a state for itself', () => {
    for (const state of PROJECT_STATES) expect(canTransitionProject(state, state)).toBe(false);
  });

  it('makes COMPLETED and CANCELLED terminal, and nothing else', () => {
    expect(PROJECT_STATES.filter(isTerminalProjectState)).toEqual(['COMPLETED', 'CANCELLED']);
    for (const state of ['COMPLETED', 'CANCELLED'] as const) {
      expect(PROJECT_TRANSITIONS[state]).toEqual([]);
    }
  });

  it('says a terminal project cannot change state at all, in words', () => {
    expect(() => assertProjectTransition('PRJ_1', 'CANCELLED', 'DRAFT')).toThrow(
      /cancelled and cannot change state/,
    );
  });

  it('has no automatic edge: nothing leaves PENDING_APPROVAL except a decision or a cancel', () => {
    expect(PROJECT_TRANSITIONS.PENDING_APPROVAL).toEqual([
      'APPROVED',
      'CHANGES_REQUESTED',
      'CANCELLED',
    ]);
  });
});

describe('editability', () => {
  it('allows edits only in DRAFT and CHANGES_REQUESTED', () => {
    expect(EDITABLE_PROJECT_STATES).toEqual(['DRAFT', 'CHANGES_REQUESTED']);
    expect(PROJECT_STATES.filter(isEditableProjectState)).toEqual(['DRAFT', 'CHANGES_REQUESTED']);
  });

  it.each(PROJECT_STATES.filter((state) => !EDITABLE_PROJECT_STATES.includes(state)))(
    'refuses an edit while %s with a business-rule error',
    (state) => {
      expect(codeOf(() => assertProjectEditable('PRJ_1', state))).toBe('BUSINESS_RULE_VIOLATION');
    },
  );
});

describe('cancellation', () => {
  it('is possible by the lifecycle from every pre-execution, non-terminal state', () => {
    expect([...CANCELLABLE_BY_LIFECYCLE]).toEqual([
      'DRAFT',
      'PENDING_APPROVAL',
      'CHANGES_REQUESTED',
      'APPROVED',
    ]);
  });

  it('is never possible from IN_PROGRESS, whatever the configuration says', () => {
    expect(
      codeOf(() => assertProjectCancellable('PRJ_1', 'IN_PROGRESS', [...PROJECT_STATES])),
    ).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('is refused from a state the deployment removed from CONSTRUCTION_CANCELLABLE_STATES', () => {
    expect(codeOf(() => assertProjectCancellable('PRJ_1', 'APPROVED', ['DRAFT']))).toBe(
      'BUSINESS_RULE_VIOLATION',
    );
    expect(() => assertProjectCancellable('PRJ_1', 'APPROVED', ['DRAFT'])).toThrow(
      /in this deployment/,
    );
  });

  it('is allowed from a configured state', () => {
    expect(codeOf(() => assertProjectCancellable('PRJ_1', 'DRAFT', ['DRAFT']))).toBe('NO_ERROR');
  });
});
