/**
 * inventory-service's operation budgets (#268 r4): how long each operation it
 * runs on its database may take. A configured `DATABASE_STATEMENT_TIMEOUT_MS`
 * must be above every one of them, or `loadInventoryEnv` refuses it — a
 * statement timeout never cancels an operation the service supports.
 *
 * The fixed budgets are declared here and imported by the code they bound, so
 * the list cannot fall behind it. A leaf module: nothing here imports the code
 * that uses it. Every inventory transaction sets its own timeout, so Prisma's
 * default is not among them.
 */
import { idempotencyClaimOperationBudget, type OperationBudget } from '@rasta/config';
import { outboxRenewalOperationBudget } from '@rasta/nest-common';
import type { InventoryEnv } from './env';

/**
 * How long a request waits on a key another request is still working on, before it
 * answers `409 CONFLICT` with `Retry-After`. A command takes a fraction of a second, so a
 * double submit is normally answered with the first request's own response.
 */
export const IN_FLIGHT_WAIT_MS = 5_000;

/** Slack for the waiting transaction beyond its lock wait, so the wait ends first. */
export const WAIT_TRANSACTION_SLACK_MS = 2_000;

/** Room a stock transaction has besides its lock waits. */
export const STOCK_TRANSACTION_MARGIN_MS = 10_000;

/**
 * A command's transaction: it may wait on several items in turn, each bounded
 * by `lock_timeout`, so the whole transaction is bounded too.
 */
export function commandTransactionTimeoutMs(lockTimeoutMs: number): number {
  return lockTimeoutMs * 4 + STOCK_TRANSACTION_MARGIN_MS;
}

/** One reservation-expiry batch's transaction: the reservation and the item. */
export function expiryTransactionTimeoutMs(lockTimeoutMs: number): number {
  return lockTimeoutMs * 2 + STOCK_TRANSACTION_MARGIN_MS;
}

export function inventoryOperationBudgets(env: InventoryEnv): readonly OperationBudget[] {
  const lockTimeoutMs = env.INVENTORY_LOCK_TIMEOUT_MS;
  return [
    idempotencyClaimOperationBudget(
      'IN_FLIGHT_WAIT_MS',
      IN_FLIGHT_WAIT_MS,
      WAIT_TRANSACTION_SLACK_MS,
    ),
    {
      name: 'INVENTORY_LOCK_TIMEOUT_MS',
      budgetMs: commandTransactionTimeoutMs(lockTimeoutMs),
      derivation:
        "a stock command's transaction, each of its row waits bounded by this lock_timeout: " +
        `4 × this setting + ${STOCK_TRANSACTION_MARGIN_MS} ms`,
    },
    {
      name: 'INVENTORY_LOCK_TIMEOUT_MS (expiry)',
      budgetMs: expiryTransactionTimeoutMs(lockTimeoutMs),
      derivation:
        'one reservation-expiry batch, from the sweeper or a command: ' +
        `2 × this setting + ${STOCK_TRANSACTION_MARGIN_MS} ms`,
    },
    outboxRenewalOperationBudget(env),
  ];
}
