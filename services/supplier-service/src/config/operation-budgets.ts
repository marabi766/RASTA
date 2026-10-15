/**
 * supplier-service's operation budgets (#268 r4): how long each operation it
 * runs on its database may take. A configured `DATABASE_STATEMENT_TIMEOUT_MS`
 * must be above every one of them, or `loadSupplierEnv` refuses it — a
 * statement timeout never cancels an operation the service supports.
 */
import { PRISMA_DEFAULT_TRANSACTION_BUDGET, type OperationBudget } from '@rasta/config';
import { outboxRenewalOperationBudget } from '@rasta/nest-common';
import type { SupplierEnv } from './env';

export function supplierOperationBudgets(env: SupplierEnv): readonly OperationBudget[] {
  return [
    // Every write, the performance consumer, and the standing snapshot read.
    PRISMA_DEFAULT_TRANSACTION_BUDGET,
    outboxRenewalOperationBudget(env),
  ];
}
