import { RastaError } from '@rasta/nest-common';
import { RewardGrantError, isPermanentGrantFailure } from './reward.service';

/**
 * Which grant failures the reward consumer may dead-letter at once, and which
 * it must leave to be redelivered (global audit L7-13).
 *
 * The asymmetry is the point: retrying a permanent failure costs a delay,
 * abandoning a transient one loses a reward. So only a platform verdict on
 * the grant itself is permanent, and anything unclassified is not.
 */

describe('isPermanentGrantFailure', () => {
  it.each([
    RastaError.businessRule('A credit must be positive'),
    RastaError.validation([{ path: 'amountMinor', message: 'too large' }]),
    RastaError.ledgerUnbalanced('JNL_1', '1'),
  ])('treats a verdict on the grant as permanent: %s', (error) => {
    expect(isPermanentGrantFailure(error)).toBe(true);
  });

  it.each([
    new Error('Connection terminated unexpectedly'),
    RastaError.optimisticLockFailed('WalletHold', 'HLD_1'),
    RastaError.upstreamUnavailable('fleet-service'),
    RastaError.internal('Reward balance row vanished while locking it'),
    'a string',
    undefined,
  ])('treats anything else as transient: %s', (error) => {
    expect(isPermanentGrantFailure(error)).toBe(false);
  });
});

describe('RewardGrantError', () => {
  const verdict = RastaError.businessRule('refused');
  const blip = new Error('deadlock detected');

  it('is permanent only when every failed rule was refused', () => {
    expect(new RewardGrantError([], [{ ruleId: 'RWR_A', error: verdict }]).permanent).toBe(true);
    expect(
      new RewardGrantError(
        [],
        [
          { ruleId: 'RWR_A', error: verdict },
          { ruleId: 'RWR_B', error: blip },
        ],
      ).permanent,
    ).toBe(false);
  });

  it('names every failed rule and keeps what did commit', () => {
    const granted = {
      kind: 'SKIPPED' as const,
      reason: 'cap_reached',
      ruleId: 'RWR_C',
    };
    const error = new RewardGrantError(
      [granted],
      [
        { ruleId: 'RWR_A', error: verdict },
        { ruleId: 'RWR_B', error: blip },
      ],
    );
    expect(error.message).toContain('RWR_A (BUSINESS_RULE_VIOLATION: refused)');
    expect(error.message).toContain('RWR_B (Error: deadlock detected)');
    expect(error.outcomes).toEqual([granted]);
    expect(error.name).toBe('RewardGrantError');
  });

  it('describes a failure that is not an Error', () => {
    expect(new RewardGrantError([], [{ ruleId: 'RWR_A', error: 42 }]).message).toContain(
      'RWR_A (42)',
    );
  });
});
