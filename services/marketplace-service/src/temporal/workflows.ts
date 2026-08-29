import {
  ApplicationFailure,
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';
import type { OrderActivities } from './activities';

/**
 * `OrderSagaWorkflow` — the platform's first real Temporal workflow (ADR-039).
 *
 * ## Why this one, when ADR-027 and ADR-031 both declined Temporal
 *
 * Both declined it correctly. Maintenance due-dates are derived on read;
 * settlement is a single `BEGIN … COMMIT`. Neither has state that outlives a
 * process. An order does: it waits days for a supplier to deliver and then
 * days for a buyer to confirm, and something has to hold that wait across
 * restarts and then compensate in reverse order if it ends badly.
 *
 * ## Determinism
 *
 * Nothing in this file reads a clock, a random number, a database or a socket.
 * Temporal re-executes workflow code on every replay, and any of those would
 * make the replay disagree with the original run. Time comes from `sleep()`,
 * which Temporal records; everything else is an activity.
 *
 * ## What expiry does NOT do
 *
 * There is no timer that confirms receipt, cancels an order, or moves money
 * (ADR-043, Q-11). A window elapsing records a reminder and the workflow goes
 * back to waiting. An unconfirmed order waits indefinitely, on purpose:
 * automatic confirmation would release money without the buyer's consent, and
 * the platform is not entitled to infer that consent from silence.
 */

export const orderConfirmed = defineSignal('orderConfirmed');
export const orderFulfilled = defineSignal('orderFulfilled');
export const receiptConfirmed = defineSignal('receiptConfirmed');
export const orderDisputed = defineSignal('orderDisputed');
export const orderCancelled = defineSignal<[string]>('orderCancelled');
export const disputeResolved = defineSignal<['SETTLE' | 'REFUND']>('disputeResolved');

export const orderSagaStatus = defineQuery<SagaStatus>('status');

export interface SagaStatus {
  phase: string;
  /**
   * Steps that are part of the documented saga but have no implementation.
   *
   * `docs/08` § 8.4 step 3 is `inventory.reserveStock`. inventory-service does
   * not exist, so the step is named and marked deferred rather than deleted —
   * deleting it would mean someone has to rediscover that it was ever required
   * (ADR-041 § 2).
   */
  deferredSteps: string[];
  remindersRecorded: number;
  settlementAttempts: number;
}

export interface OrderSagaInput {
  orderId: string;
  /** Days before an unfulfilled order is counted overdue. */
  fulfillmentWindowDays: number;
  /** Days before an unconfirmed delivery is counted overdue. */
  receiptWindowDays: number;
  /** Days between reminders once a window has elapsed. */
  reminderIntervalDays: number;
}

const {
  createObligation,
  markFundsHeld,
  markFailed,
  authoriseSettlement,
  settle,
  markSettling,
  markSettlementFailed,
  markCompleted,
  compensate,
  markCancelled,
  recordReminder,
} = proxyActivities<OrderActivities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumAttempts: 3,
    // A business rule does not become true on a second attempt; retrying only
    // reports the same refusal later. A tenant mismatch is the same.
    nonRetryableErrorTypes: [
      'BUSINESS_RULE_VIOLATION',
      'VALIDATION_FAILED',
      'TENANT_MISMATCH',
      'FORBIDDEN',
      'NOT_FOUND',
    ],
  },
});

/** `docs/08` § 8.4 gives settlement five attempts before a human is needed. */
const SETTLEMENT_ATTEMPTS = 5;

const DAY = 24 * 60 * 60 * 1000;

