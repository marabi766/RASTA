/**
 * organization-service's operation budgets (#268 r4): how long each operation
 * it runs on its database may take. A configured `DATABASE_STATEMENT_TIMEOUT_MS`
 * must be above every one of them, or `loadOrganizationEnv` refuses it — a
 * statement timeout never cancels an operation the service supports.
 */
import {
  PRISMA_DEFAULT_TRANSACTION_BUDGET,
  outboxPurgeOperationBudget,
  type OperationBudget,
} from '@rasta/config';
import { outboxRenewalOperationBudget } from '@rasta/nest-common';
import type { OrganizationEnv } from './env';

export function organizationOperationBudgets(env: OrganizationEnv): readonly OperationBudget[] {
  return [
    // Every write (each serialised on the hierarchy, policy or contact advisory
    // lock) and every snapshot read.
    PRISMA_DEFAULT_TRANSACTION_BUDGET,
    outboxRenewalOperationBudget(env),
    outboxPurgeOperationBudget(env),
  ];
}
