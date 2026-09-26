import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

import { OffersScreen } from './OffersScreen';
import { formatMoney } from '@/lib/format';
import type { Offer, OffersPage, Product, ReadResult } from '@/server/marketplace';

/**
 * The offer-comparison screen, in every state the two independent reads it
 * composes can put it in. Mirrors `DossierScreen`'s own spec: a product read
 * and an offers read are unrelated, so each of their states is exercised on
 * its own rather than assumed to succeed together.
 */

const OFFER: Offer = {
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

const PRODUCT: Product = {
  id: 'PRD_1',
  sku: 'SKU-1',
  name: 'شیلنگ هیدرولیک صنعتی',
  description: null,
  category: 'PARTS',
  kind: 'GOOD',
  unit: 'عدد',
  offers: [],
};

function render_(
  product: ReadResult<Product> = { kind: 'OK', data: PRODUCT },
  offers: ReadResult<OffersPage> = { kind: 'OK', data: { items: [OFFER] } },
) {
  return render(
    <OffersScreen product={product} offers={offers} productId="PRD_1" sort="PRICE_ASC" />,
  );
}

describe('the product header', () => {
  it('shows the product’s own name and unit', () => {
    const { getByText } = render_();
    expect(getByText('شیلنگ هیدرولیک صنعتی')).toBeInTheDocument();
    expect(getByText(/عدد/)).toBeInTheDocument();
  });

  it('answers a missing product the same way it answers somebody else’s', () => {
    const { getByText } = render_({ kind: 'NOT_FOUND' });
    expect(getByText('این کالا یا خدمت پیدا نشد')).toBeInTheDocument();
  });

  it('renders a refusal as a refusal and an outage as an outage', () => {
    const forbidden = render_({ kind: 'FORBIDDEN' });
    expect(forbidden.getByText('دسترسی ندارید')).toBeInTheDocument();

    const down = render_({ kind: 'UNAVAILABLE', status: 503, correlationId: 'COR_9' });
    expect(down.getByText(/COR_9/)).toBeInTheDocument();
  });
});

describe('the offers table', () => {
  it('lists a supplier’s price, quantity and lead time', () => {
    const { getByText } = render_();
    expect(getByText(formatMoney(OFFER.unitPriceMinor))).toBeInTheDocument();
    expect(getByText('ORG_9')).toBeInTheDocument();
  });

  it('writes quantities and lead time in Persian digits (L5-09)', () => {
    // The offer arrived as 15, 1 and 5 — Latin, as the API sends every number.
    const { getByText } = render_();
    expect(getByText('۱۵')).toBeInTheDocument();
    expect(getByText('۱')).toBeInTheDocument();
    expect(getByText('۵ روز')).toBeInTheDocument();
  });

  it('never renders the qualification as a check nobody performed', () => {
    const { getByText, queryByText } = render_();
    expect(getByText('هنوز فعال نیست')).toBeInTheDocument();
    expect(queryByText('تأییدشده')).toBeNull();
  });

  it('shows an empty offer list as empty, not as an error', () => {
    const { getByText } = render_(
      { kind: 'OK', data: PRODUCT },
      { kind: 'OK', data: { items: [] } },
    );
    expect(getByText('هیچ پیشنهادی منتشر نشده')).toBeInTheDocument();
  });

  it('does not render the offers section at all when the product itself was not found', () => {
    const { queryByRole } = render_({ kind: 'NOT_FOUND' });
    expect(queryByRole('form', { name: 'ترتیب پیشنهادها' })).toBeNull();
  });

  it('offers the sort control through the URL, with no javascript', () => {
    const { getByRole } = render_();
    const form = getByRole('form', { name: 'ترتیب پیشنهادها' });
    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/marketplace/PRD_1');
  });

  it('has no accessibility violations', async () => {
    const { container } = render_();
    expect(await axe(container)).toHaveNoViolations();
  });
});
