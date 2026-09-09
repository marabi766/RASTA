import { screen } from '@testing-library/react';
import { LedgerView } from './ledger-view';
import { WalletView } from './wallet-view';
import {
  expectNoAxeViolations,
  makeHarness,
  renderRoute,
  renderWithSession,
  respondError,
} from '@/test/harness';

/**
 * Wallet, transactions and the ledger.
 *
 * Three separate claims are protected here, and each of them is one an
 * enthusiastic UI would get wrong in a different direction.
 */

const WALLET = {
  id: 'wal_1',
  organizationId: 'org_one',
  currency: 'IRR',
  status: 'ACTIVE',
  // Deliberately past Number.MAX_SAFE_INTEGER.
  ledgerBalanceMinor: '9007199254740993',
  pendingBalanceMinor: '310400000',
  availableBalanceMinor: '9007198944340993',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const SIMULATED_PROVIDER = {
  provider: 'mock',
  simulated: true,
  notice: 'Simulated payment provider. No bank connection, no real funds, no custody of money.',
};

const TRANSACTIONS = {
  items: [
    {
      id: 'txn_1',
      organizationId: 'org_one',
      counterpartyOrganizationId: 'org_supplier',
      transactionType: 'ORDER_PAYMENT',
      status: 'SETTLED',
      grossAmountMinor: '304000000',
      commissionAmountMinor: '0',
      netAmountMinor: '304000000',
      currency: 'IRR',
      occurredAt: '2026-02-01T00:00:00.000Z',
      sourceType: 'ORDER',
      sourceReference: 'ord_1',
      disputedAt: null,
      disputeReason: null,
      settledAt: '2026-02-02T00:00:00.000Z',
      failureReason: null,
      createdAt: '2026-02-01T00:00:00.000Z',
      createdBy: 'usr_1',
    },
  ],
  nextCursor: null,
  hasMore: false,
};

const walletRoutes = (overrides: Record<string, unknown> = {}) => ({
  '/v1/wallets/me': WALLET,
  '/v1/wallets/provider': SIMULATED_PROVIDER,
  '/v1/transactions': TRANSACTIONS,
  ...overrides,
});

describe('wallet balances', () => {
  it('renders a balance beyond safe-integer range exactly', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(walletRoutes()));

    renderWithSession(<WalletView />, session);

    expect(await screen.findByText('۹٬۰۰۷٬۱۹۹٬۲۵۴٬۷۴۰٬۹۹۳ ریال')).toBeInTheDocument();
  });

  it('shows the three balances from the service without recomputing any of them', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(walletRoutes()));

    renderWithSession(<WalletView />, session);
    await screen.findByText('۳۱۰٬۴۰۰٬۰۰۰ ریال');

    // `available = ledger − pending` is enforced by a database constraint. A
    // browser subtracting them again would be a second arithmetic that could
    // disagree with the authoritative one, so all three are rendered as given.
    expect(screen.getByText('۹٬۰۰۷٬۱۹۸٬۹۴۴٬۳۴۰٬۹۹۳ ریال')).toBeInTheDocument();
  });
});

describe('payment provider disclosure', () => {
  it('reports simulation from the API rather than asserting it', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(walletRoutes()));

    renderWithSession(<WalletView />, session);

    expect(await screen.findByText('شبیه‌سازی‌شده')).toBeInTheDocument();
    expect(screen.getByText(SIMULATED_PROVIDER.notice)).toBeInTheDocument();
    expect(screen.getByText(/هیچ اتصال بانکی وجود ندارد/)).toBeInTheDocument();
  });

  it('stops claiming simulation the moment a live provider is configured', async () => {
    // The service's own contract suite asserts this inverse. A hard-coded
    // banner would become a lie on that day (ADR-024).
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(
      renderRoute(
        walletRoutes({
          '/v1/wallets/provider': {
            provider: 'bank-gateway',
            simulated: false,
            notice: 'Live payment provider.',
          },
        }),
      ),
    );

    renderWithSession(<WalletView />, session);

    expect(await screen.findByText('ارائه‌دهندهٔ واقعی')).toBeInTheDocument();
    expect(screen.queryByText('شبیه‌سازی‌شده')).not.toBeInTheDocument();
    expect(screen.queryByText(/هیچ اتصال بانکی وجود ندارد/)).not.toBeInTheDocument();
  });
});

