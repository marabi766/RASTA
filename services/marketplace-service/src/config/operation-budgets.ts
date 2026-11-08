/**
 * marketplace-service's operation budgets (#268 r4): how long each operation it
 * runs on its database may take. A configured `DATABASE_STATEMENT_TIMEOUT_MS`
 * must be above every one of them, or `loadMarketplaceEnv` refuses it — a
 * statement timeout never cancels an operation the service supports.
 *
 * The fixed budgets are declared here and imported by the code they bound, so
 * the list cannot fall behind it. A leaf module: nothing here imports the code
 * that uses it.
 */
import {
  PRISMA_DEFAULT_TRANSACTION_BUDGET,
  PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS,
  idempotencyClaimOperationBudget,
  type OperationBudget,
} from '@rasta/config';
import { outboxRenewalOperationBudget } from '@rasta/nest-common';
import type { MarketplaceEnv } from './env';

/**
 * The most one claim waits on another transaction's lock on its key, over all
 * its attempts — the same bound the other services' stores keep. A cleanup or
 * a racing request holding the key past it gets the in-flight 409 with
 * `Retry-After`, never an unbounded wait.
 */
export const CLAIM_WAIT_MS = 5_000;

export const SAGA_START_DB_MAX_WAIT_MS = 1000;
export const SAGA_START_DB_TIMEOUT_MS = 1500;
export const SAGA_START_STOP_BUDGET_MS = SAGA_START_DB_MAX_WAIT_MS + SAGA_START_DB_TIMEOUT_MS;

/** Slack for a claim-side transaction beyond its lock wait, so the wait ends first. */
export const WAIT_TRANSACTION_SLACK_MS = 2_000;

/**
 * The most the saga waits for an order's row before an authorisation (D-138).
 * Whoever holds it is a command in Prisma's default transaction, over by then.
 */
export const ORDER_HOLD_WAIT_MS = PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS;

/**
 * How long an authorisation may take while it holds the order's row, body
 * included, whatever `ECONOMIC_REQUEST_TIMEOUT_MS` allows other calls. A party's
 * dispute waits behind it inside its own 5 s transaction, and an operator's
 * decision also asks organization-service in there (2 s at most), so this leaves
 * both time to finish. Slower than this is an unconfirmed call: the next attempt
 * reconciles it (`economicStep`).
 */
export const ORDER_HOLD_SEND_DEADLINE_MS = 2_000;

/** The hold's transaction: the wait and the send always end before it does. */
export const ORDER_HOLD_TRANSACTION_MS =
  ORDER_HOLD_WAIT_MS + ORDER_HOLD_SEND_DEADLINE_MS + WAIT_TRANSACTION_SLACK_MS;

export function marketplaceOperationBudgets(env: MarketplaceEnv): readonly OperationBudget[] {
  return [
    // Every order and catalogue write, and the saga's transitions.
    PRISMA_DEFAULT_TRANSACTION_BUDGET,
    idempotencyClaimOperationBudget('CLAIM_WAIT_MS', CLAIM_WAIT_MS, WAIT_TRANSACTION_SLACK_MS),
    {
      name: 'ORDER_HOLD_TRANSACTION_MS',
      budgetMs: ORDER_HOLD_TRANSACTION_MS,
      derivation:
        `an authorisation under the order's row lock: a wait of up to ${ORDER_HOLD_WAIT_MS} ms, ` +
        `a send of up to ${ORDER_HOLD_SEND_DEADLINE_MS} ms and ${WAIT_TRANSACTION_SLACK_MS} ms of slack`,
    },
    outboxRenewalOperationBudget(env),
  ];
}
