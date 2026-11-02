import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

import { MarketplaceScreen } from './MarketplaceScreen';
import { formatMoney } from '@/lib/format';
import type { ProductPage, ReadResult } from '@/server/marketplace';
import { TEST_CONTEXT } from '@/test/page-context';

/**
 * The marketplace search screen, in every state the service can put it in.
 * Mirrors `assets.spec.tsx`/`maintenance.spec.tsx`.
 */

const OFFER = {
  id: 'OFR_1',
  productId: 'PRD_1',
  supplierOrganizationId: 'ORG_9',
  unitPriceMinor: '300000',
  currency: 'IRR',
  availableQuantity: 15,
  leadTimeDays: 5,
  minimumQuantity: 1,
  supplierQualification: 'UNAVAILABLE',
};

const PRODUCT = {
  id: 'PRD_1',
  sku: 'SKU-1',
  name: 'شیلنگ هیدرولیک صنعتی',
  description: null,
  category: 'PARTS',
  kind: 'GOOD',
  unit: 'عدد',
  offers: [OFFER],
};

const page = (overrides: Partial<ProductPage> = {}): ReadResult<ProductPage> => ({
  kind: 'OK',
  data: { items: [PRODUCT], ...overrides },
});

describe('the marketplace search', () => {
  it('shows a row per product, linking to its compare page', () => {
    const { getByRole } = render(
      <MarketplaceScreen demoMode="REAL" result={page()} query={{ context: TEST_CONTEXT }} />,
    );
    expect(getByRole('link', { name: 'شیلنگ هیدرولیک صنعتی' })).toHaveAttribute(
      'href',
      '/marketplace/PRD_1',
    );
  });

  it('leads with the cheapest offer, without a second request', () => {
    const { getByText } = render(
      <MarketplaceScreen demoMode="REAL" result={page()} query={{ context: TEST_CONTEXT }} />,
    );
    expect(getByText(formatMoney(OFFER.unitPriceMinor))).toBeInTheDocument();
  });

  it('shows a dash rather than a price for a product with no offer', () => {
    const { getByRole } = render(
      <MarketplaceScreen
        demoMode="REAL"
        result={page({ items: [{ ...PRODUCT, offers: [] }] })}
        query={{ context: TEST_CONTEXT }}
      />,
    );
    const row = getByRole('row', { name: /شیلنگ هیدرولیک صنعتی/ });
    expect(row).toHaveTextContent('—');
  });

  it('translates the kind without translating the data', () => {
    const { getByRole } = render(
      <MarketplaceScreen demoMode="REAL" result={page()} query={{ context: TEST_CONTEXT }} />,
    );
    const row = getByRole('row', { name: /شیلنگ هیدرولیک صنعتی/ });
    expect(row).toHaveTextContent('کالا');
  });

  it('says something different when a search matched nothing', () => {
    const empty = page({ items: [] });

    const unfiltered = render(
      <MarketplaceScreen demoMode="REAL" result={empty} query={{ context: TEST_CONTEXT }} />,
    );
    expect(unfiltered.getByText('هنوز کالا یا خدمتی عرضه نشده')).toBeInTheDocument();

    const filtered = render(
      <MarketplaceScreen
        demoMode="REAL"
        result={empty}
        query={{ context: TEST_CONTEXT, q: 'nothing' }}
      />,
    );
    expect(filtered.getByText('چیزی با این جست‌وجو پیدا نشد')).toBeInTheDocument();
  });

  it('renders a refusal as a refusal and an outage as an outage', () => {
    const forbidden = render(
      <MarketplaceScreen
        demoMode="REAL"
        result={{ kind: 'FORBIDDEN' }}
        query={{ context: TEST_CONTEXT }}
      />,
    );
    expect(forbidden.getByText('دسترسی ندارید')).toBeInTheDocument();

    const down = render(
      <MarketplaceScreen
        demoMode="REAL"
        result={{ kind: 'UNAVAILABLE', status: 503, correlationId: 'COR_9' }}
        query={{ context: TEST_CONTEXT }}
      />,
    );
    expect(down.getByText(/COR_9/)).toBeInTheDocument();
  });

  it('searches through the URL, with no javascript', () => {
    const { getByRole } = render(
      <MarketplaceScreen demoMode="REAL" result={page()} query={{ context: TEST_CONTEXT }} />,
    );
    const form = getByRole('form', { name: 'جست‌وجوی کالا و خدمت' });
    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/marketplace');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <MarketplaceScreen demoMode="REAL" result={page()} query={{ context: TEST_CONTEXT }} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the marketplace search: «حالت نمایشی» (Q-14)', () => {
  it('is drawn when the provider is simulated', () => {
    const view = render(
      <MarketplaceScreen result={page()} query={{ context: TEST_CONTEXT }} demoMode="SIMULATED" />,
    );
    expect(view.getByText('حالت نمایشی')).toBeInTheDocument();
  });

  it('is absent when it is not', () => {
    const view = render(
      <MarketplaceScreen result={page()} query={{ context: TEST_CONTEXT }} demoMode="REAL" />,
    );
    expect(view.queryByText('حالت نمایشی')).toBeNull();
  });
});
