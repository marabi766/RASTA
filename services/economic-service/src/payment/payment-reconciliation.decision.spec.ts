import {
  backoffSeconds,
  decideReconciliation,
  needsProviderAnswer,
  shouldEscalate,
  type DecisionInput,
} from './payment-reconciliation.decision';

/**
 * The reconciler's decision table (ADR-064 step B2, plan § 2.3), as a pure
 * function: every marker × provider answer × wallet status, and what may move.
 *
 * The rule the whole table rests on: **nothing moves on an answer that is not
 * an answer.** `UNKNOWN`, a timeout and a `NOT_FOUND` the provider cannot
 * vouch for are all "ask again later", never "declined".
 */
describe('decideReconciliation', () => {
  const refund = (overrides: Partial<DecisionInput>): DecisionInput => ({
    kind: 'REFUND',
    intentStatus: 'CAPTURED',
    marker: 'REFUND_UNKNOWN',
    walletStatus: 'ACTIVE',
    refundHoldActive: true,
    answer: null,
    ...overrides,
  });
  const uncredited = (overrides: Partial<DecisionInput>): DecisionInput => ({
    kind: 'UNCREDITED_REFUND',
    intentStatus: 'AUTHORIZED',
    marker: 'CAPTURED_REFUND_UNKNOWN',
    walletStatus: 'ACTIVE',
    refundHoldActive: false,
    answer: null,
    ...overrides,
  });
  const said = (refund: 'REFUNDED' | 'DECLINED' | 'NOT_FOUND' | 'UNKNOWN', authoritative = true) =>
    ({ refund, authoritative, simulated: true }) as const;

  describe('a known outcome needs no question', () => {
    it('records a refund the provider made and the ledger did not', () => {
      expect(decideReconciliation(refund({ marker: 'REFUNDED_NOT_REVERSED' }))).toEqual({
        action: 'RECORD_REFUNDED',
        resolution: 'REFUNDED',
      });
    });

    it('waits, held, rather than take money out of a wallet that is not active', () => {
      expect(
        decideReconciliation(refund({ marker: 'REFUNDED_NOT_REVERSED', walletStatus: 'FROZEN' })),
      ).toEqual({ action: 'DEFER', outcome: 'WALLET_NOT_ACTIVE' });
    });

    it('returns a declined refund’s hold, frozen wallet or not: money goes back in', () => {
      for (const walletStatus of ['ACTIVE', 'FROZEN', 'CLOSED']) {
        expect(
          decideReconciliation(refund({ marker: 'REFUND_DECLINED_RELEASE_PENDING', walletStatus })),
        ).toEqual({ action: 'RETURN_HOLD', resolution: 'REFUND_DECLINED' });
      }
    });

    it('asks the provider only about the unknown markers', () => {
      expect(needsProviderAnswer('REFUND', 'REFUND_REQUESTED')).toBe(true);
      expect(needsProviderAnswer('REFUND', 'REFUND_UNKNOWN')).toBe(true);
      expect(needsProviderAnswer('REFUND', 'REFUNDED_NOT_REVERSED')).toBe(false);
      expect(needsProviderAnswer('REFUND', 'REFUND_DECLINED_RELEASE_PENDING')).toBe(false);
      expect(needsProviderAnswer('REFUND', null)).toBe(false);
      expect(needsProviderAnswer('UNCREDITED_REFUND', 'CAPTURED_REFUND_UNKNOWN')).toBe(true);
      expect(needsProviderAnswer('UNCREDITED_REFUND', 'CAPTURED_NOT_CREDITED')).toBe(false);
    });
  });

  describe.each(['REFUND_REQUESTED', 'REFUND_UNKNOWN'])('an unknown refund (%s)', (marker) => {
    it('records it when the provider refunded', () => {
      expect(decideReconciliation(refund({ marker, answer: said('REFUNDED') }))).toEqual({
        action: 'RECORD_REFUNDED',
        resolution: 'REFUNDED',
      });
    });

    it('defers a refunded one from a wallet that is not active', () => {
      expect(
        decideReconciliation(refund({ marker, walletStatus: 'FROZEN', answer: said('REFUNDED') })),
      ).toEqual({ action: 'DEFER', outcome: 'WALLET_NOT_ACTIVE' });
    });

    it('returns the hold when the provider declined', () => {
      expect(decideReconciliation(refund({ marker, answer: said('DECLINED') }))).toEqual({
        action: 'RETURN_HOLD',
        resolution: 'REFUND_DECLINED',
      });
    });

    it('returns the hold when the provider vouches it never received the attempt', () => {
      expect(decideReconciliation(refund({ marker, answer: said('NOT_FOUND') }))).toEqual({
        action: 'RETURN_HOLD',
        resolution: 'REFUND_NOT_REACHED',
      });
    });

    it('moves nothing on a NOT_FOUND the provider cannot vouch for', () => {
      expect(decideReconciliation(refund({ marker, answer: said('NOT_FOUND', false) }))).toEqual({
        action: 'RETRY',
        outcome: 'PROVIDER_NOT_FOUND_UNCERTAIN',
      });
    });

    it('moves nothing on UNKNOWN, on no answer, or when the provider could not be reached', () => {
      expect(decideReconciliation(refund({ marker, answer: said('UNKNOWN') }))).toEqual({
        action: 'RETRY',
        outcome: 'PROVIDER_OUTCOME_UNKNOWN',
      });
      expect(decideReconciliation(refund({ marker, answer: null }))).toEqual({
        action: 'RETRY',
        outcome: 'PROVIDER_OUTCOME_UNKNOWN',
      });
      expect(decideReconciliation(refund({ marker, answer: 'UNREACHABLE' }))).toEqual({
        action: 'RETRY',
        outcome: 'PROVIDER_UNREACHABLE',
      });
    });
  });

  describe('an uncreditable capture whose refund answer was lost', () => {
    it('fails the intent when the provider refunded: nothing was credited, nothing to move', () => {
      expect(decideReconciliation(uncredited({ answer: said('REFUNDED') }))).toEqual({
        action: 'FAIL_UNCREDITED',
        resolution: 'UNCREDITED_REFUNDED',
      });
    });

    it('makes it creditable by a same-key retry when the capture is certainly still held', () => {
      expect(decideReconciliation(uncredited({ answer: said('DECLINED') }))).toEqual({
        action: 'MARK_CREDITABLE',
        resolution: 'UNCREDITED_DECLINED',
      });
      expect(decideReconciliation(uncredited({ answer: said('NOT_FOUND') }))).toEqual({
        action: 'MARK_CREDITABLE',
        resolution: 'UNCREDITED_NOT_REACHED',
      });
    });

    it('moves nothing on an answer that is not one', () => {
      expect(decideReconciliation(uncredited({ answer: said('NOT_FOUND', false) }))).toEqual({
        action: 'RETRY',
        outcome: 'PROVIDER_NOT_FOUND_UNCERTAIN',
      });
      expect(decideReconciliation(uncredited({ answer: said('UNKNOWN') }))).toEqual({
        action: 'RETRY',
        outcome: 'PROVIDER_OUTCOME_UNKNOWN',
      });
      expect(decideReconciliation(uncredited({ answer: 'UNREACHABLE' }))).toEqual({
        action: 'RETRY',
        outcome: 'PROVIDER_UNREACHABLE',
      });
    });

    it('ignores a frozen wallet: failing or marking the intent moves no money', () => {
      expect(
        decideReconciliation(uncredited({ walletStatus: 'FROZEN', answer: said('REFUNDED') })),
      ).toEqual({ action: 'FAIL_UNCREDITED', resolution: 'UNCREDITED_REFUNDED' });
    });
  });

  describe('work already done elsewhere', () => {
    it('finishes a task whose intent was settled by the request path', () => {
      for (const input of [
        refund({ intentStatus: 'REFUNDED', marker: null, refundHoldActive: false }),
        refund({ marker: null, refundHoldActive: false }),
        uncredited({ intentStatus: 'FAILED', marker: 'WALLET_BALANCE_LIMIT' }),
        uncredited({ intentStatus: 'CAPTURED', marker: null }),
        uncredited({ marker: 'CAPTURED_NOT_CREDITED' }),
      ]) {
        expect(decideReconciliation({ ...input, answer: said('REFUNDED') })).toEqual({
          action: 'NOOP',
          resolution: 'NOTHING_TO_RECONCILE',
        });
      }
    });

    it('escalates a refund hold that outlived its marker instead of hiding it', () => {
      expect(decideReconciliation(refund({ marker: null, refundHoldActive: true }))).toEqual({
        action: 'ESCALATE',
        outcome: 'HOLD_WITHOUT_MARKER',
      });
    });
  });
});

