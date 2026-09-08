import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OffersView } from './offers-view';
import {
  expectNoAxeViolations,
  makeHarness,
  renderWithSession,
  respondError,
  respondJson,
} from '@/test/harness';

/**
 * Offer comparison — the second half of the live slice.
 *
 * Contract/UI tests over a mocked `fetch`. Not live-backend evidence.
 */

const OFFER = {
  id: 'ofr_01',
  productId: 'prd_01',
  supplierOrganizationId: 'org_supplier_a',
  // Past Number.MAX_SAFE_INTEGER on purpose: this is the value that would come
  // back wrong if anything on the path parsed it as a number (ADR-022).
  unitPriceMinor: '9007199254740993',
  currency: 'IRR',
  availableQuantity: 12,
  leadTimeDays: 7,
  minimumQuantity: 2,
  status: 'PUBLISHED',
  version: 3,
  supplierQualification: 'UNAVAILABLE',
};

describe('offer comparison', () => {
  it('calls the product offers route through the gateway', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [OFFER] }));

    renderWithSession(<OffersView productId="prd_01" />, session);
    await screen.findByRole('table');

    const url = new URL((fetchMock.mock.calls[0] as [string])[0]);
    expect(url.origin).toBe('http://localhost:3000');
    expect(url.pathname).toBe('/v1/products/prd_01/offers');
    expect(url.searchParams.get('sort')).toBe('PRICE_ASC');
  });

  it('renders a price beyond safe-integer range exactly', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [OFFER] }));

    renderWithSession(<OffersView productId="prd_01" />, session);

    expect(await screen.findByText('۹٬۰۰۷٬۱۹۹٬۲۵۴٬۷۴۰٬۹۹۳ ریال')).toBeInTheDocument();
  });

  it('reports supplier qualification as unchecked, never as failed', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [OFFER] }));

    renderWithSession(<OffersView productId="prd_01" />, session);
    await screen.findByRole('table');

    // ADR-041 § 1: `UNAVAILABLE` means nobody checked, not that the supplier
    // failed a check. The UI must not render a verdict.
    // Once in the row badge, once in the footnote that explains it.
    expect(screen.getAllByText('UNAVAILABLE')).toHaveLength(2);
    expect(screen.getByText('بررسی نشده')).toBeInTheDocument();

    // Scoped to the data rows: the footnote below the table legitimately uses
    // the word «رد شده» to say that is exactly what `UNAVAILABLE` does *not*
    // mean. What must never appear is a verdict on an actual supplier.
    const rows = screen.getAllByRole('row').slice(1);
    for (const row of rows) {
      expect(row.textContent).not.toMatch(/تأییدشده|رد شده|امتیاز|ستاره/);
    }
  });

  it('labels the declared quantity as a declaration, not warehouse stock', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [OFFER] }));

    renderWithSession(<OffersView productId="prd_01" />, session);
    await screen.findByRole('table');

    expect(screen.getByText('عدد اعلامی، نه موجودی انبار')).toBeInTheDocument();
    expect(screen.getByText(/سرویس انبار ساخته نشده/)).toBeInTheDocument();
  });

  it('re-reads with the chosen sort', async () => {
    const user = userEvent.setup();
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [OFFER] }));

    renderWithSession(<OffersView productId="prd_01" />, session);
    await screen.findByRole('table');

    await user.click(screen.getByRole('radio', { name: 'سریع‌ترین تحویل اعلامی' }));

    await screen.findByRole('table');
    const last = new URL((fetchMock.mock.calls.at(-1) as [string])[0]);
    expect(last.searchParams.get('sort')).toBe('LEAD_TIME_ASC');
  });

  it('shows an empty state when no offer is published', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [] }));

    renderWithSession(<OffersView productId="prd_01" />, session);

    expect(await screen.findByText('پیشنهاد منتشرشده‌ای برای این کالا نیست')).toBeInTheDocument();
  });

  it('offers the payment-provider disclosure as the honest next step', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [OFFER] }));

    renderWithSession(<OffersView productId="prd_01" />, session);
    await screen.findByRole('table');

    const link = screen.getByRole('link', { name: 'مشاهدهٔ افشای ارائه‌دهندهٔ پرداخت' });
    expect(link).toHaveAttribute('href', '/wallet');
    // The cart prefix is routed but has no handler (ADR-037 § 3). No button
    // may suggest otherwise.
    expect(screen.queryByRole('button', { name: /سبد|خرید|ثبت سفارش/ })).not.toBeInTheDocument();
  });

  it.each([
    [401, 'UNAUTHENTICATED'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [422, 'BUSINESS_RULE_VIOLATION'],
    [429, 'RATE_LIMIT_EXCEEDED'],
    [503, 'UPSTREAM_UNAVAILABLE'],
  ])('renders %s %s without leaking the upstream message', async (status, code) => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondError(status, code));

    renderWithSession(<OffersView productId="prd_01" />, session);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('cid-gateway');
    expect(alert).not.toHaveTextContent('upstream english text');
  });

  it('renders a cross-tenant refusal as a tenant problem, not a fault', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondError(403, 'TENANT_MISMATCH'));

    renderWithSession(<OffersView productId="prd_01" />, session);

    expect(await screen.findByText('سازمان فعال با این داده هم‌خوان نیست')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [OFFER] }));

    const { container } = renderWithSession(<OffersView productId="prd_01" />, session);
    await screen.findByRole('table');

    await expectNoAxeViolations(container);
  });
});
