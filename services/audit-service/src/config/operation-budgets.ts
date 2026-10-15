/**
 * audit-service's operation budgets (#268 r4): how long each operation it runs
 * on its database may take. A configured `DATABASE_STATEMENT_TIMEOUT_MS` must
 * be above every one of them, or `loadAuditEnv` refuses it — a statement
 * timeout never cancels an operation the service supports.
 *
 * The fixed budgets are declared here and imported by the code they bound, so
 * the list cannot fall behind it. A leaf module: nothing here imports the code
 * that uses it. audit-service has no outbox.
 */
import { PRISMA_DEFAULT_TRANSACTION_BUDGET, type OperationBudget } from '@rasta/config';
import type { AuditEnv } from './env';

/**
 * One chain ingest: the chain-head `FOR UPDATE` queue per (organization,
 * month), measured at over five seconds under the concurrency suite
 * (`audit.repository.ts`, `INGEST_TRANSACTION`).
 */
export const INGEST_TRANSACTION_TIMEOUT_MS = 30_000;

export function auditOperationBudgets(_env: AuditEnv): readonly OperationBudget[] {
  return [
    // The tender-evidence link and access records.
    PRISMA_DEFAULT_TRANSACTION_BUDGET,
    {
      name: 'INGEST_TRANSACTION_TIMEOUT_MS',
      budgetMs: INGEST_TRANSACTION_TIMEOUT_MS,
      derivation:
        "one chain ingest, whose first statement queues on the chain head's FOR UPDATE: its " +
        'transaction timeout',
    },
  ];
}
