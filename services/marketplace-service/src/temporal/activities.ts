import { Logger } from '@nestjs/common';
import { ApplicationFailure, Context } from '@temporalio/activity';
import {
  createSystemContext,
  isRastaError,
  runWithContext,
  type RequestContext,
} from '@rasta/nest-common';
import { ulid } from 'ulid';
import type { OrderService } from '../order/order.service';
import type { SagaActivity, SagaStep } from '../order/order.repository';
import type { OrderStatus } from '../generated/prisma';
import type { EconomicClient, TransactionDetailView } from '../economic/economic.client';
import { SERVICE_NAME } from '../config/env';
import { settlementsExhaustedTotal } from '../observability/metrics';

/**
 * Everything the order saga does that touches the world.
 *
 * All I/O lives here rather than in the workflow, because Temporal re-executes
 * workflow code on replay and a database read there would produce a different
 * answer the second time. An activity runs once per attempt and its result is
 * recorded.
 *
 * ## Context
 *
 * An activity has no HTTP request behind it, so it establishes its own
 * `RequestContext` — a SYSTEM actor with the order's own correlation id, so a
 * saga step is traceable back to the request that started it. The organization
 * on that context is the **buyer's**, taken from the order row, which is what
 * makes the internal token this service mints name the right tenant (ADR-035).
 *
 * ## Idempotency: a retry answers what the first attempt answered (D-053)
 *
 * Temporal re-runs an activity whose completion it did not record: the worker
 * crashed or shut down after the work committed, or the answer was lost on
 * the way. Every activity with an effect is safe to re-run, and not by
 * looking at where the order is now — a party may have moved it since:
 *
 * - a local transition (`mark*`) and `recordReminder` record their outcome
 *   under the step's key in their own transaction; a retry that finds the
 *   record returns it and changes nothing;
 * - an economic-service call carries a key derived from the order
 *   (ADR-039 § 6), so economic-service replays its stored answer; the answer
 *   is also recorded here, so a retry that comes after economic-service has
 *   let its copy expire does not call at all; and one whose first attempt
 *   never recorded it, refused for the state that attempt produced, is
 *   answered from the order's obligation as economic-service has it;
 * - a local step whose first attempt ran on a worker older than its record is
 *   recognised by the history row it wrote.
 *
 * The step's key is Temporal's own identity for one scheduled activity —
 * workflow, run and activity id — which every retry of it shares and no other
 * call does (`docs/08` § 8.8, Idempotency). Reads (`readOrder`,
 * `findObligation`) have no effect and record nothing.
 */

export interface ActivityDependencies {
  orders: OrderService;
  economic: EconomicClient;
  /**
   * Which scheduled activity is running. Temporal's own identity unless a
   * suite that runs the activities outside a worker supplies one.
   */
  currentStep?: () => SagaStep;
}

/** The running activity's identity: the same on every retry of it, unique otherwise. */
export function temporalStep(): SagaStep {
  const { workflowExecution, activityId, scheduledTimestampMs } = Context.current().info;
  // Only a standalone activity has no workflow, and the saga schedules none.
  if (!workflowExecution) throw new Error('A saga activity ran outside a workflow');
  return {
    key: `${workflowExecution.workflowId}/${workflowExecution.runId}/${activityId}`,
    // The first attempt's scheduling, which a retry keeps.
    scheduledAt: new Date(scheduledTimestampMs),
  };
}

export interface HeldResult {
  transactionId: string;
}

/** What `readOrder` returns: the fields the saga's decisions depend on. */
export type SagaOrderView = Awaited<ReturnType<OrderService['sagaView']>>;

export interface SettledResult {
  settlementId: string;
  commissionAmountMinor: string;
  netAmountMinor: string;
}

