/**
 * marketplace-service's operation budgets (#268 r4): how long each operation it
 * runs on its database may take. A configured `DATABASE_STATEMENT_TIMEOUT_MS`
 * must be above every one of them, or `loadMarketplaceEnv` refuses it — a
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
import type { MarketplaceEnv } from './env';

/**
 * The most one claim waits on another transaction's lock on its key, over all
 * its attempts — the same bound the other services' stores keep. A cleanup or
 * a racing request holding the key past it gets the in-flight 409 with
 * `Retry-After`, never an unbounded wait.
 */
export const CLAIM_WAIT_MS = 5_000;

/** Slack for a claim-side transaction beyond its lock wait, so the wait ends first. */
export const WAIT_TRANSACTION_SLACK_MS = 2_000;

export function marketplaceOperationBudgets(env: MarketplaceEnv): readonly OperationBudget[] {
  return [
    // Every order and catalogue write, and the saga's transitions.
    PRISMA_DEFAULT_TRANSACTION_BUDGET,
    idempotencyClaimOperationBudget('CLAIM_WAIT_MS', CLAIM_WAIT_MS, WAIT_TRANSACTION_SLACK_MS),
    outboxRenewalOperationBudget(env),
  ];
}
