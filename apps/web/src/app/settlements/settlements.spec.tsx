import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import { PORTAL_NAV } from '@/app/nav';
import { navForRoles } from '@/app/portal-nav';
import { SETTLEMENT_SIMULATION_NOTICE } from '@/lib/settlement-fields';
import type { ReadResult, Settlement, SettlementPage } from '@/server/settlements';

import { SettlementDetailScreen } from './SettlementDetailScreen';
import { SettlementsScreen } from './SettlementsScreen';

/**
 * What `/settlements` renders: every read outcome, the two sides, paging, money
 * past 2^53 shown without losing a digit, and the rule that no copy claims a
 * bank connection.
 */

jest.mock('@/server/identity', () => ({ fetchCurrentUser: jest.fn() }));

const SETTLEMENT: Settlement = {
  id: 'SET_1',
  transactionId: 'TX_1',
  journalId: 'JRN_1',
  payerOrganizationId: 'ORG_A',
  payeeOrganizationId: 'ORG_B',
  grossAmountMinor: '90071992547409931234',
  commissionAmountMinor: '100',
  netAmountMinor: '90071992547409931134',
  currency: 'IRR',
  settledAt: '2026-09-20T08:00:00.000Z',
};

const ok = (items: Settlement[], nextCursor: string | null = null): ReadResult<SettlementPage> => ({
  kind: 'OK',
  data: { items, nextCursor },
});

describe('the list', () => {
  it('names the other party: the payee on the paid side, the payer on the received side', () => {
    const { unmount } = render(
      <SettlementsScreen result={ok([SETTLEMENT])} query={{ view: 'PAID' }} />,
    );
    expect(screen.getByText('ORG_B')).toBeInTheDocument();
    expect(screen.queryByText('ORG_A')).toBeNull();
    unmount();

    render(<SettlementsScreen result={ok([SETTLEMENT])} query={{ view: 'RECEIVED' }} />);
    expect(screen.getByText('ORG_A')).toBeInTheDocument();
    expect(screen.queryByText('ORG_B')).toBeNull();
  });

  it('shows a net amount past 2^53 digit for digit, in Persian digits', () => {
    const { container } = render(
      <SettlementsScreen result={ok([SETTLEMENT])} query={{ view: 'PAID' }} />,
    );
    expect(container.textContent).toContain('۹۰٬۰۷۱٬۹۹۲٬۵۴۷٬۴۰۹٬۹۳۱٬۱۳۴');
  });

  it('says it is simulated and never claims a bank', () => {
    const { container } = render(
      <SettlementsScreen result={ok([SETTLEMENT])} query={{ view: 'PAID' }} />,
    );
    expect(screen.getByText(SETTLEMENT_SIMULATION_NOTICE)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/پرداخت بانکی|واریز شد/);
  });

  it('links the next page only when the read produced a cursor, keeping the side', () => {
    const { unmount } = render(
      <SettlementsScreen result={ok([SETTLEMENT], 'SET_1')} query={{ view: 'RECEIVED' }} />,
    );
    expect(screen.getByRole('link', { name: 'صفحهٔ بعد' })).toHaveAttribute(
      'href',
      '/settlements?view=RECEIVED&cursor=SET_1',
    );
    unmount();

    render(<SettlementsScreen result={ok([SETTLEMENT])} query={{ view: 'PAID' }} />);
    expect(screen.queryByRole('link', { name: 'صفحهٔ بعد' })).toBeNull();
  });

  it('renders an empty state per side', () => {
    const { unmount } = render(<SettlementsScreen result={ok([])} query={{ view: 'PAID' }} />);
    expect(screen.getByText('این سازمان هنوز تسویه‌ای پرداخت نکرده است.')).toBeInTheDocument();
    unmount();
    render(<SettlementsScreen result={ok([])} query={{ view: 'RECEIVED' }} />);
    expect(screen.getByText('هنوز تسویه‌ای به نفع این سازمان انجام نشده است.')).toBeInTheDocument();
  });

  it('renders refusal and outage as outcomes', () => {
    const { unmount } = render(
      <SettlementsScreen result={{ kind: 'FORBIDDEN' }} query={{ view: 'PAID' }} />,
    );
    expect(screen.getByText('فهرست تسویه‌های این سازمان در اختیار شما نیست.')).toBeInTheDocument();
    unmount();
    render(
      <SettlementsScreen
        result={{ kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-1' }}
        query={{ view: 'PAID' }}
      />,
    );
    expect(
      screen.getByText('فهرست تسویه‌ها خوانده نشد. کمی بعد دوباره تلاش کنید.'),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <SettlementsScreen result={ok([SETTLEMENT], 'SET_1')} query={{ view: 'PAID' }} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the detail', () => {
  it('shows the three amounts and both parties', () => {
    const { container } = render(
      <SettlementDetailScreen result={{ kind: 'OK', data: SETTLEMENT }} />,
    );
    expect(screen.getByText('ORG_A')).toBeInTheDocument();
    expect(screen.getByText('ORG_B')).toBeInTheDocument();
    expect(container.textContent).toContain('۹۰٬۰۷۱٬۹۹۲٬۵۴۷٬۴۰۹٬۹۳۱٬۲۳۴');
    expect(screen.getByText(SETTLEMENT_SIMULATION_NOTICE)).toBeInTheDocument();
  });

  it('renders a not-found settlement without hinting that it exists', () => {
    const { container } = render(<SettlementDetailScreen result={{ kind: 'NOT_FOUND' }} />);
    expect(screen.getByText('تسویه‌ای یافت نشد')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/دسترسی|ممنوع/);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <SettlementDetailScreen result={{ kind: 'OK', data: SETTLEMENT }} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the navigation entry', () => {
  const hrefs = (roles: readonly string[] | null) => navForRoles(roles).map((i) => i.href);

  it.each(['SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN'])('is offered to %s', (role) => {
    expect(hrefs([role])).toContain('/settlements');
  });

  it('is not offered to other roles, or when roles are unknown', () => {
    expect(hrefs(['OPERATOR'])).not.toContain('/settlements');
    expect(hrefs([])).not.toContain('/settlements');
    expect(hrefs(null)).toEqual(PORTAL_NAV.map((i) => i.href));
  });

  it.each([
    [['AUDITOR'], false],
    [['AUDITOR', 'ORGANIZATION_ADMIN'], false],
    [['ORGANIZATION_ADMIN', 'AUDITOR'], false],
    [['AUDITOR', 'SYSTEM_ADMIN'], false],
    [['AUDITOR', 'UNION_ADMIN', 'OPERATOR'], false],
    [['OPERATOR', 'ORGANIZATION_ADMIN'], true],
    [['UNION_ADMIN', 'SYSTEM_ADMIN'], true],
    [['OPERATOR', 'DRIVER'], false],
  ])(
    'for roles %j offers it: %s (AUDITOR is refused by the service, even with an admin role)',
    (roles, offered) => {
      expect(hrefs(roles).includes('/settlements')).toBe(offered);
    },
  );

  it('sits after the wallet and leaves the rest in order', () => {
    const list = hrefs(['ORGANIZATION_ADMIN']);
    expect(list.indexOf('/settlements')).toBe(list.indexOf('/wallet') + 1);
    expect(list.filter((h) => h !== '/settlements')).toEqual(PORTAL_NAV.map((i) => i.href));
  });
});
