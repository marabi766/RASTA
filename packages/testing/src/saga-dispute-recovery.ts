/**
 * A dispute resolution the order saga sent, whose answer it lost, retried
 * after economic-service let the stored answer expire — the exchange the
 * saga's recovery reads, written down once for both services (docs/23 D-060,
 * D-053; Codex on #322).
 *
 * No suite runs marketplace-service and economic-service together, and
 * neither may import the other (AGENTS.md A-02). Each tests its half against
 * this:
 *
 * - economic-service (`test/saga-resolution-after-ttl.int-spec.ts`): its real
 *   answers over HTTP — the refused retry, then the transaction its payer
 *   reads — are these, for a transaction resolved now and for one resolved
 *   before `disputeResolution` existed;
 * - marketplace-service (`test/saga-dispute-recovery.int-spec.ts`): its real
 *   client and saga activities, answered exactly this, take the resolution as
 *   done instead of failing the saga with the funds held.
 *
 * A change on either side that breaks the recovery fails that side's suite.
 * Both also hold `disputedAt` set: the transaction was disputed.
 */
const reason = 'The pallets arrived water-damaged on two sides.';
const resolution = 'The carrier’s photographs show the damage happened after delivery.';

export const SAGA_DISPUTE_RECOVERY = {
  /** The objection the saga mirrored. */
  reason,
  /** The operator's resolution the saga mirrored. Worded unlike the objection. */
  resolution,
  /** What the retried `resolve-dispute` is answered with, past the TTL. */
  refusedRetry: { status: 409, code: 'INVALID_STATE_TRANSITION' },
  /** What `GET /v1/transactions/{id}` then says, of the fields the recovery reads. */
  readAfter: {
    /** Resolved by an economic-service that keeps the resolution apart. */
    resolvedNow: {
      status: 'PENDING_SETTLEMENT',
      disputeReason: reason,
      disputeResolution: resolution,
    },
    /**
     * Resolved before migration `20261016160000_transaction_dispute_resolution`:
     * the resolution was written over the objection, and nothing kept it apart.
     */
    resolvedBeforeTheField: {
      status: 'PENDING_SETTLEMENT',
      disputeReason: resolution,
      disputeResolution: null,
    },
  },
} as const;

export type SagaDisputeRecoveryRow = keyof typeof SAGA_DISPUTE_RECOVERY.readAfter;