export function createActivities(deps: ActivityDependencies) {
  const logger = new Logger('OrderSagaActivities');

  /**
   * Runs `fn` as the system, acting for the order's buying organization.
   *
   * The organization is read from the order rather than passed in, so a
   * workflow cannot name a tenant of its own choosing.
   *
   * A platform error leaves here classified (`asTemporalFailure`), whichever
   * step raised it. The workflow retries its reads and local writes until
   * they answer, so a state-machine refusal that arrived unclassified would be
   * retried forever instead of stopping the saga.
   */
  async function asSystemFor<T>(
    orderId: string,
    fn: (order: Awaited<ReturnType<OrderService['describe']>>) => Promise<T>,
  ): Promise<T> {
    try {
      // Read once without a tenant, purely to learn which tenant to adopt. The
      // describe() call is scoped by the repository's own written reason.
      const bootstrap = systemContext(undefined, ulid());
      const order = await runWithContext(bootstrap, () => deps.orders.describe(orderId));

      const context = systemContext(order.buyerOrganizationId, order.correlationId);
      return await runWithContext(context, () => fn(order));
    } catch (error) {
      throw asTemporalFailure(error);
    }
  }

  const currentStep = deps.currentStep ?? temporalStep;

  /**
   * An economic-service call, made at most once per scheduled activity
   * (D-053). A refusal or an outage records nothing, so the retry calls again.
   *
   * With `applied`, a refusal for the transaction's **state** is not taken at
   * its word. It is what a retry gets once economic-service has let the
   * command's stored answer expire (`ECONOMIC_IDEMPOTENCY_TTL_HOURS`, 24 h)
   * — or lost it after committing — and the first attempt's effect is exactly
   * the state that refuses it. So the order's own obligation is read, as its
   * payer; if it shows this command's effect, that is the answer, recorded
   * like any other. Anything else — another refusal, a transaction that is
   * not this order's, a state the command does not produce — stays the
   * refusal it was.
   */
  async function economicStep<T>(
    orderId: string,
    activity: SagaActivity,
    call: (order: Awaited<ReturnType<OrderService['describe']>>) => Promise<T>,
    applied?: {
      transactionId: string;
      /** This command's effect on the obligation, as its answer; null when not there. */
      answer: (transaction: TransactionDetailView) => { result: T } | null;
    },
  ): Promise<T> {
    const step = currentStep();
    return asSystemFor(orderId, (order) =>
      deps.orders.onceForSaga(
        { id: order.id, organizationId: order.buyerOrganizationId },
        step,
        activity,
        async () => {
          try {
            return await call(order);
          } catch (refusal) {
            if (!applied || !refusedForState(refusal)) throw refusal;
            const transaction = await deps.economic.readObligation({
              orderId: order.id,
              transactionId: applied.transactionId,
              buyerOrganizationId: order.buyerOrganizationId,
              correlationId: order.correlationId,
            });
            const answer = transaction ? applied.answer(transaction) : null;
            if (!answer) throw refusal;
            logger.warn(
              `Saga step ${activity} of order ${order.id} was refused for the transaction's state, ` +
                `which already shows its effect (${transaction?.status}); answering from economic-service's record`,
            );
            return answer.result;
          }
        },
      ),
    );
  }

  return {
    /** Creates the obligation and holds the funds, in one call (ADR-040). */
    async createObligation(orderId: string): Promise<HeldResult> {
      return economicStep(orderId, 'createObligation', async (order) => {
        if (order.economicTransactionId) {
          // A retry after the call succeeded but the recording did not. The
          // obligation exists; do not create a second one.
          return { transactionId: order.economicTransactionId };
        }

        const transaction = await deps.economic.createObligation({
          orderId: order.id,
          buyerOrganizationId: order.buyerOrganizationId,
          supplierOrganizationId: order.supplierOrganizationId,
          totalAmountMinor: BigInt(order.totalAmountMinor),
          currency: order.currency,
          correlationId: order.correlationId,
        });
        return { transactionId: transaction.id };
      });
    },

    /**
     * Whether economic-service holds an obligation for this order.
     *
     * Asked whenever `createObligation` ends without a definite answer,
     * because only a refusal proves nothing moved (see
     * `EconomicClient.findObligation`).
     */
    async findObligation(orderId: string): Promise<HeldResult | null> {
      return asSystemFor(orderId, async (order) => {
        try {
          const found = await deps.economic.findObligation({
            orderId: order.id,
            buyerOrganizationId: order.buyerOrganizationId,
            correlationId: order.correlationId,
          });
          return found ? { transactionId: found.id } : null;
        } catch (error) {
          throw asTemporalFailure(error);
        }
      });
    },

    /** The order as the database has it now. What the saga decides on (ADR-039). */
    async readOrder(orderId: string): Promise<SagaOrderView> {
      return asSystemFor(orderId, () => deps.orders.sagaView(orderId));
    },

    async markFundsHeld(orderId: string, transactionId: string): Promise<OrderStatus> {
      const step = currentStep();
      return asSystemFor(orderId, () => deps.orders.markFundsHeld(orderId, transactionId, step));
    },

    async markFailed(orderId: string, reason: string): Promise<OrderStatus> {
      const step = currentStep();
      return asSystemFor(orderId, () => deps.orders.markFailed(orderId, reason, step));
    },

    async authoriseSettlement(orderId: string, transactionId: string): Promise<void> {
      await economicStep(
        orderId,
        'authoriseSettlement',
        async (order) => {
          await deps.economic.authoriseSettlement({
            orderId: order.id,
            transactionId,
            buyerOrganizationId: order.buyerOrganizationId,
            correlationId: order.correlationId,
          });
        },
        {
          transactionId,
          // Authorised, or authorised and since settled. Not DISPUTED or
          // REFUNDED: both are reachable from HELD without an authorisation.
          answer: (transaction) =>
            transaction.status === 'PENDING_SETTLEMENT' || transaction.status === 'SETTLED'
              ? { result: undefined }
              : null,
        },
      );
    },

    async markSettling(orderId: string): Promise<OrderStatus> {
      const step = currentStep();
      return asSystemFor(orderId, () => deps.orders.markSettling(orderId, step));
    },

    async settle(orderId: string, transactionId: string): Promise<SettledResult> {
      return economicStep(
        orderId,
        'settle',
        async (order) => {
          const settlement = await deps.economic.settle({
            orderId: order.id,
            transactionId,
            buyerOrganizationId: order.buyerOrganizationId,
            correlationId: order.correlationId,
          });
          return {
            settlementId: settlement.settlementId,
            commissionAmountMinor: settlement.commissionAmountMinor,
            netAmountMinor: settlement.netAmountMinor,
          };
        },
        {
          transactionId,
          // A transaction settles once (`settlement.transaction_id` is unique),
          // and the settlement writes its commission and net onto it: the same
          // three values its answer carried.
          answer: (transaction) =>
            transaction.status === 'SETTLED' && transaction.settlement
              ? {
                  result: {
                    settlementId: transaction.settlement.id,
                    commissionAmountMinor: transaction.commissionAmountMinor,
                    netAmountMinor: transaction.netAmountMinor,
                  },
                }
              : null,
        },
      );
    },

    async markSettlementFailed(orderId: string): Promise<OrderStatus> {
      settlementsExhaustedTotal.inc({ service: SERVICE_NAME }, 0);
      const step = currentStep();
      return asSystemFor(orderId, () => deps.orders.markSettlementFailed(orderId, step));
    },

    async markCompleted(orderId: string, settlement: SettledResult): Promise<OrderStatus> {
      const step = currentStep();
      return asSystemFor(orderId, () => deps.orders.markCompleted(orderId, settlement, step));
    },

    /**
     * Returns the held funds.
     *
     * The only compensation this saga performs, and only before settlement.
     * After receipt confirmation `docs/08` § 8.4 forbids automatic financial
     * compensation entirely.
     */
    async compensate(orderId: string, transactionId: string, reason: string): Promise<void> {
      await economicStep(
        orderId,
        'compensate',
        async (order) => {
          await deps.economic.refund({
            orderId: order.id,
            transactionId,
            buyerOrganizationId: order.buyerOrganizationId,
            reason,
            correlationId: order.correlationId,
          });
        },
        {
          transactionId,
          // Terminal, and only a refund reaches it: the held money is back
          // with the buyer, which is all compensation is for.
          answer: (transaction) =>
            transaction.status === 'REFUNDED' ? { result: undefined } : null,
        },
      );
    },

    /**
     * Tells economic-service the order is disputed (ADR-040 § 5).
     *
     * Both sides have to know. If only marketplace did, a direct settlement
     * command to economic-service would still succeed; if only economic did,
     * the order could not say why it was stuck. The transaction moves to
     * DISPUTED there, and economic-service refuses to settle it independently
     * of anything this service does.
     */
    async disputeObligation(
      orderId: string,
      transactionId: string,
      disputeId: string,
      reason: string,
    ): Promise<void> {
      await economicStep(
        orderId,
        'disputeObligation',
        async (order) => {
          await deps.economic.dispute({
            orderId: order.id,
            disputeId,
            transactionId,
            buyerOrganizationId: order.buyerOrganizationId,
            reason,
            correlationId: order.correlationId,
          });
        },
        {
          transactionId,
          // Disputed with this dispute's own words. Nothing but the next
          // resolution — which the saga sends only after this step — changes
          // them.
          answer: (transaction) =>
            transaction.status === 'DISPUTED' && transaction.disputeReason === reason
              ? { result: undefined }
              : null,
        },
      );
    },

    /** Reopens the transaction so a dispute decided for the supplier can settle. */
    async resolveObligationDispute(
      orderId: string,
      transactionId: string,
      disputeId: string,
      resolution: string,
    ): Promise<void> {
      await economicStep(
        orderId,
        'resolveObligationDispute',
        async (order) => {
          await deps.economic.resolveDispute({
            orderId: order.id,
            disputeId,
            transactionId,
            buyerOrganizationId: order.buyerOrganizationId,
            resolution,
            correlationId: order.correlationId,
          });
        },
        {
          transactionId,
          // Out of the dispute and back in the settlement queue (or since
          // settled), carrying this resolution's words.
          answer: (transaction) =>
            (transaction.status === 'PENDING_SETTLEMENT' || transaction.status === 'SETTLED') &&
            transaction.disputedAt !== null &&
            resolutionOf(transaction) === resolution
              ? { result: undefined }
              : null,
        },
      );
    },

    async markCancelled(orderId: string, reason: string): Promise<OrderStatus> {
      const step = currentStep();
      return asSystemFor(orderId, () => deps.orders.markCancelled(orderId, reason, step));
    },

    /**
     * Records that a window elapsed (ADR-043).
     *
     * Moves no money, changes no state, and notifies nobody —
     * notification-service does not exist (ADR-041 § 3). It writes a history
     * row and increments a counter, which is what makes an overdue order
     * visible to an operator. Once per reminder, however many attempts it took.
     */
    async recordReminder(orderId: string): Promise<void> {
      const step = currentStep();
      await asSystemFor(orderId, () => deps.orders.recordReminder(orderId, step));
    },
  };
}

