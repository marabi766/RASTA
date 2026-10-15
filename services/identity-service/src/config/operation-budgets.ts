/**
 * identity-service's operation budgets (#268 r4): how long each operation it
 * runs on its database may take. A configured `DATABASE_STATEMENT_TIMEOUT_MS`
 * must be above every one of them, or `loadIdentityEnv` refuses it — a
 * statement timeout never cancels an operation the service supports.
 *
 * The Keycloak transactions also set their own `statement_timeout` with
 * `SET LOCAL` (`PrismaService.transaction`): behind PgBouncer the timeout is
 * the runtime role's own default, set on the database side (docs/11 § 11.2),
 * and nothing here can check that one.
 *
 * The fixed budgets are declared here and imported by the code they bound, so
 * the list cannot fall behind it. A leaf module: nothing here imports the code
 * that uses it.
 */
import { PRISMA_DEFAULT_TRANSACTION_BUDGET, type OperationBudget } from '@rasta/config';
import { outboxRenewalOperationBudget } from '@rasta/nest-common';
import type { IdentityEnv } from './env';

/**
 * The Keycloak projection and the orphan repair: above the Keycloak client's
 * worst case — six calls (token, the attribute GET and PUT, and on a first
 * activation the account read and the activation GET and PUT), each bounded
 * at 10 s.
 */
export const PROJECTION_TRANSACTION_TIMEOUT_MS = 65_000;

/** A registration approval, which may wait on Keycloak under the request lock. */
export const APPROVAL_TRANSACTION_TIMEOUT_MS = 65_000;

export function identityOperationBudgets(env: IdentityEnv): readonly OperationBudget[] {
  return [
    // Membership, user and audit-correction writes, and the expiry scanner.
    PRISMA_DEFAULT_TRANSACTION_BUDGET,
    {
      name: 'PROJECTION_TRANSACTION_TIMEOUT_MS',
      budgetMs: PROJECTION_TRANSACTION_TIMEOUT_MS,
      derivation:
        'a Keycloak projection or orphan repair holds the user lock across Keycloak calls, and ' +
        'membership changes wait on it: its transaction timeout',
    },
    {
      name: 'APPROVAL_TRANSACTION_TIMEOUT_MS',
      budgetMs: APPROVAL_TRANSACTION_TIMEOUT_MS,
      derivation:
        'a registration approval holds the request lock across Keycloak calls, and a rejection ' +
        'waits on it: its transaction timeout',
    },
    {
      name: 'SECURITY_EVENT_CAPTURE_TIMEOUT_MS',
      budgetMs: env.SECURITY_EVENT_CAPTURE_TIMEOUT_MS,
      derivation: "a refusal's security-event capture: its own statement timeout",
    },
    // The security-event relay's renewal has the same deadline and a shorter
    // margin, so this one bounds it too.
    outboxRenewalOperationBudget(env),
  ];
}
