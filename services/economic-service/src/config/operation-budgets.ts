/**
 * economic-service's operation budgets (#268 r4): how long each operation it
 * runs on its database may take. A configured `DATABASE_STATEMENT_TIMEOUT_MS`
 * must be above every one of them, or `loadEconomicEnv` refuses it — a
 * statement timeout never cancels an operation the service supports.
 *
 * The fixed budgets are declared here and imported by the code they bound, so
 * the list cannot fall behind it. A leaf module: nothing here imports the code
 * that uses it. Every economic transaction sets its own timeout, so Prisma's
 * default is not among them.
 */
import { idempotencyClaimOperationBudget, type OperationBudget } from '@rasta/config';
import { outboxRenewalOperationBudget } from '@rasta/nest-common';
import type { EconomicEnv } from './env';

/**
 * The most one claim waits on another transaction's lock on its key, over all
 * its attempts — the same bound the other services' stores keep. A cleanup or
 * a racing request holding the key past it gets the in-flight 409 with
 * `Retry-After`, never an unbounded wait.
 */
export const CLAIM_WAIT_MS = 5_000;

/** Slack for a claim-side transaction beyond its lock wait, so the wait ends first. */
export const WAIT_TRANSACTION_SLACK_MS = 2_000;

/**
 * Every money-moving transaction (`PrismaService.transaction`): how long it
 * may wait for a connection, and how long it may run. The settlement path
 * holds row locks on two wallets while it posts a journal, and under the
 * mandated 100-way concurrency test the last writer in the queue waits for the
 * 99 before it — in one `FOR UPDATE`. That wait is the contention budget.
 */
export const CONTENTION_TRANSACTION_MAX_WAIT_MS = 30_000;
export const CONTENTION_TRANSACTION_TIMEOUT_MS = 60_000;

/** One balance-audit page's snapshot waits this long for a connection, and lives this long. */
export const AUDIT_TX_MAX_WAIT_MS = 30_000;
export const AUDIT_TX_TIMEOUT_MS = 120_000;

export function economicOperationBudgets(env: EconomicEnv): readonly OperationBudget[] {
  return [
    idempotencyClaimOperationBudget('CLAIM_WAIT_MS', CLAIM_WAIT_MS, WAIT_TRANSACTION_SLACK_MS),
    {
      name: 'CONTENTION_TRANSACTION_TIMEOUT_MS',
      budgetMs: CONTENTION_TRANSACTION_TIMEOUT_MS,
      derivation:
        'every money-moving transaction; under contention its first FOR UPDATE queues behind ' +
        'every writer before it: its transaction timeout',
    },
    {
      name: 'AUDIT_TX_TIMEOUT_MS',
      budgetMs: AUDIT_TX_TIMEOUT_MS,
      derivation: "one page of the wallet/ledger balance audit's read-only snapshot",
    },
    outboxRenewalOperationBudget(env),
  ];
}
