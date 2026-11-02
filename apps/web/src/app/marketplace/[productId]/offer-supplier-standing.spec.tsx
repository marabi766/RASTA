import { render } from '@testing-library/react';

import { OffersScreen } from './OffersScreen';
import type { Offer, Product } from '@/server/marketplace';
import type { SupplierSummary } from '@/server/suppliers';
import { TEST_CONTEXT } from '@/test/page-context';

/**
 * The supplier's name and qualification beside each offer (task 305): every
 * badge state, an unreadable directory as unknown, and never an id as a name.
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

const SUPPLIER: SupplierSummary = {
  id: 'SUP_1',
  organizationId: 'ORG_9',
  displayName: 'بازرگانی البرز',
  status: 'ACTIVE',
  capabilities: ['GOODS_SUPPLY'],
  qualifiedFor: ['GOODS_SUPPLY'],
  registeredAt: '2026-08-01T08:00:00.000Z',
};

function screen(suppliers?: ReadonlyMap<string, SupplierSummary>) {
  return render(
    <OffersScreen
      context={TEST_CONTEXT}
      product={{ kind: 'OK', data: PRODUCT }}
      offers={{ kind: 'OK', data: { items: [OFFER] } }}
      suppliers={suppliers}
      productId="PRD_1"
      demoMode="REAL"
    />,
  );
}

const withSupplier = (overrides: Partial<SupplierSummary>) =>
  new Map([['ORG_9', { ...SUPPLIER, ...overrides }]]);

describe('the supplier name and qualification beside an offer', () => {
  it.each([
    ['qualified', {}, 'واجد صلاحیت', 'APPROVED'],
    ['not qualified', { qualifiedFor: [] }, 'فاقد صلاحیت', 'REJECTED'],
    [
      'qualified only for another capability',
      { qualifiedFor: ['CONTRACTING'] },
      'فاقد صلاحیت',
      'REJECTED',
    ],
    ['suspended', { status: 'SUSPENDED', qualifiedFor: [] }, 'معلق', 'SUSPENDED'],
    ['suspended even if a stale approval is listed', { status: 'SUSPENDED' }, 'معلق', 'SUSPENDED'],
    ['a status the portal has no word for', { status: 'ARCHIVED' }, 'وضعیت نامشخص', 'PENDING'],
  ])('%s', (_case, overrides, label, badge) => {
    const { getByText, container } = screen(withSupplier(overrides));
    expect(getByText('بازرگانی البرز')).toBeInTheDocument();
    expect(getByText(label)).toBeInTheDocument();
    expect(container.querySelector(`[data-status="${badge}"]`)).not.toBeNull();
    // No raw enum code on screen.
    for (const code of ['ACTIVE', 'SUSPENDED', 'GOODS_SUPPLY', 'UNAVAILABLE', 'ARCHIVED']) {
      expect(container.textContent).not.toContain(code);
    }
  });

  it('reads as unknown, not qualified, when the directory read failed (no entry)', () => {
    const { getByText, queryByText } = screen(new Map());
    expect(getByText('وضعیت نامشخص')).toBeInTheDocument();
    expect(getByText('نام تأمین‌کننده در دسترس نیست')).toBeInTheDocument();
    expect(queryByText('واجد صلاحیت')).toBeNull();
  });

  it('reads as unknown when the screen was given no directory at all', () => {
    const { getByText } = screen(undefined);
    expect(getByText('وضعیت نامشخص')).toBeInTheDocument();
  });

  it('ignores an entry that belongs to another organization', () => {
    const { getByText, queryByText } = screen(
      new Map([['ORG_9', { ...SUPPLIER, organizationId: 'ORG_OTHER' }]]),
    );
    expect(getByText('وضعیت نامشخص')).toBeInTheDocument();
    expect(queryByText('بازرگانی البرز')).toBeNull();
  });

  it.each(['ORG_9', 'SUP_1', '   '])('never shows %j as the supplier’s name', (displayName) => {
    const { getByText, getAllByText } = screen(withSupplier({ displayName }));
    expect(getByText('نام تأمین‌کننده در دسترس نیست')).toBeInTheDocument();
    // The id is still there as an identifier, but only once and not in the name line.
    expect(getAllByText('ORG_9')).toHaveLength(1);
  });
});
