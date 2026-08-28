import { assertSufficient, balancesFrom, isConsistent } from './balances';

/**
 * The wallet invariant (docs/10 § 10.3, ADR-013, ADR-034).
 *
 *   available = wallet account balance
 *   pending   = escrow account balance
 *   ledger    = available + pending
 *
 * which is docs/10's `available = ledger − pending`, with the contradiction
 * ADR-034 describes resolved. `ck_wallet_balances` enforces the same relation
 * in the database; these tests cover the layer that turns a refusal into a
 * readable error rather than a driver exception.
 */

describe('balancesFrom', () => {
  it('derives the total from the two account balances', () => {
    expect(balancesFrom(700n, 300n)).toEqual({
      availableBalanceMinor: 700n,
      pendingBalanceMinor: 300n,
      ledgerBalanceMinor: 1000n,
    });
  });

  it('reports an all-escrowed wallet as spendable-zero, not total-zero', () => {
    // The failure ADR-034 was written to prevent: a wallet whose funds are all
    // committed still owns them, and reporting the total as zero would tell a
    // user their money had vanished.
    expect(balancesFrom(0n, 10_000_000n)).toEqual({
      availableBalanceMinor: 0n,
      pendingBalanceMinor: 10_000_000n,
      ledgerBalanceMinor: 10_000_000n,
    });
  });

  it('holds exactly at amounts beyond Number.MAX_SAFE_INTEGER', () => {
    const big = 9_007_199_254_740_993n;
    expect(balancesFrom(big, big).ledgerBalanceMinor).toBe(big * 2n);
  });
});

describe('isConsistent', () => {
  it('accepts a coherent wallet', () => {
    expect(isConsistent(balancesFrom(700n, 300n))).toBe(true);
  });

  it('accepts an empty wallet', () => {
    expect(isConsistent(balancesFrom(0n, 0n))).toBe(true);
  });

  it('rejects a negative available balance', () => {
    expect(
      isConsistent({
        availableBalanceMinor: -1n,
        pendingBalanceMinor: 0n,
        ledgerBalanceMinor: -1n,
      }),
    ).toBe(false);
  });

  it('rejects a total that disagrees with its parts', () => {
    // What the reconciliation looks for. It reports rather than repairs: a
    // wallet that disagrees with its ledger is an incident for a human
    // (docs/10 § 10.3).
    expect(
      isConsistent({
        availableBalanceMinor: 700n,
        pendingBalanceMinor: 300n,
        ledgerBalanceMinor: 999n,
      }),
    ).toBe(false);
  });

  it('rejects a negative pending balance', () => {
    expect(
      isConsistent({
        availableBalanceMinor: 1000n,
        pendingBalanceMinor: -100n,
        ledgerBalanceMinor: 900n,
      }),
    ).toBe(false);
  });
});

describe('assertSufficient', () => {
  const wallet = balancesFrom(1_000_000n, 400_000n);

  it('permits a spend the wallet can cover', () => {
    expect(() => assertSufficient('WLT_1', wallet, 1_000_000n)).not.toThrow();
  });

  it('permits spending the entire available balance', () => {
    expect(() => assertSufficient('WLT_1', balancesFrom(500n, 0n), 500n)).not.toThrow();
  });

  it('refuses one minor unit more than is available', () => {
    expect(() => assertSufficient('WLT_1', wallet, 1_000_001n)).toThrow(
      expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }),
    );
  });

  it('refuses a spend that only the escrowed funds would cover', () => {
    // Pending money is committed to another obligation. Spending it would be
    // the double-commit the hold cycle exists to prevent.
    expect(() => assertSufficient('WLT_1', balancesFrom(0n, 10_000_000n), 1n)).toThrow(
      expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }),
    );
  });

  it('refuses a zero amount', () => {
    expect(() => assertSufficient('WLT_1', wallet, 0n)).toThrow(
      expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }),
    );
  });

  it('refuses a negative amount', () => {
    // Otherwise a "spend" of −1 would be a credit nobody authorised.
    expect(() => assertSufficient('WLT_1', wallet, -1n)).toThrow(
      expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }),
    );
  });

  it('keeps the balance out of the client-facing message', () => {
    // A caller probing another organization's wallet must not learn its
    // balance from an error (AGENTS.md S-09). The figures go to
    // `internalContext`, which the exception filter never serialises.
    try {
      assertSufficient('WLT_1', wallet, 5_000_000n);
      throw new Error('expected a refusal');
    } catch (error) {
      const thrown = error as { message: string; internalContext?: Record<string, unknown> };
      expect(thrown.message).toBe('Insufficient available balance');
      expect(thrown.message).not.toContain('1000000');
      expect(thrown.internalContext).toMatchObject({ available: '1000000', requested: '5000000' });
    }
  });
});
