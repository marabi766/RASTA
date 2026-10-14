/**
 * construction-service's operation budgets (#268 r4): how long each operation
 * it runs on its database may take. A configured `DATABASE_STATEMENT_TIMEOUT_MS`
 * must be above every one of them, or `loadConstructionEnv` refuses it — a
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
import type { ConstructionEnv } from './env';

/**
 * The most one claim waits on another transaction's lock on its key, over all
 * its attempts — the same bound the other services' stores keep.
 */
export const CLAIM_WAIT_MS = 5_000;

/** Slack for a claim-side transaction beyond its lock wait, so the wait ends first. */
export const WAIT_TRANSACTION_SLACK_MS = 2_000;

export function constructionOperationBudgets(env: ConstructionEnv): readonly OperationBudget[] {
  return [
    // Every other domain transaction and the three sweepers' per-item work.
    PRISMA_DEFAULT_TRANSACTION_BUDGET,
    idempotencyClaimOperationBudget('CLAIM_WAIT_MS', CLAIM_WAIT_MS, WAIT_TRANSACTION_SLACK_MS),
    {
      name: 'CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS',
      budgetMs: env.CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS,
      derivation:
        'a tender opening, or an owner reading its bids, holds the tender row while it decrypts ' +
        'and audits every bid, and a second one queues behind it: that transaction timeout',
    },
    outboxRenewalOperationBudget(env),
  ];
}