export async function orderSaga(input: OrderSagaInput): Promise<string> {
  const state = {
    confirmed: false,
    fulfilled: false,
    receipted: false,
    disputed: false,
    cancelled: false,
    cancelReason: '',
    disputeOutcome: undefined as 'SETTLE' | 'REFUND' | undefined,
  };

  const status: SagaStatus = {
    phase: 'PLACING',
    deferredSteps: ['RESERVE_STOCK', 'NOTIFY_SUPPLIER'],
    remindersRecorded: 0,
    settlementAttempts: 0,
  };

  setHandler(orderSagaStatus, () => status);
  setHandler(orderConfirmed, () => {
    state.confirmed = true;
  });
  setHandler(orderFulfilled, () => {
    state.fulfilled = true;
  });
  setHandler(receiptConfirmed, () => {
    state.receipted = true;
  });
  setHandler(orderDisputed, () => {
    state.disputed = true;
  });
  setHandler(orderCancelled, (reason: string) => {
    state.cancelled = true;
    state.cancelReason = reason;
  });
  setHandler(disputeResolved, (outcome: 'SETTLE' | 'REFUND') => {
    state.disputeOutcome = outcome;
    state.disputed = false;
    if (outcome === 'REFUND') {
      state.cancelled = true;
      state.cancelReason = 'Dispute resolved in favour of a refund';
    } else {
      state.receipted = true;
    }
  });

  // ---- 1. The obligation and the escrow, in one call ----------------------
  //
  // Not two: creating the obligation and holding the money separately leaves a
  // window in which the buyer can spend what they have just committed.
  status.phase = 'CREATING_OBLIGATION';
  let transactionId: string;
  try {
    const held = await createObligation(input.orderId);
    transactionId = held.transactionId;
    await markFundsHeld(input.orderId, transactionId);
  } catch (error) {
    // The usual cause is an empty wallet. Nothing has moved, so there is
    // nothing to compensate — the order simply did not happen.
    status.phase = 'FAILED';
    await markFailed(input.orderId, describe(error));
    return 'FAILED';
  }

  // ---- 2. Wait for the supplier -------------------------------------------
  status.phase = 'AWAITING_CONFIRMATION';
  await waitWithReminders(
    () => state.confirmed || state.cancelled || state.disputed,
    input.fulfillmentWindowDays,
    input.reminderIntervalDays,
    input.orderId,
    status,
  );

  if (!state.cancelled && !state.disputed) {
    status.phase = 'AWAITING_FULFILMENT';
    await waitWithReminders(
      () => state.fulfilled || state.cancelled || state.disputed,
      input.fulfillmentWindowDays,
      input.reminderIntervalDays,
      input.orderId,
      status,
    );
  }

  // ---- 3. Wait for the buyer ----------------------------------------------
  //
  // The wait that has no timeout. Expiry records a reminder and waits again.
  if (!state.cancelled && !state.disputed) {
    status.phase = 'AWAITING_RECEIPT_CONFIRMATION';
    await waitWithReminders(
      () => state.receipted || state.cancelled || state.disputed,
      input.receiptWindowDays,
      input.reminderIntervalDays,
      input.orderId,
      status,
    );
  }

  // ---- 4. A dispute stops everything until somebody decides ---------------
  if (state.disputed) {
    status.phase = 'DISPUTED';
    // No timeout. A dispute that expired into a settlement would be worse than
    // one that waits: the money would move because nobody looked.
    await condition(() => state.disputeOutcome !== undefined);
  }

  // ---- 5. Compensation ----------------------------------------------------
  if (state.cancelled) {
    status.phase = 'COMPENSATING';
    await compensate(input.orderId, transactionId, state.cancelReason || 'Cancelled');
    await markCancelled(input.orderId, state.cancelReason || 'Cancelled');
    status.phase = 'CANCELLED';
    return 'CANCELLED';
  }

  // ---- 6. Settlement ------------------------------------------------------
  status.phase = 'SETTLING';
  await authoriseSettlement(input.orderId, transactionId);

  for (let attempt = 1; attempt <= SETTLEMENT_ATTEMPTS; attempt += 1) {
    status.settlementAttempts = attempt;
    try {
      await markSettling(input.orderId);
      const result = await settle(input.orderId, transactionId);
      await markCompleted(input.orderId, result);
      status.phase = 'COMPLETED';
      return 'COMPLETED';
    } catch (error) {
      await markSettlementFailed(input.orderId);
      if (attempt === SETTLEMENT_ATTEMPTS) {
        // CONSTRAINT (`docs/08` § 8.4): no automatic financial compensation
        // after this point. The funds stay held and a human decides. Undoing a
        // payment the platform is not sure failed is a larger risk than the
        // failure itself.
        status.phase = 'SETTLEMENT_EXHAUSTED';
        throw ApplicationFailure.nonRetryable(
          'Settlement did not succeed and needs a human decision; funds remain held',
          'SETTLEMENT_EXHAUSTED',
          describe(error),
        );
      }
      // Deterministic backoff between attempts, from Temporal's own clock.
      await sleep(`${attempt * 30} seconds`);
    }
  }

  return status.phase;
}

/**
 * Waits for a condition, recording a reminder each time a window elapses.
 *
 * The shape ADR-043 requires: the window decides when to *notice*, never what
 * to *do*. There is no branch here that settles, cancels or confirms.
 */
async function waitWithReminders(
  done: () => boolean,
  windowDays: number,
  reminderIntervalDays: number,
  orderId: string,
  status: SagaStatus,
): Promise<void> {
  const satisfied = await condition(done, windowDays * DAY);
  if (satisfied) return;

  // Past the window and still waiting. Keep waiting, and keep counting.
  for (;;) {
    await recordReminder(orderId);
    status.remindersRecorded += 1;
    const resolved = await condition(done, reminderIntervalDays * DAY);
    if (resolved) return;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'The financial service refused the operation';
}
