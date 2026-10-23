import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

import { WalletScreen } from './WalletScreen';
import { formatMoney } from '@/lib/format';
import type {
  HoldsPage,
  PaymentProviderDisclosure,
  ReadResult,
  TransactionPage,
  Wallet,
} from '@/server/wallet';

/**
 * `WalletScreen`, composing four independent reads. Mirrors
 * `DriverDetailScreen`'s own spec: composition and branching are what this
 * file tests, not any one embedded form's internal states — `useActionState`
 * is not mocked, so `TopUpForm` renders in its ordinary idle shape.
 */

// A plain anchor: `next/link` prefetches through an intersection observer whose
// state updates land outside `act` and drown the output in warnings.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const WALLET: Wallet = {
  id: 'WLT_1',
  organizationId: 'ORG_1',
  currency: 'IRR',
  status: 'ACTIVE',
  ledgerBalanceMinor: '1000000',
  pendingBalanceMinor: '200000',
  availableBalanceMinor: '800000',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const HOLDS: HoldsPage = {
  items: [
    {
      id: 'HLD_1',
      walletId: 'WLT_1',
      amountMinor: '200000',
      currency: 'IRR',
      status: 'ACTIVE',
      reference: 'ORD_1',
      referenceType: 'ORDER',
      placedAt: '2026-02-01T00:00:00.000Z',
      resolvedAt: null,
      resolutionNote: null,
    },
  ],
};

const TRANSACTIONS: TransactionPage = {
  items: [
    {
      id: 'TXN_1',
      transactionType: 'MARKETPLACE_ORDER',
      status: 'SETTLED',
      netAmountMinor: '900000',
      currency: 'IRR',
      occurredAt: '2026-02-01T00:00:00.000Z',
      sourceType: null,
      sourceReference: null,
      disputeReason: null,
      settledAt: '2026-02-02T00:00:00.000Z',
      failureReason: null,
    },
  ],
  nextCursor: null,
  hasMore: false,
};

const PROVIDER: PaymentProviderDisclosure = {
  provider: 'mock',
  simulated: true,
  notice: 'Simulated payment provider. No bank connection, no real funds, no custody of money.',
};

function render_(
  overrides: {
    wallet?: ReadResult<Wallet>;
    holds?: ReadResult<HoldsPage>;
    transactions?: ReadResult<TransactionPage>;
    provider?: ReadResult<PaymentProviderDisclosure>;
    query?: { status?: string; transactionType?: string; cursor?: string };
  } = {},
) {
  return render(
    <WalletScreen
      wallet={overrides.wallet ?? { kind: 'OK', data: WALLET }}
      holds={overrides.holds ?? { kind: 'OK', data: HOLDS }}
      transactions={overrides.transactions ?? { kind: 'OK', data: TRANSACTIONS }}
      provider={overrides.provider ?? { kind: 'OK', data: PROVIDER }}
      query={overrides.query ?? {}}
      csrfToken="csrf-token-for-this-session"
      submissionId="sub_AAAAAAAAAAAAAAAAAAAA"
    />,
  );
}

describe('the balance', () => {
  it('shows the three balances', () => {
    const { getByText } = render_();
    expect(getByText(formatMoney(WALLET.availableBalanceMinor))).toBeInTheDocument();
  });

  it('answers a wallet the caller cannot see as a refusal, not an error', () => {
    const { getByText } = render_({ wallet: { kind: 'FORBIDDEN' } });
    expect(getByText('دسترسی ندارید')).toBeInTheDocument();
  });

  it('renders an outage with its correlation id', () => {
    const { getByText } = render_({
      wallet: { kind: 'UNAVAILABLE', status: 503, correlationId: 'COR_9' },
    });
    expect(getByText(/COR_9/)).toBeInTheDocument();
  });
});

describe('the top-up section', () => {
  it('shows the simulation disclosure and the form when the provider read succeeds', () => {
    const { getByText, container } = render_();
    expect(getByText(PROVIDER.notice)).toBeInTheDocument();
    expect(container.querySelector('[name="amountMinor"]')).toBeInTheDocument();
  });

  it('withholds the form rather than showing an amount field with no disclosure above it', () => {
    const { container, getByText } = render_({
      provider: { kind: 'UNAVAILABLE', status: 503, correlationId: 'COR_1' },
    });
    expect(container.querySelector('[name="amountMinor"]')).toBeNull();
    expect(getByText('افزایش موجودی اکنون در دسترس نیست')).toBeInTheDocument();
  });
});

