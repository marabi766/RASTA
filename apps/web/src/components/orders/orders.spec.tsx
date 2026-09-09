import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrderDetailView } from './order-detail-view';
import { OrdersView } from './orders-view';
import { ORDER_TRANSITIONS } from '@/lib/api/adapters/marketplace';
import {
  expectNoAxeViolations,
  makeHarness,
  renderRoute,
  renderWithSession,
  respondJson,
} from '@/test/harness';

/**
 * Orders.
 *
 * The detail screen's job is to make an *absence* visible: two edges that do
 * not exist in the state machine are the whole financial safety model, and an
 * absence is precisely what a hand-drawn diagram cannot show. These tests hold
 * the stepper to the real transition table.
 */

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord_1',
    status: 'FUNDS_HELD',
    buyerOrganizationId: 'org_one',
    supplierOrganizationId: 'org_supplier',
    totalAmountMinor: '304000000',
    currency: 'IRR',
    lines: [
      {
        offerId: 'ofr_1',
        productId: 'prd_1',
        productName: 'روغن موتور دیزل',
        quantity: 2,
        unitPriceMinor: '152000000',
        lineTotalMinor: '304000000',
        currency: 'IRR',
        offerVersion: 3,
      },
    ],
    economicTransactionId: 'txn_1',
    economicSettlementId: null,
    supplierQualification: 'UNAVAILABLE',
    reminderCount: 0,
    lastReminderAt: null,
    confirmedAt: null,
    fulfilledAt: null,
    receiptConfirmedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    failureReason: null,
    createdAt: '2026-02-01T00:00:00.000Z',
    placedBy: 'usr_1',
    ...overrides,
  };
}

describe('order list', () => {
  it('sends the side explicitly rather than inferring it', async () => {
    const user = userEvent.setup();
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [order()], nextCursor: null }));

    renderWithSession(<OrdersView />, session);
    await screen.findByRole('table');

    expect(new URL((fetchMock.mock.calls[0] as [string])[0]).searchParams.get('role')).toBe(
      'BUYER',
    );

    await user.click(screen.getByRole('radio', { name: /فروشندهٔ آن‌ایم/ }));
    await screen.findByRole('table');

    // An organization can be both. Guessing which list was meant returns the
    // wrong one silently, so the choice is a control rather than a heuristic.
    expect(new URL((fetchMock.mock.calls.at(-1) as [string])[0]).searchParams.get('role')).toBe(
      'SUPPLIER',
    );
  });

  it('offers no button that would place or change an order', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [order()], nextCursor: null }));

    renderWithSession(<OrdersView />, session);
    await screen.findByRole('table');

    expect(
      screen.queryByRole('button', { name: /ثبت سفارش|تأیید|لغو|تحویل/ }),
    ).not.toBeInTheDocument();
  });
});

describe('order lifecycle', () => {
  it('renders the outgoing edges of the real transition table', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute({ '/v1/orders/ord_1': order() }));

    renderWithSession(<OrderDetailView orderId="ord_1" />, session);
    await screen.findByText('از اینجا کجا می‌توان رفت');

    // Scoped to the transition list itself. The same enum names appear in the
    // stepper above and in the footnote below, so an unscoped query would pass
    // even if this list rendered nothing at all.
    const transitions = within(screen.getByRole('list', { name: 'گذارهای مجاز از وضعیت فعلی' }));
    for (const next of ORDER_TRANSITIONS.FUNDS_HELD) {
      expect(transitions.getByText(next)).toBeInTheDocument();
    }
  });

  it('shows that a disputed order has no path to settlement', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(
      renderRoute({ '/v1/orders/ord_1': order({ status: 'DISPUTED' }) }),
    );

    renderWithSession(<OrderDetailView orderId="ord_1" />, session);
    await screen.findByText('از اینجا کجا می‌توان رفت');

    // The missing edge is the safety model. Asserted against the table itself
    // as well as the rendering, so a copied-out diagram cannot drift from it.
    expect(ORDER_TRANSITIONS.DISPUTED).not.toContain('SETTLING');

    const transitions = within(screen.getByRole('list', { name: 'گذارهای مجاز از وضعیت فعلی' }));
    expect(transitions.queryByText('SETTLING')).not.toBeInTheDocument();
  });

  it('says plainly that a finished order has no outgoing edge', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(
      renderRoute({
        '/v1/orders/ord_1': order({ status: 'COMPLETED', completedAt: '2026-03-01T00:00:00.000Z' }),
      }),
    );

    renderWithSession(<OrderDetailView orderId="ord_1" />, session);

    expect(await screen.findByText(/این یک وضعیت پایانی است/)).toBeInTheDocument();
    expect(ORDER_TRANSITIONS.COMPLETED).toHaveLength(0);
  });

  it('reports supplier qualification as unchecked', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute({ '/v1/orders/ord_1': order() }));

    renderWithSession(<OrderDetailView orderId="ord_1" />, session);
    await screen.findByText('طرفین و ارجاع‌های مالی');

    expect(screen.getByText('UNAVAILABLE')).toBeInTheDocument();
    expect(screen.getByText('بررسی نشده')).toBeInTheDocument();
  });

  it('records the offer version each line was priced at', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute({ '/v1/orders/ord_1': order() }));

    renderWithSession(<OrderDetailView orderId="ord_1" />, session);
    await screen.findByText('روغن موتور دیزل');

    // A supplier cannot reprice work already sold; the version is the record
    // of which price was agreed.
    expect(screen.getByText('۳')).toBeInTheDocument();
  });

  it('states that an expiry moves nothing', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute({ '/v1/orders/ord_1': order({ reminderCount: 2 }) }));

    renderWithSession(<OrderDetailView orderId="ord_1" />, session);

    expect(await screen.findByText(/نه تأیید خودکار، نه لغو خودکار/)).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(renderRoute({ '/v1/orders/ord_1': order() }));

    const { container } = renderWithSession(<OrderDetailView orderId="ord_1" />, session);
    await screen.findByText('روغن موتور دیزل');

    await expectNoAxeViolations(container);
  });
});
