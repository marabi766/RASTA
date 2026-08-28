import {
  accountCodeFor,
  isPlatformPurpose,
  naturalBalance,
  NATURAL_BALANCE,
  PURPOSE_TYPE,
} from './accounts';
import type { AccountPurpose } from '../generated/prisma';

/**
 * The chart of accounts (docs/10 § 10.4).
 *
 * The tests that matter here are about *sign*. Getting a natural balance
 * backwards would report every wallet as owing the platform money, and it is
 * the kind of mistake that looks plausible in code review — which is why the
 * pairing is a table and the table is asserted.
 */

const ALL_PURPOSES: AccountPurpose[] = [
  'WALLET',
  'ESCROW',
  'COMMISSION_REVENUE',
  'REWARD_EXPENSE',
  'PAYMENT_CLEARING',
];

describe('PURPOSE_TYPE', () => {
  it('makes a wallet a liability, not an asset', () => {
    // From the platform's point of view a user's balance is money it owes
    // them (docs/10 § 10.4). Modelling it as an asset would put every user's
    // funds on the platform's own side of the ledger.
    expect(PURPOSE_TYPE.WALLET).toBe('LIABILITY');
  });

  it('makes escrow a liability too', () => {
    // Escrowed money is still the payer's; it has merely been promised
    // (ADR-034).
    expect(PURPOSE_TYPE.ESCROW).toBe('LIABILITY');
  });

  it('makes commission revenue and reward expense what they are', () => {
    expect(PURPOSE_TYPE.COMMISSION_REVENUE).toBe('REVENUE');
    expect(PURPOSE_TYPE.REWARD_EXPENSE).toBe('EXPENSE');
  });

  it('covers every purpose', () => {
    // A new purpose with no type would default to `undefined` and post an
    // entry to an account with no natural direction.
    for (const purpose of ALL_PURPOSES) {
      expect(PURPOSE_TYPE[purpose]).toBeDefined();
    }
  });
});

describe('naturalBalance', () => {
  it('reads a credit-natured account in the direction that increases it', () => {
    // A wallet holding 10 000 rial has a credit balance of 10 000, not a debit
    // balance of −10 000.
    expect(naturalBalance('LIABILITY', 0n, 10_000n)).toBe(10_000n);
    expect(naturalBalance('REVENUE', 0n, 200_000n)).toBe(200_000n);
    expect(naturalBalance('EQUITY', 0n, 5n)).toBe(5n);
  });

  it('reads a debit-natured account the other way', () => {
    expect(naturalBalance('ASSET', 10_000n, 0n)).toBe(10_000n);
    expect(naturalBalance('EXPENSE', 20_000n, 0n)).toBe(20_000n);
  });

  it('nets movements in both directions', () => {
    // A wallet topped up 10 000 and then holding 4 000 into escrow.
    expect(naturalBalance('LIABILITY', 4_000n, 10_000n)).toBe(6_000n);
  });

  it('returns zero for an untouched account', () => {
    expect(naturalBalance('LIABILITY', 0n, 0n)).toBe(0n);
  });

  it('assigns every account type a natural direction', () => {
    for (const type of ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const) {
      expect(NATURAL_BALANCE[type]).toMatch(/^(DEBIT|CREDIT)$/);
    }
  });
});

describe('accountCodeFor', () => {
  it('spells a code a reader can interpret without a lookup', () => {
    expect(accountCodeFor('WALLET', 'ORG_01JBQ8', 'IRR')).toBe('LIAB-ORG_01JBQ8-WALLET');
  });

  it('uses the organization id verbatim, never abbreviated', () => {
    // An id this platform issued is already readable and already
    // organization-agnostic (ADR-012); shortening it would risk collisions for
    // no gain.
    expect(accountCodeFor('ESCROW', 'ORG-UNION-YAZD', 'IRR')).toContain('ORG-UNION-YAZD');
  });

  it('gives each purpose its own code for one organization', () => {
    const codes = ALL_PURPOSES.map((purpose) => accountCodeFor(purpose, 'ORG-A', 'IRR'));
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('leaves the base currency unmarked and names any other', () => {
    // Phase one is IRR-only, so an unsuffixed code reads cleanly; a second
    // currency has to be distinguishable, because the uniqueness constraint is
    // on `(organization, code, currency)`.
    expect(accountCodeFor('WALLET', 'ORG-A', 'IRR')).toBe('LIAB-ORG-A-WALLET');
    expect(accountCodeFor('WALLET', 'ORG-A', 'USD')).toBe('LIAB-ORG-A-WALLET-USD');
  });
});

describe('isPlatformPurpose', () => {
  it('keeps a wallet and its escrow with the organization', () => {
    // ADR-034. Escrowed money is the payer's, so the account is theirs.
    expect(isPlatformPurpose('WALLET')).toBe(false);
    expect(isPlatformPurpose('ESCROW')).toBe(false);
  });

  it('puts revenue, expense and clearing on the platform side', () => {
    // Commission revenue inside a customer's own ledger would be a plain
    // accounting error.
    expect(isPlatformPurpose('COMMISSION_REVENUE')).toBe(true);
    expect(isPlatformPurpose('REWARD_EXPENSE')).toBe(true);
    expect(isPlatformPurpose('PAYMENT_CLEARING')).toBe(true);
  });
});
