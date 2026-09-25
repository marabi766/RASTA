import {
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';
import type { OrderActivities, SagaOrderView, SettledResult } from './activities';

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
 * ## The order row decides; a signal only says "look now"
 *
 * Every party command commits to the database first and signals second
 * (ADR-039 § 3). This workflow used to act on the signals themselves, as
 * in-memory flags, which made it wrong in both directions. A signal that was
 * lost — Temporal unreachable after the commit — left a committed command
 * unobserved for good. A signal that should not have arrived — once, a
 * replayed request aimed at another tenant's order — was acted on as if a
 * party had issued it.
 *
 * Now every decision is taken on a fresh read of the order (`readOrder`).
 * A signal wakes the workflow early, and a timer wakes it anyway every
 * `recheckIntervalHours`; what it then does depends only on what the order
 * says. Signal arguments are ignored, and every reason passed on to
 * economic-service is read from the order and its dispute.
 *
 * ## Determinism
 *
 * Nothing in this file reads a clock, a random number, a database or a socket.
 * Temporal re-executes workflow code on every replay, and any of those would
 * make the replay disagree with the original run. Time comes from `sleep()`
 * and `condition()`, which Temporal records; everything else is an activity.
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
export const orderDisputed = defineSignal<[string]>('orderDisputed');
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
  /**
   * Hours between re-reads of a waiting order, signal or no signal
   * (`MARKETPLACE_SAGA_RECHECK_HOURS`). Optional only so that a saga started
   * by a client older than this field still runs.
   */
  recheckIntervalHours?: number;
}

/**
 * Calls to economic-service: three attempts, and a business refusal is final.
 *
 * A business rule does not become true on a second attempt; retrying only
 * reports the same refusal later. A tenant mismatch is the same.
 */
const {
  createObligation,
  authoriseSettlement,
  settle,
  compensate,
  disputeObligation,
  resolveObligationDispute,
} = proxyActivities<OrderActivities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumAttempts: 3,
    nonRetryableErrorTypes: [
      'BUSINESS_RULE_VIOLATION',
      'VALIDATION_FAILED',
      'TENANT_MISMATCH',
      'FORBIDDEN',
      'NOT_FOUND',
    ],
  },
});

/**
 * Reads, and writes to this service's own database: retried until they answer.
 *
 * Each of these is idempotent — a read, or a transition that returns quietly
 * when the order is already where it was sent. Retrying them costs nothing.
 * Giving up on them is what cost money: a local write that failed after an
 * economic step succeeded used to be treated as though the economic step had
 * failed, and the saga then recorded the opposite of what had happened. A
 * local outage now delays the saga; it never decides anything. A refusal by
 * the state machine is still final, because it is not an outage.
 */
const {
  readOrder,
  findObligation,
  markFundsHeld,
  markFailed,
  markSettling,
  markSettlementFailed,
  markCompleted,
  markCancelled,
  recordReminder,
} = proxyActivities<OrderActivities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '5 minutes',
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

/** The env default, for a saga started by a client that did not pass one. */
const DEFAULT_RECHECK_HOURS = 24;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type OrderStatus = SagaOrderView['status'];

