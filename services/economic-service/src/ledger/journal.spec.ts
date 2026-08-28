import { assertBalanced, deltaByCurrency, reverseEntries, singleCurrency } from './journal';
import type { DraftEntry } from './journal';

/**
 * Journal balancing — the first of docs/10 § 10.12's mandatory financial
 * integrity tests, and the property ADR-013 makes a merge gate.
 *
 * These exercise the *first* of two enforcement layers. The second is
 * `trg_journal_balanced` in the migration, proven against a real PostgreSQL in
 * `test/ledger-immutability.int-spec.ts`. Both exist because they protect
 * different things: this one gives a caller `LEDGER_UNBALANCED` instead of a
 * driver error, and the trigger protects the ledger from any code path that
 * never calls this file.
 */

function entry(overrides: Partial<DraftEntry> = {}): DraftEntry {
  return {
    accountId: 'ACC_1',
    organizationId: 'ORG-A',
    direction: 'DEBIT',
    amountMinor: 1000n,
    currency: 'IRR',
    ...overrides,
  };
}

describe('deltaByCurrency', () => {
  it('nets debits against credits', () => {
    const totals = deltaByCurrency([
      entry({ direction: 'DEBIT', amountMinor: 1000n }),
      entry({ direction: 'CREDIT', amountMinor: 400n }),
    ]);

    expect(totals.get('IRR')).toBe(600n);
  });

  it('keeps currencies apart rather than netting across them', () => {
    // A journal that sums to zero only by treating two currencies as
    // interchangeable is an unrated foreign-exchange transaction, not a
    // balanced journal (docs/10 § 10.4).
    const totals = deltaByCurrency([
      entry({ direction: 'DEBIT', amountMinor: 1000n, currency: 'IRR' }),
      entry({ direction: 'CREDIT', amountMinor: 1000n, currency: 'USD' }),
    ]);

    expect(totals.get('IRR')).toBe(1000n);
    expect(totals.get('USD')).toBe(-1000n);
  });

  it('handles amounts beyond Number.MAX_SAFE_INTEGER exactly', () => {
    // The whole reason money is bigint. 9_007_199_254_740_993 is the first
    // integer a double cannot represent.
    const huge = 9_007_199_254_740_993n;
    const totals = deltaByCurrency([
      entry({ direction: 'DEBIT', amountMinor: huge }),
      entry({ direction: 'CREDIT', amountMinor: huge }),
    ]);

    expect(totals.get('IRR')).toBe(0n);
  });
});

