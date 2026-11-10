/** Prisma's acquisition bound, made explicit on the two sweeper clients. */
export const CLAIM_TRANSACTION_MAX_WAIT_MS = 2_000;
const LEASE_MARGIN_MS = 1_000;

/**
 * Admission allowance for claim, processing and failure recording, including acquisition,
 * optional remote work and margin. This is not an elapsed/commit bound (D-061).
 * Callers must check remaining lease after claim/renewal acknowledgement before processing.
 * Batch size does not multiply this allowance: only one item is claimed when ready.
 */
export function claimedItemBudgetMs(transactionMs: number, requestMs = 0): number {
  return 3 * (CLAIM_TRANSACTION_MAX_WAIT_MS + transactionMs) + requestMs + LEASE_MARGIN_MS;
}
