/**
 * maintenance-service's operation budgets (#268 r4): how long each operation
 * it runs on its database may take. A configured `DATABASE_STATEMENT_TIMEOUT_MS`
 * must be above every one of them, or `loadMaintenanceEnv` refuses it — a
 * statement timeout never cancels an operation the service supports.
 *
 * The fixed budgets are declared here and imported by the code they bound, so
 * the list cannot fall behind it. A leaf module: nothing here imports the code
 * that uses it.
 */
import {
  PRISMA_DEFAULT_TRANSACTION_BUDGET,
  STATEMENT_WAIT_MARGIN_MS,
  idempotencyClaimOperationBudget,
  outboxPurgeOperationBudget,
  type OperationBudget,
} from '@rasta/config';
import { outboxRenewalOperationBudget } from '@rasta/nest-common';
import type { MaintenanceEnv } from './env';

/**
 * How long a request waits on a key another request is still working on,
 * before it answers `409 CONFLICT` with `Retry-After`. A create takes a
 * fraction of a second, so a double submit — the portal's button pressed
 * twice, a proxy retrying — is normally answered with the first request's own
 * 201 (#157). A create slower than this leaves its duplicate the 409, which
 * the portal shows as in progress and offers again after the wait (round 1 on
 * #171), never as an invalid form.
 */
export const IN_FLIGHT_WAIT_MS = 5_000;

/** Slack for a claim-side transaction beyond its lock wait, so the wait ends first. */
export const WAIT_TRANSACTION_SLACK_MS = 2_000;

/**
 * A refresh holds the asset's locks across up to two short exchanges with
 * asset-service ({@link REFRESH_UPSTREAM_CALLS_UNDER_LOCK}, each bounded by its
 * own deadline), so its transaction is given room. Replays are rare operator
 * actions; other deliveries for that asset wait.
 */
export const REFRESH_TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * The upstream calls a replayed asset event's refresh makes, one after
 * another, while it holds the asset's locks: the snapshot, and whether a stale
 * fence's transfer was recorded. Each is bounded by
 * `ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS`.
 */
export const REFRESH_UPSTREAM_CALLS_UNDER_LOCK = 2;

export function maintenanceOperationBudgets(env: MaintenanceEnv): readonly OperationBudget[] {
  return [
    // HTTP writes, the due scanner, usage and non-replayed asset deliveries.
    PRISMA_DEFAULT_TRANSACTION_BUDGET,
    idempotencyClaimOperationBudget(
      'IN_FLIGHT_WAIT_MS',
      IN_FLIGHT_WAIT_MS,
      WAIT_TRANSACTION_SLACK_MS,
    ),
    {
      name: 'REFRESH_TRANSACTION_TIMEOUT_MS',
      budgetMs: REFRESH_TRANSACTION_TIMEOUT_MS,
      derivation:
        "a replayed asset event's refresh, holding the asset's locks across its upstream " +
        'calls: its transaction timeout',
    },
    {
      name: 'ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS',
      budgetMs:
        REFRESH_UPSTREAM_CALLS_UNDER_LOCK * env.ASSET_TRANSFER_RESOLUTION_TIMEOUT_MS +
        STATEMENT_WAIT_MARGIN_MS,
      derivation:
        "a new request, repair order or delivery waits on the asset's locks a replay's refresh " +
        `holds across ${REFRESH_UPSTREAM_CALLS_UNDER_LOCK} calls of this setting each, ` +
        `+ ${STATEMENT_WAIT_MARGIN_MS} ms for its own statements`,
    },
    outboxRenewalOperationBudget(env),
    outboxPurgeOperationBudget(env),
  ];
}
