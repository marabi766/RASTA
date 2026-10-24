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
import { idempotencyClaimOperationBudget, type OperationBudget } from '@rasta/config';
import { outboxRenewalOperationBudget } from '@rasta/nest-common';
import type { ConstructionEnv } from './env';

/**
 * The most one claim waits on another transaction's lock on its key, over all
 * its attempts — the same bound the other services' stores keep.
 */
export const CLAIM_WAIT_MS = 5_000;

/** Slack for a claim-side transaction beyond its lock wait, so the wait ends first. */
export const WAIT_TRANSACTION_SLACK_MS = 2_000;

/**
 * The replay fence's slack (PM decision D-065): a claim reads its clock once, and the insert it
 * decides can run up to a claim's whole wait (`CLAIM_WAIT_MS` plus its transaction slack) later.
 */
export const REPLAY_FENCE_MARGIN_MS = CLAIM_WAIT_MS + WAIT_TRANSACTION_SLACK_MS;

/**
 * B, the fence budget in ms: how much earlier than the record's own expiry a replay deadline ends,
 * and how much later than that expiry the purge may delete. `B = 2·skew + margin` — two replicas'
 * clocks may each be off by `skew` in opposite directions (the one that claimed, the one that asks).
 */
export function replayFenceBudgetMs(clockSkewSeconds: number): number {
  return 2 * clockSkewSeconds * 1000 + REPLAY_FENCE_MARGIN_MS;
}

export function constructionOperationBudgets(env: ConstructionEnv): readonly OperationBudget[] {
  return [
    // Every other domain transaction and the three sweepers' per-item work: the
    // client's own timeout (#271), not Prisma's 5 000 ms.
    {
      name: 'CONSTRUCTION_TRANSACTION_TIMEOUT_MS',
      budgetMs: env.CONSTRUCTION_TRANSACTION_TIMEOUT_MS,
      derivation:
        'every interactive transaction that names no bound of its own runs on the client ' +
        'timeout, and a statement in one, an award queued on the tender lock, may wait that long',
    },
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