describe('assertBalanced', () => {
  it('accepts a balanced two-legged journal', () => {
    expect(() =>
      assertBalanced('JRN_1', [
        entry({ direction: 'DEBIT', amountMinor: 10_000_000n }),
        entry({ direction: 'CREDIT', amountMinor: 10_000_000n, accountId: 'ACC_2' }),
      ]),
    ).not.toThrow();
  });

  it('accepts the three-legged settlement journal from docs/10 § 10.4', () => {
    // The worked example: 10,000,000 out of escrow, 9,800,000 to the supplier
    // and 200,000 of commission.
    expect(() =>
      assertBalanced('JRN_1', [
        entry({ direction: 'DEBIT', amountMinor: 10_000_000n, accountId: 'ACC_ESCROW' }),
        entry({ direction: 'CREDIT', amountMinor: 9_800_000n, accountId: 'ACC_SUPPLIER' }),
        entry({ direction: 'CREDIT', amountMinor: 200_000n, accountId: 'ACC_REVENUE' }),
      ]),
    ).not.toThrow();
  });

  it('refuses a single-legged journal', () => {
    // Not double-entry bookkeeping at all — and the failure the database
    // trigger also checks for.
    expect(() => assertBalanced('JRN_1', [entry()])).toThrow(
      expect.objectContaining({ code: 'LEDGER_UNBALANCED' }),
    );
  });

  it('refuses an empty journal', () => {
    expect(() => assertBalanced('JRN_1', [])).toThrow(
      expect.objectContaining({ code: 'LEDGER_UNBALANCED' }),
    );
  });

  it('refuses a journal that is off by one minor unit', () => {
    // One rial. The amount that makes rounding bugs invisible in testing and
    // catastrophic in reconciliation.
    expect(() =>
      assertBalanced('JRN_1', [
        entry({ direction: 'DEBIT', amountMinor: 10_000_000n }),
        entry({ direction: 'CREDIT', amountMinor: 9_999_999n, accountId: 'ACC_2' }),
      ]),
    ).toThrow(expect.objectContaining({ code: 'LEDGER_UNBALANCED' }));
  });

  it('refuses a zero-amount entry', () => {
    expect(() =>
      assertBalanced('JRN_1', [
        entry({ direction: 'DEBIT', amountMinor: 0n }),
        entry({ direction: 'CREDIT', amountMinor: 0n, accountId: 'ACC_2' }),
      ]),
    ).toThrow(expect.objectContaining({ code: 'LEDGER_UNBALANCED' }));
  });

  it('refuses a negative entry', () => {
    // The sign lives in `direction`; a negative amount would let one entry
    // silently reverse another.
    expect(() =>
      assertBalanced('JRN_1', [
        entry({ direction: 'DEBIT', amountMinor: -1000n }),
        entry({ direction: 'CREDIT', amountMinor: -1000n, accountId: 'ACC_2' }),
      ]),
    ).toThrow(expect.objectContaining({ code: 'LEDGER_UNBALANCED' }));
  });

  it('refuses a journal balanced only by netting two currencies', () => {
    expect(() =>
      assertBalanced('JRN_1', [
        entry({ direction: 'DEBIT', amountMinor: 1000n, currency: 'IRR' }),
        entry({ direction: 'CREDIT', amountMinor: 1000n, currency: 'USD', accountId: 'ACC_2' }),
      ]),
    ).toThrow(expect.objectContaining({ code: 'LEDGER_UNBALANCED' }));
  });

  it('names the currency and the delta in the failure', () => {
    // "Unbalanced" with no figure sends an operator to the database anyway.
    try {
      assertBalanced('JRN_1', [
        entry({ direction: 'DEBIT', amountMinor: 500n }),
        entry({ direction: 'CREDIT', amountMinor: 300n, accountId: 'ACC_2' }),
      ]);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as { internalContext?: { delta?: string } }).internalContext?.delta).toBe(
        'IRR: 200',
      );
    }
  });
});

describe('reverseEntries', () => {
  const original: DraftEntry[] = [
    entry({ direction: 'DEBIT', amountMinor: 10_000_000n, accountId: 'ACC_WALLET' }),
    entry({ direction: 'CREDIT', amountMinor: 10_000_000n, accountId: 'ACC_ESCROW' }),
  ];

  it('mirrors every direction and keeps every amount', () => {
    const reversed = reverseEntries(original);

    expect(reversed).toEqual([
      expect.objectContaining({
        accountId: 'ACC_WALLET',
        direction: 'CREDIT',
        amountMinor: 10_000_000n,
      }),
      expect.objectContaining({
        accountId: 'ACC_ESCROW',
        direction: 'DEBIT',
        amountMinor: 10_000_000n,
      }),
    ]);
  });

  it('produces a journal that balances', () => {
    expect(() => assertBalanced('JRN_REV', reverseEntries(original))).not.toThrow();
  });

  it('nets to zero against the original, so balances return exactly', () => {
    // The property ADR-013 requires and docs/10 § 10.12 names: reversing a
    // journal returns every affected account to precisely its prior balance.
    const combined = deltaByCurrency([...original, ...reverseEntries(original)]);
    expect(combined.get('IRR')).toBe(0n);
  });

  it('is its own inverse', () => {
    expect(reverseEntries(reverseEntries(original))).toEqual(original);
  });

  it('does not mutate the entries it was given', () => {
    const snapshot = structuredClone(original);
    reverseEntries(original);
    expect(original).toEqual(snapshot);
  });
});

describe('singleCurrency', () => {
  it('returns the one currency of a journal', () => {
    expect(singleCurrency('JRN_1', [entry(), entry({ accountId: 'ACC_2' })])).toBe('IRR');
  });

  it('refuses a journal spanning currencies', () => {
    // Phase one is IRR-only and there is no exchange rate anywhere on this
    // platform, so a two-currency journal would be an unrated conversion
    // (docs/10 § 10.11).
    expect(() =>
      singleCurrency('JRN_1', [entry({ currency: 'IRR' }), entry({ currency: 'USD' })]),
    ).toThrow(expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }));
  });

  it('refuses a journal with no entries at all', () => {
    expect(() => singleCurrency('JRN_1', [])).toThrow(
      expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION' }),
    );
  });
});