/**
 * A `RequestContext` for work with no request behind it.
 *
 * The correlation id is the **order's own**, not a fresh one: a saga step and
 * the HTTP call that placed the order then share one identifier through the
 * logs, the outbox and Kafka.
 */
function systemContext(organizationId: string | undefined, correlationId: string): RequestContext {
  return createSystemContext({
    correlationId,
    callerService: SERVICE_NAME,
    roles: ['SERVICE'],
    path: 'temporal://order-saga',
    method: 'ACTIVITY',
    ...(organizationId ? { organizationId } : {}),
  });
}

/**
 * Converts a platform error into one Temporal can classify.
 *
 * The `type` is the platform error code, which is what the workflow's
 * `nonRetryableErrorTypes` matches on: a business-rule refusal must not be
 * retried, because the second attempt gets the same answer and only reports
 * the failure later.
 */
/**
 * economic-service refused the command for the transaction's current state —
 * the refusal its state machine gives (`nextStatus`), and the only one a
 * command's own earlier effect can cause. Every other refusal is about the
 * request or the money, and is never read as "already done".
 */
function refusedForState(error: unknown): boolean {
  return isRastaError(error) && error.code === 'INVALID_STATE_TRANSITION';
}

/**
 * The words the last resolution left on the transaction.
 *
 * economic-service keeps them in `disputeResolution`, beside the objection
 * (docs/23 D-060). Before it did, the resolution was written over the
 * objection, in `disputeReason`, and that is all a transaction resolved then
 * still has: `disputeResolution` is null there, and absent altogether from an
 * economic-service older than the field. Only then is `disputeReason` read —
 * on a transaction resolved since, it is the objection, and a resolution
 * worded like it proves nothing (Codex on #322).
 */
function resolutionOf(transaction: TransactionDetailView): string | null {
  const keptApart = transaction.disputeResolution;
  if (keptApart !== null && keptApart !== undefined) return keptApart;
  // Resolved before the field: the resolution is where it was written.
  return transaction.disputeReason;
}

function asTemporalFailure(error: unknown): Error {
  if (!isRastaError(error)) {
    return error instanceof Error ? error : new Error('The financial service call failed');
  }

  const retryable = !NON_RETRYABLE.has(error.code);
  return retryable
    ? ApplicationFailure.retryable(error.message, error.code)
    : ApplicationFailure.nonRetryable(error.message, error.code);
}

const NON_RETRYABLE = new Set([
  'BUSINESS_RULE_VIOLATION',
  'VALIDATION_FAILED',
  'TENANT_MISMATCH',
  'FORBIDDEN',
  'NOT_FOUND',
  'INSUFFICIENT_BALANCE',
  'IDEMPOTENCY_KEY_REUSED',
  'SERVICE_TENANT_CONTEXT_INVALID',
]);

/** The shape the workflow proxies. Derived, so it cannot drift. */
export type OrderActivities = ReturnType<typeof createActivities>;
