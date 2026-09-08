import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CatalogueView } from './catalogue-view';
import {
  expectNoAxeViolations,
  makeHarness,
  renderWithSession,
  respondError,
  respondJson,
} from '@/test/harness';

/**
 * The live vertical slice, first screen.
 *
 * Mounted against a real `ApiClient` over a mocked `fetch`. These are
 * **contract/UI tests**: they prove this application builds the right request
 * and renders every response correctly. They are not evidence that a running
 * backend answers this way — that would need the live stack, and nothing here
 * should be read as a substitute for it.
 */

const PRODUCT = {
  id: 'prd_01',
  sku: 'SKU-100',
  name: 'روغن موتور دیزل',
  description: 'بشکه ۲۰۸ لیتری',
  category: 'روان‌کار',
  kind: 'GOOD',
  unit: 'بشکه',
  status: 'ACTIVE',
  offers: [
    {
      id: 'ofr_01',
      productId: 'prd_01',
      supplierOrganizationId: 'org_supplier',
      unitPriceMinor: '128500000',
      currency: 'IRR',
      availableQuantity: 40,
      leadTimeDays: 5,
      minimumQuantity: 1,
      status: 'PUBLISHED',
      version: 1,
      supplierQualification: 'UNAVAILABLE',
    },
  ],
};

describe('catalogue search', () => {
  it('shows a skeleton before the first response arrives', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockReturnValue(new Promise(() => {}));

    renderWithSession(<CatalogueView />, session);

    expect(await screen.findByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('reaches the gateway with auth, tenant and correlation headers', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [PRODUCT] }));

    renderWithSession(<CatalogueView />, session);
    await screen.findByText('روغن موتور دیزل');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).origin).toBe('http://localhost:3000');
    expect(new URL(url).pathname).toBe('/v1/products');
    expect(new URL(url).searchParams.get('sort')).toBe('PRICE_ASC');

    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer token-test');
    expect(headers.get('x-organization-id')).toBe('org_one');
    expect(headers.get('x-correlation-id')).toBe('cid-test');
  });

  it('renders money as the exact string the service sent', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [PRODUCT] }));

    renderWithSession(<CatalogueView />, session);

    expect(await screen.findByText('۱۲۸٬۵۰۰٬۰۰۰ ریال')).toBeInTheDocument();
  });

  it('offers exactly the three sort values the service accepts', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [] }));

    renderWithSession(<CatalogueView />, session);
    await screen.findByText('کالایی با این مشخصات پیدا نشد');

    expect(screen.getAllByRole('radio')).toHaveLength(3);
    // ADR-042 § 2: sorting by supplier rating does not exist.
    expect(screen.queryByLabelText(/امتیاز/)).not.toBeInTheDocument();
  });

  it('shows an empty state rather than a blank page', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [] }));

    renderWithSession(<CatalogueView />, session);

    expect(await screen.findByText('کالایی با این مشخصات پیدا نشد')).toBeInTheDocument();
  });

  it('does not search on every keystroke', async () => {
    // `products` carries a 60/60s limit at the gateway; searching as you type
    // would spend it in seconds and answer 429 to correct usage.
    const user = userEvent.setup();
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [] }));

    renderWithSession(<CatalogueView />, session);
    await screen.findByText('کالایی با این مشخصات پیدا نشد');
    fetchMock.mockClear();

    await user.type(screen.getByLabelText('جست‌وجوی متنی'), 'روغن');
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'جست‌وجو' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(new URL((fetchMock.mock.calls[0] as [string])[0]).searchParams.get('q')).toBe('روغن');
  });

  it('has no accessibility violations', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [PRODUCT] }));

    const { container } = renderWithSession(<CatalogueView />, session);
    await screen.findByText('روغن موتور دیزل');

    await expectNoAxeViolations(container);
  });
});

describe('catalogue error states', () => {
  it.each([
    [401, 'UNAUTHENTICATED', /نشست شما معتبر نیست/],
    [404, 'NOT_FOUND', /یافت نشد/],
    [429, 'RATE_LIMIT_EXCEEDED', /حد مجاز/],
    [503, 'UPSTREAM_UNAVAILABLE', /در دسترس نیست/],
  ])('renders %s %s in Persian with the correlation id', async (status, code, pattern) => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondError(status, code));

    renderWithSession(<CatalogueView />, session);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(pattern);
    expect(alert).toHaveTextContent('cid-gateway');
    // The upstream English text never reaches the screen.
    expect(alert).not.toHaveTextContent('upstream english text');
  });

  it('renders 403 as a refusal, not as a fault', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondError(403, 'FORBIDDEN'));

    renderWithSession(<CatalogueView />, session);

    expect(await screen.findByText('این بخش برای نقش شما باز نیست')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports a malformed response rather than rendering it', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [{ id: 'prd_01', name: 42 }] }));

    renderWithSession(<CatalogueView />, session);

    expect(await screen.findByText('پاسخ سرویس با قرارداد هم‌خوان نبود')).toBeInTheDocument();
  });

  it('retries without losing the selected tenant', async () => {
    const user = userEvent.setup();
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementationOnce(respondError(503, 'UPSTREAM_UNAVAILABLE'));

    renderWithSession(<CatalogueView />, session);
    await screen.findByRole('alert');

    fetchMock.mockImplementation(respondJson({ items: [PRODUCT] }));
    await user.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    await screen.findByText('روغن موتور دیزل');

    const retry = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect((retry[1].headers as Headers).get('x-organization-id')).toBe('org_one');
  });

  it('offers no retry for a failure retrying cannot fix', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondError(404, 'NOT_FOUND'));

    renderWithSession(<CatalogueView />, session);
    await screen.findByRole('alert');

    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).not.toBeInTheDocument();
  });
});
