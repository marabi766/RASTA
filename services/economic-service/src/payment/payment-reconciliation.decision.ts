import type { RefundStatusResult } from './provider';
import type { PaymentReconciliationKind } from './payment-reconciliation.repository';

/**
 * The reconciler's decision table (ADR-064 step B2, plan § 2.3), as a pure
 * function of what is on the row under lock and what the provider said.
 *
 * The rule it rests on: **nothing moves on an answer that is not an answer.**
 * `UNKNOWN`, a timeout, and a `NOT_FOUND` the provider does not vouch for all
 * mean "ask again later". Money moves only through the paths the request
 * already uses — step 3's reversal, the declined-hold release, `fail` — and a
 * reversal never takes money out of a wallet that is not ACTIVE.
 */

export type ProviderRefundAnswer = RefundStatusResult | 'UNREACHABLE' | null;

export interface DecisionInput {
  kind: PaymentReconciliationKind;
  intentStatus: string;
  /** `payment_intent.failure_reason`, read under the intent's row lock. */
  marker: string | null;
  walletStatus: string;
  /** For a REFUND task: whether the refund's escrow hold is still ACTIVE. */
  refundHoldActive: boolean;
  /** Null when the provider was not asked (a known marker needs no question). */
  answer: ProviderRefundAnswer;
}

export type Resolution =
  | 'REFUNDED'
  | 'REFUND_DECLINED'
  | 'REFUND_NOT_REACHED'
  | 'UNCREDITED_REFUNDED'
  | 'UNCREDITED_DECLINED'
  | 'UNCREDITED_NOT_REACHED'
  | 'NOTHING_TO_RECONCILE';

export type Verdict =
  | { action: 'RECORD_REFUNDED'; resolution: 'REFUNDED' }
  | { action: 'RETURN_HOLD'; resolution: 'REFUND_DECLINED' | 'REFUND_NOT_REACHED' }
  | { action: 'FAIL_UNCREDITED'; resolution: 'UNCREDITED_REFUNDED' }
  | { action: 'MARK_CREDITABLE'; resolution: 'UNCREDITED_DECLINED' | 'UNCREDITED_NOT_REACHED' }
  | { action: 'NOOP'; resolution: 'NOTHING_TO_RECONCILE' }
  | { action: 'DEFER'; outcome: 'WALLET_NOT_ACTIVE' }
  | {
      action: 'RETRY';
      outcome: 'PROVIDER_OUTCOME_UNKNOWN' | 'PROVIDER_NOT_FOUND_UNCERTAIN' | 'PROVIDER_UNREACHABLE';
    }
  | { action: 'ESCALATE'; outcome: 'HOLD_WITHOUT_MARKER' };

const UNKNOWN_REFUND = new Set(['REFUND_REQUESTED', 'REFUND_UNKNOWN']);
const REFUND_MARKERS = new Set([
  'REFUND_REQUESTED',
  'REFUND_UNKNOWN',
  'REFUNDED_NOT_REVERSED',
  'REFUND_DECLINED_RELEASE_PENDING',
]);

/** Whether the provider must be asked before this marker can be resolved. */
export function needsProviderAnswer(
  kind: PaymentReconciliationKind,
  marker: string | null,
): boolean {
  if (marker === null) return false;
  return kind === 'REFUND' ? UNKNOWN_REFUND.has(marker) : marker === 'CAPTURED_REFUND_UNKNOWN';
}

/** The retry an answer that is not an answer calls for. */
function retryFor(answer: ProviderRefundAnswer): Verdict {
  if (answer === 'UNREACHABLE') return { action: 'RETRY', outcome: 'PROVIDER_UNREACHABLE' };
  if (answer?.refund === 'NOT_FOUND') {
    return { action: 'RETRY', outcome: 'PROVIDER_NOT_FOUND_UNCERTAIN' };
  }
  return { action: 'RETRY', outcome: 'PROVIDER_OUTCOME_UNKNOWN' };
}

