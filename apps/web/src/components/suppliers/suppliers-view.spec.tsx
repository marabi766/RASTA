import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SuppliersView } from './suppliers-view';
import { expectNoAxeViolations, makeHarness, renderWithSession, respondJson } from '@/test/harness';

/**
 * The supplier directory — Phase 1.
 *
 * The absences are the assertions. There is no score, no star rating and no
 * rating sort, because no scoring engine exists (Q-12, COM-005 still
 * `IN_PROGRESS`) — and a demo screen is exactly where a plausible-looking star
 * would appear if nobody were watching.
 */

const SUPPLIER = {
  id: 'sup_1',
  organizationId: 'org_supplier',
  displayName: 'تعمیرگاه مرکزی یزد',
  status: 'ACTIVE',
  capabilities: ['WORKSHOP_SERVICE', 'GOODS_SUPPLY'],
  qualifiedFor: ['WORKSHOP_SERVICE'],
  registeredAt: '2026-01-01T00:00:00.000Z',
};

const page = (items: unknown[]) => ({ items, nextCursor: null, hasMore: false });

describe('claimed versus qualified', () => {
  it('shows the two as separate columns', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(page([SUPPLIER])));

    renderWithSession(<SuppliersView />, session);
    await screen.findByRole('table');

    const row = screen.getByRole('row', { name: /تعمیرگاه مرکزی یزد/ });
    // Claimed: both. Qualified: only the one with a current approval.
    expect(row).toHaveTextContent('تأمین کالا');
    expect(row).toHaveTextContent('خدمات تعمیرگاهی');
  });

  it('says "no approval recorded" rather than "rejected"', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(page([{ ...SUPPLIER, qualifiedFor: [] }])));

    renderWithSession(<SuppliersView />, session);
    await screen.findByRole('table');

    expect(screen.getByText('تأییدی ثبت نشده')).toBeInTheDocument();
    expect(screen.queryByText(/رد شد/)).not.toBeInTheDocument();
  });

  it('states the limits of what an approval asserts', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(page([SUPPLIER])));

    renderWithSession(<SuppliersView />, session);
    await screen.findByRole('table');

    // The service does not read documents; showing more than this would turn
    // an administrative record into a professional endorsement.
    expect(screen.getByText(/سرویس تأمین‌کننده اصلاً سند نمی‌خواند/)).toBeInTheDocument();
  });
});

describe('what does not exist', () => {
  it('shows no score, no stars and no rating sort', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(page([SUPPLIER])));

    const { container } = renderWithSession(<SuppliersView />, session);
    await screen.findByRole('table');

    expect(container.textContent).not.toMatch(/امتیاز عملکرد تأمین‌کننده:/);
    expect(container.textContent).not.toMatch(/★|⭐/);
    expect(
      screen.queryByRole('button', { name: /مرتب‌سازی بر اساس امتیاز/ }),
    ).not.toBeInTheDocument();
  });

  it('declares the domain incomplete rather than presenting it as finished', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(page([SUPPLIER])));

    renderWithSession(<SuppliersView />, session);

    expect(await screen.findByText('این دامنه ناقص است و کامل اعلام نمی‌شود.')).toBeInTheDocument();
    expect(screen.getAllByText('BETA').length).toBeGreaterThan(0);
    expect(screen.getByText(/COM-005/)).toBeInTheDocument();
  });
});

describe('filters', () => {
  it('drops the status filter when asking for currently qualified suppliers', async () => {
    const user = userEvent.setup();
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(page([SUPPLIER])));

    renderWithSession(<SuppliersView />, session);
    await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'خدمات تعمیرگاهی' }));
    await user.click(screen.getByRole('checkbox'));

    const last = new URL((fetchMock.mock.calls.at(-1) as [string])[0]);
    // `qualifiedFor` already implies ACTIVE; sending both is a contradiction
    // the service answers 400 to.
    expect(last.searchParams.get('qualifiedFor')).toBe('WORKSHOP_SERVICE');
    expect(last.searchParams.has('status')).toBe(false);
  });

  it('has no accessibility violations', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(page([SUPPLIER])));

    const { container } = renderWithSession(<SuppliersView />, session);
    await screen.findByRole('table');

    await expectNoAxeViolations(container);
  });
});
