import { RastaError } from '@rasta/nest-common';
import {
  RETURN_STATUSES,
  RETURN_TERMINAL_STATUSES,
  RETURN_TRANSITIONS,
  assertReturnTransition,
  canMoveReturn,
  versionAfter,
} from './state-machine';

describe('return request state machine (ADR-048 § 3)', () => {
  it('allows exactly the commercial moves of this version', () => {
    const allowed = RETURN_STATUSES.flatMap((from) =>
      RETURN_STATUSES.filter((to) => canMoveReturn(from, to)).map((to) => `${from}>${to}`),
    );
    expect(allowed.sort()).toEqual([
      'AUTHORIZED>CANCELLED',
      'REQUESTED>AUTHORIZED',
      'REQUESTED>CANCELLED',
      'REQUESTED>REJECTED',
    ]);
  });

  it('has no way out of REJECTED or CANCELLED', () => {
    for (const status of RETURN_TERMINAL_STATUSES) {
      expect(RETURN_TRANSITIONS[status]).toEqual([]);
    }
  });

  it('does not let a supplier take an authorization back', () => {
    expect(canMoveReturn('AUTHORIZED', 'REJECTED')).toBe(false);
  });

  it('never moves a request to REQUESTED, which is only how one is born', () => {
    for (const from of RETURN_STATUSES) expect(canMoveReturn(from, 'REQUESTED')).toBe(false);
  });

  it('numbers a request by the statuses it has reached', () => {
    expect(versionAfter('REQUESTED', 'REQUESTED')).toBe(1);
    expect(versionAfter('AUTHORIZED', 'REQUESTED')).toBe(2);
    expect(versionAfter('REJECTED', 'REQUESTED')).toBe(2);
    expect(versionAfter('CANCELLED', 'REQUESTED')).toBe(2);
    expect(versionAfter('CANCELLED', 'AUTHORIZED')).toBe(3);
  });

  it('refuses an illegal move as a business rule, and says when the request is over', () => {
    expect(() => assertReturnTransition('RET_1', 'REQUESTED', 'AUTHORIZED')).not.toThrow();

    let refusal: unknown;
    try {
      assertReturnTransition('RET_1', 'CANCELLED', 'AUTHORIZED');
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(RastaError);
    expect((refusal as RastaError).code).toBe('BUSINESS_RULE_VIOLATION');
    expect((refusal as RastaError).message).toMatch(/already CANCELLED/);

    expect(() => assertReturnTransition('RET_1', 'AUTHORIZED', 'REJECTED')).toThrow(
      /cannot move from AUTHORIZED to REJECTED/,
    );
  });
});
