import { ApplicationFailure } from '@temporalio/activity';
import {
  createSystemContext,
  isRastaError,
  runWithContext,
  type RequestContext,
} from '@rasta/nest-common';
import { ulid } from 'ulid';
import type { OrderService } from '../order/order.service';
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
 * ## Idempotency
 *
 * Every financial call carries a key derived from the order id, so a Temporal
 * retry is a replay rather than a second act (ADR-039 § 6). The state
 * transitions are idempotent in a different way: `systemTransition` returns
 * quietly when the order is already in the target state, which is exactly what
 * a re-run of a completed activity should do.
 */

export interface ActivityDependencies {
  orders: OrderService;
  economic: EconomicClient;
}

export interface HeldResult {
  transactionId: string;
}

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
   */
  async function asSystemFor<T>(
    orderId: string,
    fn: (order: Awaited<ReturnType<OrderService['describe']>>) => Promise<T>,
  ): Promise<T> {
    // Read once without a tenant, purely to learn which tenant to adopt. The
    // describe() call is scoped by the repository's own written reason.
    const bootstrap = systemContext(undefined, ulid());
    const order = await runWithContext(bootstrap, () => deps.orders.describe(orderId));

    const context = systemContext(order.buyerOrganizationId, order.correlationId);
    return runWithContext(context, () => fn(order));
  }

  return {
    /** Creates the obligation and holds the funds, in one call (ADR-040). */
    async createObligation(orderId: string): Promise<HeldResult> {
      return asSystemFor(orderId, async (order) => {
        if (order.economicTransactionId) {
          // A retry after the call succeeded but the recording did not. The
          // obligation exists; do not create a second one.
          return { transactionId: order.economicTransactionId };
        }

        try {
          const transaction = await deps.economic.createObligation({
            orderId: order.id,
            buyerOrganizationId: order.buyerOrganizationId,
            supplierOrganizationId: order.supplierOrganizationId,
            totalAmountMinor: BigInt(order.totalAmountMinor),
            currency: order.currency,
            correlationId: order.correlationId,
          });
          return { transactionId: transaction.id };
        } catch (error) {
          throw asTemporalFailure(error);
        }
      });
    },

    async markFundsHeld(orderId: string, transactionId: string): Promise<void> {
      await asSystemFor(orderId, () => deps.orders.markFundsHeld(orderId, transactionId));
    },

    async markFailed(orderId: string, reason: string): Promise<void> {
      await asSystemFor(orderId, () => deps.orders.markFailed(orderId, reason));
    },

    async authoriseSettlement(orderId: string, transactionId: string): Promise<void> {
      await asSystemFor(orderId, async (order) => {
        try {
          await deps.economic.authoriseSettlement({
            orderId: order.id,
            transactionId,
            buyerOrganizationId: order.buyerOrganizationId,
            correlationId: order.correlationId,
          });
        } catch (error) {
          throw asTemporalFailure(error);
        }
      });
    },

    async markSettling(orderId: string): Promise<void> {
      await asSystemFor(orderId, () => deps.orders.markSettling(orderId));
    },

    async settle(orderId: string, transactionId: string): Promise<SettledResult> {
      return asSystemFor(orderId, async (order) => {
        try {
          const settlement = await deps.economic.settle({
            orderId: order.id,
            transactionId,
            buyerOrganizationId: order.buyerOrganizationId,
            correlationId: order.correlationId,
          });
          return {
            settlementId: settlement.id,
            commissionAmountMinor: settlement.commissionAmountMinor,
            netAmountMinor: settlement.netAmountMinor,
          };
        } catch (error) {
          throw asTemporalFailure(error);
        }
      });
    },

    async markSettlementFailed(orderId: string): Promise<void> {
      settlementsExhaustedTotal.inc({ service: SERVICE_NAME }, 0);
      await asSystemFor(orderId, () => deps.orders.markSettlementFailed(orderId));
    },

    async markCompleted(orderId: string, settlement: SettledResult): Promise<void> {
      await asSystemFor(orderId, () => deps.orders.markCompleted(orderId, settlement));
    },

    /**
     * Returns the held funds.
     *
     * The only compensation this saga performs, and only before settlement.
     * After receipt confirmation `docs/08` § 8.4 forbids automatic financial
     * compensation entirely.
     */
    async compensate(orderId: string, transactionId: string, reason: string): Promise<void> {
      await asSystemFor(orderId, async (order) => {
        try {
          await deps.economic.refund({
            orderId: order.id,
            transactionId,
            buyerOrganizationId: order.buyerOrganizationId,
            reason,
            correlationId: order.correlationId,
          });
        } catch (error) {
          throw asTemporalFailure(error);
        }
      });
    },

    async markCancelled(orderId: string, reason: string): Promise<void> {
      await asSystemFor(orderId, () => deps.orders.markCancelled(orderId, reason));
    },

    /**
     * Records that a window elapsed (ADR-043).
     *
     * Moves no money, changes no state, and notifies nobody —
     * notification-service does not exist (ADR-041 § 3). It writes a history
     * row and increments a counter, which is what makes an overdue order
     * visible to an operator.
     */
    async recordReminder(orderId: string): Promise<void> {
      await asSystemFor(orderId, () => deps.orders.recordReminder(orderId));
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
