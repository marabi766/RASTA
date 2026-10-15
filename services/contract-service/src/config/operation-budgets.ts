/**
 * contract-service's operation budgets (#268 r4): how long each operation it
 * runs on its database may take. A configured `DATABASE_STATEMENT_TIMEOUT_MS`
 * must be above every one of them, or `loadContractEnv` refuses it — a
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
import type { ContractEnv } from './env';

/**
 * How long a request waits on a key another request is still working on, before it
 * answers `409 CONFLICT` with `Retry-After`. A command takes a fraction of a second, so a
 * double submit is normally answered with the first request's own response.
 */
export const IN_FLIGHT_WAIT_MS = 5_000;

/** Slack for the waiting transaction beyond its lock wait, so the wait ends first. */
export const WAIT_TRANSACTION_SLACK_MS = 2_000;

/** The room a signing transaction has besides the hierarchy question's deadline. */
export const SIGNING_TRANSACTION_MARGIN_MS = 10_000;

/**
 * How long a signing transaction may run, holding the contract row and the
 * policy-slot lock: the hierarchy question's deadline and some room. So also
 * the longest a statement waiting on those locks waits (#268).
 */
export function signingTransactionTimeoutMs(
  env: Pick<ContractEnv, 'CONTRACT_ORGANIZATION_REQUEST_TIMEOUT_MS'>,
): number {
  return env.CONTRACT_ORGANIZATION_REQUEST_TIMEOUT_MS + SIGNING_TRANSACTION_MARGIN_MS;
}

export function contractOperationBudgets(env: ContractEnv): readonly OperationBudget[] {
  return [
    // Proposals, milestones, cancellations, policy and suspension changes.
    PRISMA_DEFAULT_TRANSACTION_BUDGET,
    idempotencyClaimOperationBudget(
      'IN_FLIGHT_WAIT_MS',
      IN_FLIGHT_WAIT_MS,
      WAIT_TRANSACTION_SLACK_MS,
    ),
    {
      name: 'CONTRACT_ORGANIZATION_REQUEST_TIMEOUT_MS',
      budgetMs: signingTransactionTimeoutMs(env),
      derivation:
        'a signature, policy change or suspension waits on the policy-slot lock a signing ' +
        'transaction holds across the organization-service call: its transaction timeout, ' +
        `this setting + ${SIGNING_TRANSACTION_MARGIN_MS} ms`,
    },
    outboxRenewalOperationBudget(env),
  ];
}
