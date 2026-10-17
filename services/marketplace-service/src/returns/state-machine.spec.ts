import { RastaError } from '@rasta/nest-common';
import {
  PHYSICAL_RETURN_STATUSES,
  RETURN_STATUSES,
  RETURN_STATUSES_HOLDING_UNITS,
  RETURN_TERMINAL_STATUSES,
  RETURN_TRANSITIONS,
  assertReturnTransition,
  canMoveReturn,
  versionAfter,
} from './state-machine';

describe('return request state machine (ADR-048 § 3)', () => {
  it('allows exactly the commercial moves and the physical steps in order', () => {
    const allowed = RETURN_STATUSES.flatMap((from) =>
      RETURN_STATUSES.filter((to) => canMoveReturn(from, to)).map((to) => `${from}>${to}`),
    );
    expect(allowed.sort()).toEqual([
      'AUTHORIZED>CANCELLED',
      'AUTHORIZED>IN_TRANSIT',
      'INSPECTED>RESOLVED',
      'IN_TRANSIT>RECEIVED',
      'RECEIVED>INSPECTED',
      'REQUESTED>AUTHORIZED',
      'REQUESTED>CANCELLED',
      'REQUESTED>REJECTED',
    ]);
  });

  it('has no way out of REJECTED, CANCELLED or RESOLVED', () => {
    expect(RETURN_TERMINAL_STATUSES).toEqual(['REJECTED', 'CANCELLED', 'RESOLVED']);
    for (const status of RETURN_TERMINAL_STATUSES) {
      expect(RETURN_TRANSITIONS[status]).toEqual([]);
    }
  });

  it('does not let the buyer cancel goods already on the road (Q-133 (5))', () => {
    for (const from of PHYSICAL_RETURN_STATUSES) {
      expect(canMoveReturn(from, 'CANCELLED')).toBe(false);
    }
  });

  it('counts every request not refused or withdrawn against the order line', () => {
    expect([...RETURN_STATUSES_HOLDING_UNITS].sort()).toEqual(
      ['AUTHORIZED', 'INSPECTED', 'IN_TRANSIT', 'RECEIVED', 'REQUESTED', 'RESOLVED'].sort(),
    );
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
    expect(versionAfter('IN_TRANSIT', 'AUTHORIZED')).toBe(3);
    expect(versionAfter('RECEIVED', 'IN_TRANSIT')).toBe(4);
    expect(versionAfter('INSPECTED', 'RECEIVED')).toBe(5);
    expect(versionAfter('RESOLVED', 'INSPECTED')).toBe(6);
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
