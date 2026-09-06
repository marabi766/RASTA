import { isRastaError } from '@rasta/nest-common';
import {
  assertNoBlockingQualification,
  assertQualificationTransition,
  canTransitionQualification,
  isCurrentlyQualified,
  isTerminalQualificationState,
  QUALIFICATION_STATES,
  QUALIFICATION_TRANSITIONS,
  type QualificationStateName,
} from './qualification.state-machine';

/**
 * The qualification lifecycle, legal and illegal.
 *
 * The table is enumerated exhaustively rather than sampled: every ordered pair
 * of states is asserted either legal or illegal, so adding a state without
 * deciding its edges fails here instead of being permitted by omission.
 */

const ALL_PAIRS: [QualificationStateName, QualificationStateName][] = QUALIFICATION_STATES.flatMap(
  (from) =>
    QUALIFICATION_STATES.map((to): [QualificationStateName, QualificationStateName] => [from, to]),
);

describe('legal transitions', () => {
  it.each([
    ['SUBMITTED', 'APPROVED'],
    ['SUBMITTED', 'REJECTED'],
  ] as const)('%s → %s is allowed', (from, to) => {
    expect(canTransitionQualification(from, to)).toBe(true);
    expect(() => assertQualificationTransition('QLF_1', from, to)).not.toThrow();
  });
});

describe('illegal transitions', () => {
  const legal = new Set(
    Object.entries(QUALIFICATION_TRANSITIONS).flatMap(([from, targets]) =>
      targets.map((to) => `${from}->${to}`),
    ),
  );

  const illegal = ALL_PAIRS.filter(([from, to]) => !legal.has(`${from}->${to}`));

  it('covers every remaining ordered pair, so nothing is legal by omission', () => {
    // 3 states = 9 ordered pairs, of which 2 are legal.
    expect(illegal).toHaveLength(7);
  });

  it.each(illegal)('%s → %s is refused', (from, to) => {
    expect(canTransitionQualification(from, to)).toBe(false);
    expect(() => assertQualificationTransition('QLF_1', from, to)).toThrow();
  });

  it('refuses a self-transition, so a repeated decision is not a silent no-op', () => {
    expect(() => assertQualificationTransition('QLF_1', 'APPROVED', 'APPROVED')).toThrow();
  });

  it('refuses re-deciding a decided qualification, and says which decision stands', () => {
    // The message matters: "already approved" tells a reviewer their colleague
    // got there first, while "cannot move from X to Y" reads like a bug.
    expect(() => assertQualificationTransition('QLF_1', 'REJECTED', 'APPROVED')).toThrow(
      /already rejected/i,
    );
  });

  it('answers 422, not 409 — retrying a terminal state can never help', () => {
    try {
      assertQualificationTransition('QLF_1', 'APPROVED', 'REJECTED');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isRastaError(error)).toBe(true);
      expect((error as { status: number }).status).toBe(422);
    }
  });
});

describe('terminality', () => {
  it('has no way out of a decided qualification', () => {
    expect(QUALIFICATION_TRANSITIONS.APPROVED).toEqual([]);
    expect(QUALIFICATION_TRANSITIONS.REJECTED).toEqual([]);
    expect(isTerminalQualificationState('APPROVED')).toBe(true);
    expect(isTerminalQualificationState('REJECTED')).toBe(true);
  });

  it('leaves SUBMITTED as the only non-terminal state', () => {
    expect(QUALIFICATION_STATES.filter((state) => !isTerminalQualificationState(state))).toEqual([
      'SUBMITTED',
    ]);
  });
});

describe('states that deliberately do not exist', () => {
  it('has no expiry, renewal, provisional or automatic state', () => {
    // Each would encode a rule no accepted document states: a validity period,
    // a renewal cycle, or an approval nobody made (AGENTS.md § 9).
    expect(QUALIFICATION_STATES).toEqual(['SUBMITTED', 'APPROVED', 'REJECTED']);
  });
});

describe('a rejected qualification is never reported as qualified', () => {
  it.each(['SUBMITTED', 'REJECTED'] as const)('%s is not current', (state) => {
    expect(isCurrentlyQualified({ state, supplierSuspended: false })).toBe(false);
  });

  it('an approval on an unsuspended supplier is current', () => {
    expect(isCurrentlyQualified({ state: 'APPROVED', supplierSuspended: false })).toBe(true);
  });
});

describe('a suspended supplier is never currently qualified', () => {
  it('withholds an approval while the supplier is suspended', () => {
    expect(isCurrentlyQualified({ state: 'APPROVED', supplierSuspended: true })).toBe(false);
  });

  it('does not revoke the approval — reinstating restores it with no new decision', () => {
    const approval = { state: 'APPROVED' as const };

    expect(isCurrentlyQualified({ ...approval, supplierSuspended: true })).toBe(false);
    expect(isCurrentlyQualified({ ...approval, supplierSuspended: false })).toBe(true);
  });
});

describe('blocking an ambiguous second submission', () => {
  it('allows the first submission for a capability', () => {
    expect(() => assertNoBlockingQualification('WORKSHOP_SERVICE', [])).not.toThrow();
  });

  it('refuses a second submission while one awaits a decision', () => {
    // Two open submissions could be decided differently by two reviewers,
    // leaving the supplier both approved and rejected for one capability.
    expect(() =>
      assertNoBlockingQualification('WORKSHOP_SERVICE', [{ state: 'SUBMITTED' }]),
    ).toThrow(/awaiting a decision/i);
  });

  it('refuses a submission for a capability that is already approved', () => {
    // With no expiry rule, a second approval would mean the platform had
    // invented a renewal cycle.
    expect(() => assertNoBlockingQualification('GOODS_SUPPLY', [{ state: 'APPROVED' }])).toThrow(
      /already qualified/i,
    );
  });

  it('lets a rejected supplier apply again — refusal is not a permanent bar', () => {
    expect(() =>
      assertNoBlockingQualification('CONTRACTING', [{ state: 'REJECTED' }, { state: 'REJECTED' }]),
    ).not.toThrow();
  });
});
