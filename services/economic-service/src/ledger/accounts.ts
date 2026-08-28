import type { AccountPurpose, AccountType, EntryDirection } from '../generated/prisma';

/**
 * The chart of accounts (docs/10 § 10.4).
 *
 * Pure functions over the account model: what type a purpose implies, which
 * direction increases a balance, and how a code is spelled. No database, no
 * request context — so every rule here is unit-testable without either, and a
 * mistake shows up as a failing assertion rather than as a wrong balance.
 */

/**
 * Which account type each purpose is.
 *
 * Derived rather than stored per row, because the pairing is a fact about
 * accounting rather than about any particular account. A wallet account is a
 * LIABILITY — from the platform's point of view, a user's balance is money the
 * platform owes them (docs/10 § 10.4) — and no configuration should be able to
 * make one an ASSET.
 */
export const PURPOSE_TYPE: Record<AccountPurpose, AccountType> = {
  /** The platform owes the organization its wallet balance. */
  WALLET: 'LIABILITY',
  /**
   * Funds committed to an obligation and not yet settled.
   *
   * Also a LIABILITY, and **per organization** rather than pooled at the
   * platform (ADR-034): the money is still the payer's, it has merely been
   * promised. Holding it in the payer's own account is what makes
   * `pendingBalance` a real ledger balance rather than a sum over a table, and
   * what keeps `available = ledger - pending` exactly true.
   */
  ESCROW: 'LIABILITY',
  /** Commission earned. */
  COMMISSION_REVENUE: 'REVENUE',
  /** Reward credit granted, expensed as it is granted (ADR-033). */
  REWARD_EXPENSE: 'EXPENSE',
  /**
   * The counterpart of an inbound top-up.
   *
   * An ASSET in form. In this MVP it holds **no real money**: the provider is
   * simulated and nothing has been received from a bank (ADR-024). It exists
   * so a top-up is a balanced journal rather than value appearing from
   * nowhere, and so the day a real provider is connected, the account it
   * settles into already exists.
   */
  PAYMENT_CLEARING: 'ASSET',
};

/**
 * The direction that *increases* an account of this type — its natural
 * balance (docs/10 § 10.4).
 *
 * Assets and expenses are debit-natured; liabilities, revenue and equity are
 * credit-natured. This is what turns a pile of signed entries into a balance a
 * human recognises: a wallet with 10 000 rial in it has a credit balance of
 * 10 000, not a debit balance of −10 000.
 */
export const NATURAL_BALANCE: Record<AccountType, EntryDirection> = {
  ASSET: 'DEBIT',
  EXPENSE: 'DEBIT',
  LIABILITY: 'CREDIT',
  REVENUE: 'CREDIT',
  EQUITY: 'CREDIT',
};

/**
 * The balance of an account, in its natural direction.
 *
 * `debits − credits` for a debit-natured account, the reverse for a
 * credit-natured one. Reporting every balance as a raw signed sum would leave
 * every reader of a statement to remember the sign convention for each account
 * type, which is exactly the kind of implicit knowledge a financial report
 * should not require.
 */
export function naturalBalance(
  accountType: AccountType,
  debitTotalMinor: bigint,
  creditTotalMinor: bigint,
): bigint {
  return NATURAL_BALANCE[accountType] === 'DEBIT'
    ? debitTotalMinor - creditTotalMinor
    : creditTotalMinor - debitTotalMinor;
}

/** Short prefixes used in account codes, one per type. */
const TYPE_PREFIX: Record<AccountType, string> = {
  ASSET: 'ASST',
  LIABILITY: 'LIAB',
  EQUITY: 'EQTY',
  REVENUE: 'REV',
  EXPENSE: 'EXP',
};

/**
 * Builds an account code: `<TYPE>-<ORG>-<PURPOSE>` (docs/10 § 10.4).
 *
 * The organization segment is part of the code so that a journal line reads
 * unambiguously without a lookup — `LIAB-ORG_01JBQ8-WALLET` says whose wallet
 * it is. That is also why the uniqueness constraint is on
 * `(organization_id, account_code, currency)` rather than on the code alone:
 * the code already contains the organization, and the constraint makes the
 * redundancy impossible to break.
 *
 * The organization id is used verbatim, never abbreviated or hashed. An id
 * this platform issued is already readable and already organization-agnostic
 * (ADR-012); shortening it would introduce collisions for no gain.
 */
export function accountCodeFor(
  purpose: AccountPurpose,
  organizationId: string,
  currency: string,
): string {
  const type = PURPOSE_TYPE[purpose];
  return (
    `${TYPE_PREFIX[type]}-${organizationId}-${purpose}` + (currency === 'IRR' ? '' : `-${currency}`)
  );
}

/**
 * Purposes whose account belongs to the organization itself.
 *
 * Everything else belongs to the configured platform organization
 * (`ECONOMIC_PLATFORM_ORGANIZATION_ID`) rather than to whichever tenant's
 * request happened to trigger the posting — putting commission revenue inside
 * a customer's own ledger would be a straightforward accounting error.
 *
 * `ESCROW` is on the tenant side, and that is ADR-034's decision rather than
 * an oversight: escrowed money is still the payer's.
 */
const TENANT_OWNED: ReadonlySet<AccountPurpose> = new Set<AccountPurpose>(['WALLET', 'ESCROW']);

export function isPlatformPurpose(purpose: AccountPurpose): boolean {
  return !TENANT_OWNED.has(purpose);
}
