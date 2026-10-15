/**
 * notification-service's operation budgets (#268 r4): how long each operation
 * it runs on its database may take. A configured `DATABASE_STATEMENT_TIMEOUT_MS`
 * must be above every one of them, or `loadNotificationEnv` refuses it — a
 * statement timeout never cancels an operation the service supports.
 *
 * The fixed budgets are declared here and imported by the code they bound, so
 * the list cannot fall behind it. A leaf module: nothing here imports the code
 * that uses it.
 */
import { PRISMA_DEFAULT_TRANSACTION_BUDGET, type OperationBudget } from '@rasta/config';
import { outboxRenewalOperationBudget } from '@rasta/nest-common';
import type { NotificationEnv } from './env';

/**
 * One consumer ingest, and one dispatch or attempt settlement
 * (`notification.repository.ts`): each serialises on its dedupe key or its
 * intent, and enqueues events.
 */
export const INGEST_TRANSACTION_TIMEOUT_MS = 30_000;
export const DISPATCH_TRANSACTION_TIMEOUT_MS = 30_000;

export function notificationOperationBudgets(env: NotificationEnv): readonly OperationBudget[] {
  return [
    // In-app reads and dismissals, and the preference writes.
    PRISMA_DEFAULT_TRANSACTION_BUDGET,
    {
      name: 'INGEST_TRANSACTION_TIMEOUT_MS',
      budgetMs: INGEST_TRANSACTION_TIMEOUT_MS,
      derivation: 'one consumer ingest, serialised on its dedupe key: its transaction timeout',
    },
    {
      name: 'DISPATCH_TRANSACTION_TIMEOUT_MS',
      budgetMs: DISPATCH_TRANSACTION_TIMEOUT_MS,
      derivation:
        'one dispatch or attempt settlement, fenced on its intent: its transaction timeout',
    },
    outboxRenewalOperationBudget(env),
  ];
}
