interface ClaimBudget {
  leaseSeconds: number;
  processingBudgetMs: number;
}

/** Conservative lease age from before the claim/renewal, independent of wall-clock skew. */
export function hasClaimBudget(started: number, budget: ClaimBudget): boolean {
  const elapsed = performance.now() - started;
  const leaseMs = budget.leaseSeconds * 1000;
  return (
    Number.isFinite(leaseMs) &&
    Number.isFinite(budget.processingBudgetMs) &&
    budget.processingBudgetMs > 0 &&
    elapsed >= 0 &&
    leaseMs - elapsed >= budget.processingBudgetMs
  );
}

/** Claim only when the caller is ready: no lease is spent waiting behind another item. */
export async function* claimWhenReady<T>(
  limit: number,
  stopped: () => boolean,
  claim: () => Promise<readonly T[]>,
  budget: ClaimBudget,
  onInsufficientLease: () => void,
): AsyncGenerator<T, void, void> {
  for (let taken = 0; taken < limit && !stopped(); taken += 1) {
    const started = performance.now();
    const rows = await claim();
    if (rows.length === 0) return;
    const [item] = rows;
    if (rows.length !== 1 || item === undefined) throw new Error('Expected one just-in-time claim');
    if (!hasClaimBudget(started, budget)) {
      onInsufficientLease();
      return; // Commit may have succeeded: discard the result and leave the claim to expire.
    }
    yield item;
  }
}
