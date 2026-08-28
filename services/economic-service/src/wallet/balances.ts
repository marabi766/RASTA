import { RastaError } from '@rasta/nest-common';

/**
 * The wallet invariant, as pure functions (docs/10 § 10.3, ADR-013, ADR-034).
 *
 *   availableBalance = natural balance of  LIAB-<ORG>-WALLET
 *   pendingBalance   = natural balance of  LIAB-<ORG>-ESCROW  ( = Σ active holds )
 *   ledgerBalance    = availableBalance + pendingBalance
 *
 * which is the same relation docs/10 § 10.3 states —
 * `available = ledger − pending` — with the contradiction ADR-034 describes
 * resolved: escrowed money is a real ledger movement into the payer's own
 * escrow account, so it is counted once rather than twice.
 *
 * All three are recomputed from the ledger on every mutation rather than
 * incremented. An increment is a read-modify-write, and under concurrency one
 * of two of them is lost — the defect the maintenance phase caught with a real
 * concurrency test (ADR-028). Recomputation makes wallet/ledger drift
 * structurally impossible instead of merely tested for.
 *
 * These functions produce and check the values; `ck_wallet_balances` in the
 * migration refuses to store anything that breaks the relation. The split
 * matters: this file is what gives a caller `INSUFFICIENT_BALANCE` instead of
 * a driver error, and the constraint is what makes an overspend impossible
 * even if some future code path never calls this file at all.
 */

export interface Balances {
  ledgerBalanceMinor: bigint;
  pendingBalanceMinor: bigint;
  availableBalanceMinor: bigint;
}

/**
 * Assembles the three figures from the two ledger account balances.
 *
 * Takes the *account* balances rather than deltas, because that is the only
 * input from which all three can be derived without remembering a previous
 * value.
 */
export function balancesFrom(
  walletAccountBalanceMinor: bigint,
  escrowAccountBalanceMinor: bigint,
): Balances {
  return {
    availableBalanceMinor: walletAccountBalanceMinor,
    pendingBalanceMinor: escrowAccountBalanceMinor,
    ledgerBalanceMinor: walletAccountBalanceMinor + escrowAccountBalanceMinor,
  };
}

/**
 * Whether the three figures are internally consistent.
 *
 * A predicate rather than a throw, because the reconciliation's job is to
 * *report* a deviation, not to fail on it — and certainly not to repair it. A
 * wallet that disagrees with its ledger is an incident for a human
 * (docs/10 § 10.3).
 */
export function isConsistent(balances: Balances): boolean {
  return (
    balances.ledgerBalanceMinor >= 0n &&
    balances.pendingBalanceMinor >= 0n &&
    balances.availableBalanceMinor >= 0n &&
    balances.availableBalanceMinor === balances.ledgerBalanceMinor - balances.pendingBalanceMinor
  );
}

/**
 * Refuses a spend the wallet cannot cover.
 *
 * Called with balances read **under a row lock**, never with a value read
 * earlier: between an unlocked read and the write, a concurrent request can
 * spend the same money and both callers would pass this check. The lock is
 * what makes the answer still true when it is acted on
 * (`wallet.repository.ts`, ADR-031).
 *
 * The figures go into `internalContext`, which is server-side only. They never
 * reach the response body: a caller probing another organization's wallet must
 * not learn its balance from an error message (AGENTS.md S-09).
 */
export function assertSufficient(walletId: string, balances: Balances, amountMinor: bigint): void {
  if (amountMinor <= 0n) {
    throw RastaError.businessRule('Amount must be positive', { walletId });
  }
  if (balances.availableBalanceMinor < amountMinor) {
    throw RastaError.insufficientBalance(
      walletId,
      amountMinor.toString(),
      balances.availableBalanceMinor.toString(),
    );
  }
}
