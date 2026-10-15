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
import type { EconomicClient } from '../economic/economic.client';
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
 *   let its copy expire does not call at all.
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
  const { workflowExecution, activityId } = Context.current().info;
  // Only a standalone activity has no workflow, and the saga schedules none.
  if (!workflowExecution) throw new Error('A saga activity ran outside a workflow');
  return { key: `${workflowExecution.workflowId}/${workflowExecution.runId}/${activityId}` };
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
   */
  async function economicStep<T>(
    orderId: string,
    activity: SagaActivity,
    call: (order: Awaited<ReturnType<OrderService['describe']>>) => Promise<T>,
  ): Promise<T> {
    const step = currentStep();
    return asSystemFor(orderId, (order) =>
      deps.orders.onceForSaga(
        { id: order.id, organizationId: order.buyerOrganizationId },
        step,
        activity,
        () => call(order),
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
      await economicStep(orderId, 'authoriseSettlement', async (order) => {
        await deps.economic.authoriseSettlement({
          orderId: order.id,
          transactionId,
          buyerOrganizationId: order.buyerOrganizationId,
          correlationId: order.correlationId,
        });
      });
    },

    async markSettling(orderId: string): Promise<OrderStatus> {
      const step = currentStep();
      return asSystemFor(orderId, () => deps.orders.markSettling(orderId, step));
    },

    async settle(orderId: string, transactionId: string): Promise<SettledResult> {
      return economicStep(orderId, 'settle', async (order) => {
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
      });
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
      await economicStep(orderId, 'compensate', async (order) => {
        await deps.economic.refund({
          orderId: order.id,
          transactionId,
          buyerOrganizationId: order.buyerOrganizationId,
          reason,
          correlationId: order.correlationId,
        });
      });
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
      await economicStep(orderId, 'disputeObligation', async (order) => {
        await deps.economic.dispute({
          orderId: order.id,
          disputeId,
          transactionId,
          buyerOrganizationId: order.buyerOrganizationId,
          reason,
          correlationId: order.correlationId,
        });
      });
    },

    /** Reopens the transaction so a dispute decided for the supplier can settle. */
    async resolveObligationDispute(
      orderId: string,
      transactionId: string,
      disputeId: string,
      resolution: string,
    ): Promise<void> {
      await economicStep(orderId, 'resolveObligationDispute', async (order) => {
        await deps.economic.resolveDispute({
          orderId: order.id,
          disputeId,
          transactionId,
          buyerOrganizationId: order.buyerOrganizationId,
          resolution,
          correlationId: order.correlationId,
        });
      });
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