describe('transactions', () => {
  it('shows gross, commission and net separately', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(walletRoutes()));

    renderWithSession(<WalletView />, session);
    await screen.findByRole('table');

    // Commission is deducted from the payee's net, never added to the buyer's
    // total. Showing one figure would let the intuitive, wrong reading stand.
    expect(screen.getAllByText('۳۰۴٬۰۰۰٬۰۰۰ ریال').length).toBeGreaterThanOrEqual(2);
  });

  it('reads a zero commission as "no rule matched", not as free', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(walletRoutes()));

    renderWithSession(<WalletView />, session);

    // Q-08 is open: no commission rate is approved, so zero means nothing
    // matched rather than that the platform charges nothing.
    expect(await screen.findByText('قاعده‌ای مطابقت نکرد')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute(walletRoutes()));

    const { container } = renderWithSession(<WalletView />, session);
    await screen.findByRole('table');

    await expectNoAxeViolations(container);
  });
});

// ---------------------------------------------------------------------------

const ACCOUNTS = {
  items: [
    {
      id: 'acc_1',
      organizationId: 'org_one',
      accountType: 'ASSET',
      accountCode: '1010-WALLET',
      purpose: 'WALLET',
      currency: 'IRR',
      status: 'ACTIVE',
      title: 'کیف پول سازمان',
    },
  ],
};

const balance = (balanced: boolean) => ({
  currency: 'IRR',
  totalDebitMinor: '136000000',
  totalCreditMinor: balanced ? '136000000' : '135000000',
  balanced,
  accounts: [
    {
      accountId: 'acc_1',
      accountCode: '1010-WALLET',
      accountType: 'ASSET',
      organizationId: 'org_one',
      currency: 'IRR',
      debitMinor: '136000000',
      creditMinor: '0',
      balanceMinor: '136000000',
    },
  ],
});

describe('trial balance', () => {
  it('confirms a balanced ledger quietly', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(
      renderRoute({ '/v1/ledger/accounts': ACCOUNTS, '/v1/ledger/trial-balance': balance(true) }),
    );

    renderWithSession(<LedgerView />, session);

    expect(await screen.findByText('متوازن')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('raises an alarm on an unbalanced ledger', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(
      renderRoute({ '/v1/ledger/accounts': ACCOUNTS, '/v1/ledger/trial-balance': balance(false) }),
    );

    renderWithSession(<LedgerView />, session);

    // `balanced: false` in an immutable double-entry ledger is a critical
    // integrity failure, not a field to render in grey next to the others.
    expect(await screen.findByText('نامتوازن — هشدار بحرانی')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/نقص یکپارچگی/);
  });

  it('renders a role refusal on the trial balance as a refusal', async () => {
    // The route is restricted to SYSTEM_ADMIN and UNION_ADMIN at the gateway
    // *and* again in the service. An ORGANIZATION_ADMIN reading its own
    // accounts but not the platform-wide balance is the system working.
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation((input: string) =>
      new URL(input).pathname === '/v1/ledger/trial-balance'
        ? respondError(403, 'FORBIDDEN')()
        : renderRoute({ '/v1/ledger/accounts': ACCOUNTS })(input),
    );

    renderWithSession(<LedgerView />, session);

    expect(await screen.findByText('این بخش برای نقش شما باز نیست')).toBeInTheDocument();
    // The accounts section still rendered.
    expect(screen.getByText('1010-WALLET')).toBeInTheDocument();
  });
});
