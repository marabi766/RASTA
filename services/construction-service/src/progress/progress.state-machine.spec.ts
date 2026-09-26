import { isRastaError } from '@rasta/nest-common';
import {
  FULL_PROGRESS_BASIS_POINTS,
  PROGRESS_STATES,
  assertProgressTransition,
  canTransitionProgress,
} from './progress.state-machine';

describe('the progress-report lifecycle (Q-72)', () => {
  const LEGAL = ['DRAFT→SUBMITTED', 'DRAFT→DISCARDED'];

  it.each(PROGRESS_STATES.flatMap((from) => PROGRESS_STATES.map((to) => [from, to] as const)))(
    '%s → %s',
    (from, to) => {
      const legal = LEGAL.includes(`${from}→${to}`);
      expect(canTransitionProgress(from, to)).toBe(legal);
      let code = 'NO_ERROR';
      try {
        assertProgressTransition('PRG_1', from, to);
      } catch (error) {
        code = isRastaError(error) ? error.code : 'OTHER';
      }
      expect(code).toBe(legal ? 'NO_ERROR' : 'BUSINESS_RULE_VIOLATION');
    },
  );

  it('defines full progress as 10000 basis points', () => {
    expect(FULL_PROGRESS_BASIS_POINTS).toBe(10_000);
  });
});
