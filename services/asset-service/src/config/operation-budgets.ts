/**
 * asset-service's operation budgets (#268 r4): how long each operation it runs
 * on its database may take. A configured `DATABASE_STATEMENT_TIMEOUT_MS` must
 * be above every one of them, or `loadAssetEnv` refuses it — a statement
 * timeout never cancels an operation the service supports.
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
import type { AssetEnv } from './env';

/**
 * How long a request waits on a key another request is still working on,
 * before it answers `409 CONFLICT` with `Retry-After`. A registration takes a
 * fraction of a second, so a double submit is normally answered with the first
 * request's own 201.
 */
export const IN_FLIGHT_WAIT_MS = 5_000;

/** Slack for the waiting transaction beyond its lock wait, so the wait ends first. */
export const WAIT_TRANSACTION_SLACK_MS = 2_000;

/**
 * A refresh holds the asset's lock across two short exchanges with the owners
 * of its work (each bounded by its own deadline), so its transaction is given
 * room. Replays are rare operator actions; other deliveries for that asset wait.
 */
export const REFRESH_TRANSACTION_TIMEOUT_MS = 30_000;

export function assetOperationBudgets(env: AssetEnv): readonly OperationBudget[] {
  return [
    // Every HTTP write, the insurance sweep, a non-replayed delivery, and the
    // transfer-landed question (its 3 s lock_timeout inside one of these).
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
        "a replayed timeline event's refresh, holding the asset row across one work-state " +
        'exchange: its transaction timeout',
    },
    {
      name: 'ASSET_TRANSFER_CLEARANCE_TIMEOUT_MS',
      budgetMs: env.ASSET_TRANSFER_CLEARANCE_TIMEOUT_MS + STATEMENT_WAIT_MARGIN_MS,
      derivation:
        "a delivery or write for the asset waits on the asset row a replay's refresh holds " +
        `across one work-state exchange of this setting, + ${STATEMENT_WAIT_MARGIN_MS} ms for ` +
        'its own statements',
    },
    outboxRenewalOperationBudget(env),
    outboxPurgeOperationBudget(env),
  ];
}
