/**
 * document-service's operation budgets (#268 r4): how long each operation it
 * runs on its database may take. A configured `DATABASE_STATEMENT_TIMEOUT_MS`
 * must be above every one of them, or `loadDocumentEnv` refuses it — a
 * statement timeout never cancels an operation the service supports.
 */
import {
  PRISMA_DEFAULT_TRANSACTION_BUDGET,
  outboxPurgeOperationBudget,
  type OperationBudget,
} from '@rasta/config';
import { outboxRenewalOperationBudget } from '@rasta/nest-common';
import type { DocumentEnv } from './env';

export function documentOperationBudgets(env: DocumentEnv): readonly OperationBudget[] {
  return [
    // Intents, registrations, tombstones, and the scan worker's reschedule and
    // completion; the scan itself runs outside any transaction.
    PRISMA_DEFAULT_TRANSACTION_BUDGET,
    outboxRenewalOperationBudget(env),
    outboxPurgeOperationBudget(env),
  ];
}
