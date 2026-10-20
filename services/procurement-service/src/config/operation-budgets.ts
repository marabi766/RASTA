/**
 * procurement-service's operation budgets (#268 r4): how long each operation
 * it runs on its database may take. A configured `DATABASE_STATEMENT_TIMEOUT_MS`
 * must be above every one of them, or `loadProcurementEnv` refuses it — a
 * statement timeout never cancels an operation the service supports.
 *
 * The fixed budgets are declared here and imported by the code they bound, so
 * the list cannot fall behind it. A leaf module: nothing here imports the code
 * that uses it.
 */
import {
  PRISMA_DEFAULT_TRANSACTION_BUDGET,
  idempotencyClaimOperationBudget,
  type OperationBudget,
} from '@rasta/config';
import { outboxRenewalOperationBudget } from '@rasta/nest-common';
import type { ProcurementEnv } from './env';

/**
 * How long a request waits on a key another request is still working on, before it
 * answers `409 CONFLICT` with `Retry-After`. A command takes a fraction of a second, so a
 * double submit is normally answered with the first request's own response.
 */
export const IN_FLIGHT_WAIT_MS = 5_000;

/** Slack for the waiting transaction beyond its lock wait, so the wait ends first. */
export const WAIT_TRANSACTION_SLACK_MS = 2_000;

export function procurementOperationBudgets(env: ProcurementEnv): readonly OperationBudget[] {
  return [
    // Submitting and withdrawing a demand: one transaction under the aggregation's row lock.
    PRISMA_DEFAULT_TRANSACTION_BUDGET,
    idempotencyClaimOperationBudget(
      'IN_FLIGHT_WAIT_MS',
      IN_FLIGHT_WAIT_MS,
      WAIT_TRANSACTION_SLACK_MS,
    ),
    outboxRenewalOperationBudget(env),
  ];
}
