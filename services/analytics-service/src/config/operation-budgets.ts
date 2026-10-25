/**
 * analytics-service's operation budgets (#268 r4): how long each operation it runs on its
 * database may take. A configured `DATABASE_STATEMENT_TIMEOUT_MS` must be above every one of
 * them, or `loadAnalyticsEnv` refuses it — a statement timeout never cancels an operation the
 * service supports.
 */
import { PRISMA_DEFAULT_TRANSACTION_BUDGET, type OperationBudget } from '@rasta/config';

export function analyticsOperationBudgets(): readonly OperationBudget[] {
  // The projection's one transaction (marker + fact) and the dashboard's one read. No outbox,
  // so no renewal budget.
  return [PRISMA_DEFAULT_TRANSACTION_BUDGET];
}