describe('backoffSeconds', () => {
  it('doubles from the base per attempt and stops at the maximum', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((attempts) => backoffSeconds(attempts, 60, 900))).toEqual([
      60, 120, 240, 480, 900, 900, 900,
    ]);
  });

  it('does not overflow on an absurd attempt count', () => {
    expect(backoffSeconds(10_000, 60, 3600)).toBe(3600);
  });
});

describe('shouldEscalate', () => {
  const createdAt = new Date('2026-09-30T00:00:00Z');
  const limits = { maxAttempts: 5, maxAgeHours: 24 };

  it('escalates at the attempt limit', () => {
    const now = new Date('2026-09-30T01:00:00Z');
    expect(shouldEscalate({ attempts: 4, createdAt, now, ...limits })).toBe(false);
    expect(shouldEscalate({ attempts: 5, createdAt, now, ...limits })).toBe(true);
  });

  it('escalates at the age limit, however few the attempts', () => {
    expect(
      shouldEscalate({ attempts: 1, createdAt, now: new Date('2026-09-30T23:59:59Z'), ...limits }),
    ).toBe(false);
    expect(
      shouldEscalate({ attempts: 1, createdAt, now: new Date('2026-10-01T00:00:00Z'), ...limits }),
    ).toBe(true);
  });
});
