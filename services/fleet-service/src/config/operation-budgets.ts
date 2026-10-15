/**
 * fleet-service's operation budgets (#268 r4): how long each operation it runs
 * on its database may take. A configured `DATABASE_STATEMENT_TIMEOUT_MS` must
 * be above every one of them, or `loadFleetEnv` refuses it — a statement
 * timeout never cancels an operation the service supports.
 *
 * The fixed budgets are declared here and imported by the code they bound, so
 * the list cannot fall behind it. A leaf module: nothing here imports the code
 * that uses it.
 */
import {
  PRISMA_DEFAULT_TRANSACTION_BUDGET,
  idempotencyClaimOperationBudget,
  outboxPurgeOperationBudget,
  type OperationBudget,
} from '@rasta/config';
import { outboxRenewalOperationBudget } from '@rasta/nest-common';
import type { FleetEnv } from './env';

/**
 * How long a request waits on a key another request is still working on,
 * before it answers `409 CONFLICT` with `Retry-After`. A declaration takes a
 * fraction of a second, so a double submit is normally answered with the first
 * request's own 201.
 */
export const IN_FLIGHT_WAIT_MS = 5_000;

/** Slack for the waiting transaction beyond its lock wait, so the wait ends first. */
export const WAIT_TRANSACTION_SLACK_MS = 2_000;

export function fleetOperationBudgets(env: FleetEnv): readonly OperationBudget[] {
  return [
    // HTTP writes, ordinary asset-sync deliveries, the clear-transferred CLI.
    PRISMA_DEFAULT_TRANSACTION_BUDGET,
    idempotencyClaimOperationBudget(
      'IN_FLIGHT_WAIT_MS',
      IN_FLIGHT_WAIT_MS,
      WAIT_TRANSACTION_SLACK_MS,
    ),
    {
      name: 'FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS',
      budgetMs: env.FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS,
      derivation:
        "a replay's refresh, INSURANCE_RECORDED, ASSET_CREATED and the parked sweep hold the " +
        "machine's lock across their upstream calls, and deliveries, assignments and usage " +
        'writes wait on it: that transaction timeout',
    },
    outboxRenewalOperationBudget(env),
    outboxPurgeOperationBudget(env),
  ];
}
