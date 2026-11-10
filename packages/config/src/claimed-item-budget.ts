/** Prisma's acquisition bound, made explicit on the two sweeper clients. */
export const CLAIM_TRANSACTION_MAX_WAIT_MS = 2_000;
const LEASE_MARGIN_MS = 1_000;

/**
 * One outstanding claim: claim/return + processing + failure recording, including acquisition
 * of each transaction and the optional remote request. Window steps renew inside their transaction,
 * so the same bound covers every step, regardless of how many steps the window requires.
 * Batch size does not multiply this budget: the next item is not claimed until this one finishes.
 */
export function claimedItemBudgetMs(transactionMs: number, requestMs = 0): number {
  return 3 * (CLAIM_TRANSACTION_MAX_WAIT_MS + transactionMs) + requestMs + LEASE_MARGIN_MS;
}
