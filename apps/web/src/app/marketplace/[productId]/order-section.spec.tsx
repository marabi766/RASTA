import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

import type { Offer, OffersPage, Product, ReadResult } from '@/server/marketplace';

import { OffersScreen } from './OffersScreen';

/**
 * The order section of the offers screen: who it is shown to, which offers it
 * lets a person choose, and that it is absent when the page does not offer it.
 */

jest.mock('./place-order-actions', () => ({ submitPlaceOrder: jest.fn() }));

const OFFER = (id: string, supplier: string): Offer => ({
  id,
  productId: 'PRD_1',
  supplierOrganizationId: supplier,
  unitPriceMinor: '300000',
  currency: 'IRR',
  availableQuantity: 15,
  leadTimeDays: 5,
  minimumQuantity: 1,
  supplierQualification: 'UNAVAILABLE',
});

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

const ORDERING = {
  csrfToken: 'csrf-token-for-this-session',
  mintSubmissionId: () => 'sub_AAAAAAAAAAAAAAAAAAAA',
  organizationId: 'ORG-DEH-0001',
  binding: { owner: 'owner-tag', session: 'session-tag' },
  sessionMaxAgeSeconds: 3600,
};

function screen(
  offers: ReadResult<OffersPage>,
  ordering: typeof ORDERING | null = ORDERING,
  product: ReadResult<Product> = { kind: 'OK', data: PRODUCT },
) {
  return render(
    <OffersScreen
      product={product}
      offers={offers}
      productId="PRD_1"
      sort="PRICE_ASC"
      ordering={ordering ?? undefined}
    />,
  );
}

const page = (...items: Offer[]): ReadResult<OffersPage> => ({ kind: 'OK', data: { items } });

describe('the order section', () => {
  it('offers the form with the offers of other organizations', () => {
    const { getByRole, container } = screen(
      page(OFFER('OFR_1', 'ORG-DEH-0002'), OFFER('OFR_2', 'ORG-DEH-0003')),
    );
    expect(getByRole('form', { name: 'ثبت سفارش' })).toBeInTheDocument();
    // The blank entry and the two offers.
    expect(container.querySelectorAll('select[name="offerId"] option')).toHaveLength(3);
  });

  it('leaves out the caller’s own offers — a form built only to be refused is not offered', () => {
    const { container } = screen(
      page(OFFER('OFR_OWN', 'ORG-DEH-0001'), OFFER('OFR_2', 'ORG-DEH-0003')),
    );
    const values = [...container.querySelectorAll('select[name="offerId"] option')].map((option) =>
      option.getAttribute('value'),
    );
    expect(values).toEqual(['', 'OFR_2']);
  });

  it('says so, instead of showing an empty select, when every offer is the caller’s own', () => {
    const { getByText, queryByRole } = screen(page(OFFER('OFR_OWN', 'ORG-DEH-0001')));
    expect(getByText('پیشنهادی برای سفارش نیست')).toBeInTheDocument();
    expect(queryByRole('form', { name: 'ثبت سفارش' })).toBeNull();
  });

  it('is not rendered when the page does not offer ordering (no role, or only comparing)', () => {
    const { queryByRole, queryByText } = screen(page(OFFER('OFR_1', 'ORG-DEH-0002')), null);
    expect(queryByRole('form', { name: 'ثبت سفارش' })).toBeNull();
    expect(queryByText('سفارش از یکی از پیشنهادها')).toBeNull();
  });

  it('is not rendered when the offers could not be read, or the product is missing', () => {
    expect(
      screen({ kind: 'UNAVAILABLE', status: 503, correlationId: 'COR_9' }).queryByText(
        'سفارش از یکی از پیشنهادها',
      ),
    ).toBeNull();
    expect(
      screen(page(OFFER('OFR_1', 'ORG-DEH-0002')), ORDERING, { kind: 'NOT_FOUND' }).queryByText(
        'سفارش از یکی از پیشنهادها',
      ),
    ).toBeNull();
  });

  it('has no accessibility violations with the form', async () => {
    const { container } = screen(page(OFFER('OFR_1', 'ORG-DEH-0002')));
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no accessibility violations with the empty state', async () => {
    const { container } = screen(page(OFFER('OFR_OWN', 'ORG-DEH-0001')));
    expect(await axe(container)).toHaveNoViolations();
  });
});
