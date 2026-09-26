import { isRastaError } from '@rasta/nest-common';
import {
  APPROVAL_STATES,
  APPROVAL_TRANSITIONS,
  POLICY_STATES,
  assertDecidable,
  assertPolicyTransition,
  canTransitionApproval,
  canTransitionPolicy,
  stepApplies,
} from './approval.state-machine';

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return isRastaError(error) ? error.code : `NOT_A_PLATFORM_ERROR: ${String(error)}`;
  }
  return 'NO_ERROR';
}

describe('the policy lifecycle', () => {
  const LEGAL = ['DRAFT→ACTIVE', 'ACTIVE→RETIRED'];

  it.each(POLICY_STATES.flatMap((from) => POLICY_STATES.map((to) => [from, to] as const)))(
    '%s → %s',
    (from, to) => {
      const legal = LEGAL.includes(`${from}→${to}`);
      expect(canTransitionPolicy(from, to)).toBe(legal);
      expect(codeOf(() => assertPolicyTransition('APL_1', from, to))).toBe(
        legal ? 'NO_ERROR' : 'BUSINESS_RULE_VIOLATION',
      );
    },
  );
});

describe('the approval lifecycle', () => {
  const LEGAL = [
    'QUEUED→PENDING',
    'QUEUED→SUPERSEDED',
    'PENDING→GRANTED',
    'PENDING→REJECTED',
    'PENDING→SUPERSEDED',
  ];

  it.each(APPROVAL_STATES.flatMap((from) => APPROVAL_STATES.map((to) => [from, to] as const)))(
    '%s → %s',
    (from, to) => {
      expect(canTransitionApproval(from, to)).toBe(LEGAL.includes(`${from}→${to}`));
    },
  );

  it('has no automatic edge and three terminal states', () => {
    expect(APPROVAL_STATES.filter((state) => APPROVAL_TRANSITIONS[state].length === 0)).toEqual([
      'GRANTED',
      'REJECTED',
      'SUPERSEDED',
    ]);
  });

  it('decides only a PENDING step, and says why otherwise', () => {
    expect(codeOf(() => assertDecidable('APR_1', 'PENDING'))).toBe('NO_ERROR');
    expect(() => assertDecidable('APR_1', 'QUEUED')).toThrow(/earlier step is still undecided/);
    for (const status of ['GRANTED', 'REJECTED', 'SUPERSEDED'] as const) {
      expect(() => assertDecidable('APR_1', status)).toThrow(/cannot be decided again/);
    }
  });
});

describe('which steps apply to an estimate (Q-70)', () => {
  const step = (min: bigint | null, max: bigint | null) => ({
    minAmountMinor: min,
    maxAmountMinor: max,
  });

  it('applies an unbounded step always, even without an estimate', () => {
    expect(stepApplies(step(null, null), null)).toBe(true);
    expect(stepApplies(step(null, null), 5n)).toBe(true);
  });

  it('never applies a bounded step without an estimate — which leads to a refusal, not an approval', () => {
    expect(stepApplies(step(0n, null), null)).toBe(false);
    expect(stepApplies(step(null, 10n), null)).toBe(false);
  });

  it('treats min as inclusive and max as exclusive', () => {
    expect(stepApplies(step(100n, 200n), 99n)).toBe(false);
    expect(stepApplies(step(100n, 200n), 100n)).toBe(true);
    expect(stepApplies(step(100n, 200n), 199n)).toBe(true);
    expect(stepApplies(step(100n, 200n), 200n)).toBe(false);
  });

  it('handles amounts beyond 2^53 exactly', () => {
    const big = 9_223_372_036_854_775_806n;
    expect(stepApplies(step(big, null), big)).toBe(true);
    expect(stepApplies(step(null, big), big)).toBe(false);
  });
});
