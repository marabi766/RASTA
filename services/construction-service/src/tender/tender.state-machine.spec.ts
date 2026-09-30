import {
  EDITABLE_TENDER_STATES,
  TENDER_STATES,
  TENDER_TRANSITIONS,
  assertTenderEditable,
  assertTenderTransition,
  canTransitionTender,
  isTerminalTenderState,
  type TenderStateName,
} from './tender.state-machine';

/** The lifecycle of ADR-065, written out edge by edge so the table cannot drift. */
const LEGAL: readonly (readonly [TenderStateName, TenderStateName])[] = [
  ['DRAFT', 'PUBLISHED'],
  ['DRAFT', 'CANCELLED'],
  ['PUBLISHED', 'CLOSED'],
  ['PUBLISHED', 'CANCELLED'],
  ['CLOSED', 'EVALUATING'],
  ['CLOSED', 'CANCELLED'],
  ['EVALUATING', 'EVALUATED'],
  ['EVALUATING', 'CANCELLED'],
  ['EVALUATED', 'AWARDED'],
  ['EVALUATED', 'CANCELLED'],
];

describe('the tender transition table', () => {
  it.each(TENDER_STATES.flatMap((from) => TENDER_STATES.map((to) => [from, to] as const)))(
    '%s → %s is legal exactly when ADR-065 says so',
    (from, to) => {
      const legal = LEGAL.some(([a, b]) => a === from && b === to);
      expect(canTransitionTender(from, to)).toBe(legal);
      if (legal) {
        expect(() => assertTenderTransition('TND_1', from, to)).not.toThrow();
      } else {
        expect(() => assertTenderTransition('TND_1', from, to)).toThrow(
          expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }),
        );
      }
    },
  );

  it('has exactly the legal edges and no others', () => {
    const edges = Object.entries(TENDER_TRANSITIONS).flatMap(([from, tos]) =>
      tos.map((to) => `${from}>${to}`),
    );
    expect(edges.sort()).toEqual(LEGAL.map(([a, b]) => `${a}>${b}`).sort());
  });

  it('never leaves a state for itself', () => {
    for (const state of TENDER_STATES) expect(canTransitionTender(state, state)).toBe(false);
  });

  it('makes AWARDED and CANCELLED terminal, and nothing else', () => {
    expect(TENDER_STATES.filter(isTerminalTenderState)).toEqual(['AWARDED', 'CANCELLED']);
    for (const state of TENDER_STATES.filter(isTerminalTenderState)) {
      expect(TENDER_TRANSITIONS[state]).toEqual([]);
    }
  });

  it('says a terminal tender cannot change state at all, in words', () => {
    expect(() => assertTenderTransition('TND_1', 'AWARDED', 'CANCELLED')).toThrow(
      /awarded and cannot change state/,
    );
  });

  it('has no automatic edge: every way out of a live state is a command', () => {
    // Nothing in the table is keyed by time; closing is `close`, which the
    // sweeper calls as an ordinary command (ADR-065 § 3).
    expect(TENDER_TRANSITIONS.PUBLISHED).toEqual(['CLOSED', 'CANCELLED']);
  });

  it('can be cancelled from every live state, and from no terminal one', () => {
    for (const state of TENDER_STATES) {
      expect(canTransitionTender(state, 'CANCELLED')).toBe(!isTerminalTenderState(state));
    }
  });
});

describe('editability', () => {
  it('allows edits only in DRAFT', () => {
    expect(EDITABLE_TENDER_STATES).toEqual(['DRAFT']);
  });

  it.each(TENDER_STATES.filter((state) => !EDITABLE_TENDER_STATES.includes(state)))(
    'refuses an edit while %s',
    (state) => {
      expect(() => assertTenderEditable('TND_1', state)).toThrow(
        expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }),
      );
    },
  );
});