export async function orderSaga(input: OrderSagaInput): Promise<string> {
  const { orderId } = input;
  const recheckMs = (input.recheckIntervalHours ?? DEFAULT_RECHECK_HOURS) * HOUR;

  const status: SagaStatus = {
    phase: 'PLACING',
    deferredSteps: ['RESERVE_STOCK', 'NOTIFY_SUPPLIER'],
    remindersRecorded: 0,
    settlementAttempts: 0,
  };

  // Every signal means the same thing: something committed, look now. What
  // it names, and whatever it carries, is not trusted — the order is.
  let nudged = false;
  const look = (): void => {
    nudged = true;
  };
  setHandler(orderSagaStatus, () => status);
  setHandler(orderConfirmed, look);
  setHandler(orderFulfilled, look);
  setHandler(receiptConfirmed, look);
  setHandler(orderDisputed, look);
  setHandler(orderCancelled, look);
  setHandler(disputeResolved, look);

  /**
   * Waits for the order to leave `waitingIn`, re-reading it on every signal
   * and at least every `recheckMs`.
   *
   * With a `window`, a reminder is recorded each time the window elapses
   * (ADR-043): the window decides when to *notice*, never what to *do*.
   */
  async function waitWhile(
    waitingIn: OrderStatus,
    window?: { firstDays: number; thenDays: number },
  ): Promise<SagaOrderView> {
    let windowElapsed = false;
    let windowScope: CancellationScope | undefined;
    const armWindow = (days: number): void => {
      const scope = new CancellationScope();
      windowScope = scope;
      scope
        .run(() => sleep(days * DAY))
        .then(
          () => {
            windowElapsed = true;
          },
          (error: unknown) => {
            if (!isCancellation(error)) throw error;
          },
        );
    };

    if (window) armWindow(window.firstDays);
    try {
      for (;;) {
        await condition(() => nudged || windowElapsed, recheckMs);
        // Cleared before the read, not after: a signal that arrives while the
        // read is in flight may be about a commit the read did not see, and it
        // must wake the next wait rather than be swallowed.
        nudged = false;
        const order = await readOrder(orderId);
        if (order.status !== waitingIn) return order;

        if (window && windowElapsed) {
          windowElapsed = false;
          await recordReminder(orderId);
          status.remindersRecorded += 1;
          armWindow(window.thenDays);
        }
      }
    } finally {
      windowScope?.cancel();
    }
  }

  /**
   * Places the hold, and establishes whether it happened when the call cannot
   * say.
   *
   * A timeout, a lost response or an exhausted retry does not mean nothing
   * moved: economic-service may have committed the hold. Only
   * economic-service knows, and it keeps at most one obligation per order, so
   * the saga asks before concluding anything. This is the difference between
   * an order recorded `FAILED` with its buyer's money held and nothing to
   * release it, and an order that carries on.
   */
  async function placeHold(): Promise<
    { held: true; transactionId: string } | { held: false; reason: string }
  > {
    try {
      const held = await createObligation(orderId);
      return { held: true, transactionId: held.transactionId };
    } catch (error) {
      const found = await findObligation(orderId);
      if (found) return { held: true, transactionId: found.transactionId };
      return { held: false, reason: describe(error) };
    }
  }

  /**
   * Settles an order whose receipt is confirmed. `true` once `COMPLETED`;
   * `false` when a dispute got in first and the order must be read again.
   */
  async function settleOrder(transactionId: string): Promise<boolean> {
    status.phase = 'SETTLING';
    await authoriseSettlement(orderId, transactionId);

    for (let attempt = 1; attempt <= SETTLEMENT_ATTEMPTS; attempt += 1) {
      status.settlementAttempts = attempt;

      // A dispute can commit between the read that brought the saga here and
      // this call. It yields instead of being refused, and the saga goes back
      // to the dispute. A refused `markSettling` used to count as a failed
      // settlement attempt, and `markSettlementFailed` then moved the order
      // `DISPUTED -> RECEIPT_CONFIRMED` — erasing the dispute.
      if ((await markSettling(orderId)) !== 'SETTLING') return false;

      let settlement: SettledResult;
      try {
        settlement = await settle(orderId, transactionId);
      } catch (error) {
        await markSettlementFailed(orderId);
        if (attempt === SETTLEMENT_ATTEMPTS) {
          // CONSTRAINT (`docs/08` § 8.4): no automatic financial compensation
          // after this point. The funds stay held and a human decides. Undoing
          // a payment the platform is not sure failed is a larger risk than
          // the failure itself.
          status.phase = 'SETTLEMENT_EXHAUSTED';
          throw ApplicationFailure.nonRetryable(
            'Settlement did not succeed and needs a human decision; funds remain held',
            'SETTLEMENT_EXHAUSTED',
            describe(error),
          );
        }
        // Deterministic backoff between attempts, from Temporal's own clock.
        // The key is the same on every attempt, so an attempt whose reply was
        // lost is answered on the next one by economic-service's replay.
        await sleep(`${attempt * 30} seconds`);
        continue;
      }

      // The money has moved. Recording it is not part of the settlement and
      // cannot fail it: it shared a `catch` with `settle()` once, and a local
      // write failing after a successful settlement recorded the order as a
      // failed settlement with "funds remain held".
      try {
        await markCompleted(orderId, settlement);
      } catch (error) {
        status.phase = 'SETTLED_NOT_RECORDED';
        throw ApplicationFailure.nonRetryable(
          `Settlement ${settlement.settlementId} succeeded but the order could not record it`,
          'SETTLED_NOT_RECORDED',
          describe(error),
        );
      }
      status.phase = 'COMPLETED';
      return true;
    }
    return false;
  }

  // ---- 1. The obligation and the escrow, in one call ----------------------
  //
  // Not two: creating the obligation and holding the money separately leaves a
  // window in which the buyer can spend what they have just committed.
  let order = await readOrder(orderId);

  if (order.status === 'PENDING') {
    status.phase = 'CREATING_OBLIGATION';
    const hold = await placeHold();

    if (!hold.held) {
      // economic-service holds nothing for this order. The order failed —
      // unless the buyer cancelled first, in which case it was cancelled, and
      // with nothing held there is nothing to refund.
      status.phase = 'FAILED';
      if ((await markFailed(orderId, hold.reason)) === 'FAILED') return 'FAILED';
    } else {
      // The hold is recorded on the order whatever else has happened. If the
      // buyer cancelled while it was being placed, this returns CANCELLING
      // and the loop below refunds it.
      await markFundsHeld(orderId, hold.transactionId);
    }
    order = await readOrder(orderId);
  }

  // ---- 2. Follow the order until it ends ----------------------------------
  let disputeMirrored = false;

  for (;;) {
    switch (order.status) {
      case 'FUNDS_HELD':
        status.phase = 'AWAITING_CONFIRMATION';
        order = await waitWhile('FUNDS_HELD', {
          firstDays: input.fulfillmentWindowDays,
          thenDays: input.reminderIntervalDays,
        });
        break;

      case 'CONFIRMED':
        status.phase = 'AWAITING_FULFILMENT';
        order = await waitWhile('CONFIRMED', {
          firstDays: input.fulfillmentWindowDays,
          thenDays: input.reminderIntervalDays,
        });
        break;

      // The wait that has no timeout. Expiry records a reminder and waits again.
      case 'AWAITING_RECEIPT_CONFIRMATION':
        status.phase = 'AWAITING_RECEIPT_CONFIRMATION';
        order = await waitWhile('AWAITING_RECEIPT_CONFIRMATION', {
          firstDays: input.receiptWindowDays,
          thenDays: input.reminderIntervalDays,
        });
        break;

      // A dispute stops everything until somebody decides.
      case 'DISPUTED':
        status.phase = 'DISPUTED';
        if (!disputeMirrored) {
          // economic-service is told too, so a direct settlement command there
          // is refused independently of anything this service does (ADR-040 § 5).
          await disputeObligation(
            orderId,
            heldTransaction(order),
            order.dispute?.reason ?? 'A dispute was raised on this order',
          );
          disputeMirrored = true;
        }
        // No window. A dispute that expired into anything would be worse than
        // one that waits: money would move because nobody looked.
        order = await waitWhile('DISPUTED');
        break;

      case 'RECEIPT_CONFIRMED':
      case 'SETTLING':
        if (disputeMirrored) {
          // The resolution is mirrored back, or economic-service would still
          // refuse to settle a transaction it believes is disputed.
          await resolveObligationDispute(
            orderId,
            heldTransaction(order),
            order.dispute?.resolution ?? 'Dispute resolved: SETTLE',
          );
          disputeMirrored = false;
        }
        if (await settleOrder(heldTransaction(order))) return 'COMPLETED';
        order = await readOrder(orderId);
        break;

      // ---- Compensation ---------------------------------------------------
      case 'CANCELLING': {
        if (disputeMirrored) {
          await resolveObligationDispute(
            orderId,
            heldTransaction(order),
            order.dispute?.resolution ?? 'Dispute resolved: REFUND',
          );
          disputeMirrored = false;
        }
        status.phase = 'COMPENSATING';
        const reason = order.cancellationReason ?? 'Cancelled';
        // An order cancelled before its hold was recorded may still have one:
        // economic-service is asked rather than assumed, as in step 1.
        const transactionId =
          order.economicTransactionId ?? (await findObligation(orderId))?.transactionId;
        if (transactionId) await compensate(orderId, transactionId, reason);
        await markCancelled(orderId, reason);
        status.phase = 'CANCELLED';
        return 'CANCELLED';
      }

      case 'COMPLETED':
      case 'CANCELLED':
      case 'FAILED':
        status.phase = order.status;
        return order.status;

      default:
        // PENDING after step 1 — the saga cannot place a hold it has already
        // resolved. Stop for a human rather than guess.
        throw ApplicationFailure.nonRetryable(
          `The order saga found order ${orderId} ${order.status} after placing its hold`,
          'SAGA_INCONSISTENT',
        );
    }
  }
}

/** The obligation an order past `PENDING` holds. The row constraint guarantees one. */
function heldTransaction(order: SagaOrderView): string {
  if (order.economicTransactionId) return order.economicTransactionId;
  throw ApplicationFailure.nonRetryable(
    `Order is ${order.status} with no economic transaction recorded`,
    'SAGA_INCONSISTENT',
  );
}

function describe(error: unknown): string {
  // An activity's failure is wrapped: the refusal economic-service gave is the
  // cause, and "Activity task failed" says nothing about it.
  if (error instanceof ActivityFailure && error.cause instanceof Error) return error.cause.message;
  if (error instanceof Error) return error.message;
  return 'The financial service refused the operation';
}