describe('the whole screen: «حالت نمایشی» (Q-14)', () => {
  it('is drawn once, above the balances, while the provider is simulated', () => {
    const { getAllByText, queryByText } = render_();
    expect(getAllByText('حالت نمایشی')).toHaveLength(1);
    expect(queryByText('وضعیت درگاه پرداخت معلوم نیست')).toBeNull();
  });

  it('is absent once the provider is real', () => {
    const { queryByText, container } = render_({
      provider: {
        kind: 'OK',
        data: { ...PROVIDER, simulated: false, notice: 'Live payment provider.' },
      },
    });
    expect(queryByText('حالت نمایشی')).toBeNull();
    expect(queryByText('وضعیت درگاه پرداخت معلوم نیست')).toBeNull();
    expect(container.querySelector('[name="amountMinor"]')).toBeInTheDocument();
  });

  it.each([
    ['refused', { kind: 'FORBIDDEN' } as const],
    ['unavailable', { kind: 'UNAVAILABLE', status: 503, correlationId: 'COR_1' } as const],
    ['malformed', { kind: 'MALFORMED', correlationId: 'COR_2' } as const],
  ])(
    'says the provider is unknown when its read was %s — the history still shown, labelled',
    (_how, provider) => {
      // Even with the wallet itself unread: the history below is money too.
      const { getByText, queryByText } = render_({
        provider,
        wallet: { kind: 'UNAVAILABLE', status: 503, correlationId: 'COR_9' },
      });
      expect(getByText('وضعیت درگاه پرداخت معلوم نیست')).toBeInTheDocument();
      expect(queryByText('حالت نمایشی')).toBeNull();
      expect(getByText('تراکنش‌ها')).toBeInTheDocument();
    },
  );
});

describe('escrow holds', () => {
  it('lists a hold’s amount, status and reference', () => {
    const { getByText } = render_();
    expect(getByText('ORD_1')).toBeInTheDocument();
  });

  it('shows an empty history as empty, not as an error', () => {
    const { getByText } = render_({ holds: { kind: 'OK', data: { items: [] } } });
    expect(getByText('هیچ وجهی در وثیقه نیست')).toBeInTheDocument();
  });
});

describe('transaction history', () => {
  it('links each transaction to its own page, where its dispute is shown', () => {
    const { getAllByRole } = render_();
    const links = getAllByRole('link').filter((link) =>
      link.getAttribute('href')?.startsWith('/transactions/'),
    );
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      TRANSACTIONS.items.map((item) => `/transactions/${encodeURIComponent(item.id)}`),
    );
  });

  it('shows each transaction’s type, amount and status', () => {
    // Scoped to the row: the filter form's own <option> repeats the same
    // label text, so an unscoped match is ambiguous.
    const { getByRole } = render_();
    const row = getByRole('row', { name: /سفارش بازار/ });
    expect(row).toHaveTextContent('تسویه‌شده');
  });

  it('says something different when a filter matched nothing', () => {
    const empty = { kind: 'OK' as const, data: { items: [], nextCursor: null, hasMore: false } };

    const unfiltered = render_({ transactions: empty });
    expect(unfiltered.getByText('هیچ تراکنشی ثبت نشده')).toBeInTheDocument();

    const filtered = render_({ transactions: empty, query: { status: 'DISPUTED' } });
    expect(filtered.getByText('چیزی با این پالایش پیدا نشد')).toBeInTheDocument();
  });

  it('offers the next page only when there is one, carrying the filter', () => {
    const { queryByRole } = render_();
    expect(queryByRole('link', { name: 'صفحهٔ بعد' })).toBeNull();

    const { getByRole } = render_({
      transactions: { kind: 'OK', data: { ...TRANSACTIONS, hasMore: true, nextCursor: 'CUR_2' } },
      query: { status: 'SETTLED' },
    });
    expect(getByRole('link', { name: 'صفحهٔ بعد' })).toHaveAttribute(
      'href',
      '/wallet?status=SETTLED&cursor=CUR_2',
    );
  });

  it('filters through the URL, with no javascript', () => {
    const { getByRole } = render_();
    const form = getByRole('form', { name: 'پالایش تراکنش‌ها' });
    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/wallet');
  });
});

describe('accessibility', () => {
  it('has no violations with the wallet and the top-up form both rendered', async () => {
    const { container } = render_();
    expect(await axe(container)).toHaveNoViolations();
  });
});