/** What the provider's answer established, or null when it established nothing. */
function established(answer: ProviderRefundAnswer): 'REFUNDED' | 'DECLINED' | 'NOT_REACHED' | null {
  if (answer === null || answer === 'UNREACHABLE') return null;
  if (answer.refund === 'REFUNDED') return 'REFUNDED';
  if (answer.refund === 'DECLINED') return 'DECLINED';
  if (answer.refund === 'NOT_FOUND' && answer.authoritative) return 'NOT_REACHED';
  return null;
}

export function decideReconciliation(input: DecisionInput): Verdict {
  return input.kind === 'REFUND' ? decideRefund(input) : decideUncredited(input);
}

function decideRefund(input: DecisionInput): Verdict {
  const marker = input.marker;
  if (input.intentStatus !== 'CAPTURED' || marker === null || !REFUND_MARKERS.has(marker)) {
    // Settled elsewhere — unless its hold is still out, which nothing here may
    // guess about: that is a person's.
    return input.intentStatus === 'CAPTURED' && input.refundHoldActive
      ? { action: 'ESCALATE', outcome: 'HOLD_WITHOUT_MARKER' }
      : { action: 'NOOP', resolution: 'NOTHING_TO_RECONCILE' };
  }

  // Money back into the wallet: allowed whatever the wallet's status.
  if (marker === 'REFUND_DECLINED_RELEASE_PENDING') {
    return { action: 'RETURN_HOLD', resolution: 'REFUND_DECLINED' };
  }

  const outcome = marker === 'REFUNDED_NOT_REVERSED' ? 'REFUNDED' : established(input.answer);
  if (outcome === 'REFUNDED') {
    // The reversal takes money out of the wallet: never from one that is not
    // ACTIVE (PM ruling, round 2 on #143). It waits, held.
    return input.walletStatus === 'ACTIVE'
      ? { action: 'RECORD_REFUNDED', resolution: 'REFUNDED' }
      : { action: 'DEFER', outcome: 'WALLET_NOT_ACTIVE' };
  }
  if (outcome === 'DECLINED') return { action: 'RETURN_HOLD', resolution: 'REFUND_DECLINED' };
  if (outcome === 'NOT_REACHED') return { action: 'RETURN_HOLD', resolution: 'REFUND_NOT_REACHED' };
  return retryFor(input.answer);
}

function decideUncredited(input: DecisionInput): Verdict {
  if (input.intentStatus !== 'AUTHORIZED' || input.marker !== 'CAPTURED_REFUND_UNKNOWN') {
    return { action: 'NOOP', resolution: 'NOTHING_TO_RECONCILE' };
  }
  // No wallet money moves on either branch: nothing was credited.
  const outcome = established(input.answer);
  if (outcome === 'REFUNDED')
    return { action: 'FAIL_UNCREDITED', resolution: 'UNCREDITED_REFUNDED' };
  if (outcome === 'DECLINED') {
    return { action: 'MARK_CREDITABLE', resolution: 'UNCREDITED_DECLINED' };
  }
  if (outcome === 'NOT_REACHED') {
    return { action: 'MARK_CREDITABLE', resolution: 'UNCREDITED_NOT_REACHED' };
  }
  return retryFor(input.answer);
}

/** `min(base · 2^attempts, max)`, without overflowing on a large count. */
export function backoffSeconds(attempts: number, baseSeconds: number, maxSeconds: number): number {
  return Math.min(maxSeconds, baseSeconds * 2 ** Math.min(Math.max(attempts, 0), 30));
}

/** Past what the sweeper may try on its own: the attempt limit or the age limit. */
export function shouldEscalate(input: {
  /** Attempts including the one just made. */
  attempts: number;
  createdAt: Date;
  now: Date;
  maxAttempts: number;
  maxAgeHours: number;
}): boolean {
  const ageMs = input.now.getTime() - input.createdAt.getTime();
  return input.attempts >= input.maxAttempts || ageMs >= input.maxAgeHours * 3_600_000;
}
