import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FIXTURE_ENTRY_POINTS } from '@/lib/demo/entry-points';
import { getScenarioStore, resetScenarioStoreSingletonForTests } from '@/lib/demo/scenario/store';
import { expectNoAxeViolations, makeHarness, renderWithSession, settle } from '@/test/harness';
import { OfferScenarioGate } from './offer-scenario-gate';

function approveEstimate(): void {
  getScenarioStore().dispatch({
    type: 'MAINTENANCE_REQUEST_CREATED',
    maintenanceRequestId: FIXTURE_ENTRY_POINTS.maintenanceRequestId,
    assetId: FIXTURE_ENTRY_POINTS.assetId,
    organizationId: FIXTURE_ENTRY_POINTS.organizationId,
    title: 'x',
  });
  getScenarioStore().dispatch({
    type: 'MAINTENANCE_ESTIMATE_APPROVED',
    maintenanceRequestId: FIXTURE_ENTRY_POINTS.maintenanceRequestId,
    estimateAmountMinor: '1',
  });
}

describe('OfferScenarioGate', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetScenarioStoreSingletonForTests();
  });

  it('renders nothing in live mode', async () => {
    const { session } = makeHarness({ dataMode: 'live' });
    const { container } = renderWithSession(
      <OfferScenarioGate productId={FIXTURE_ENTRY_POINTS.productId} />,
      session,
    );
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a product other than the scenario canonical one', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    const { container } = renderWithSession(<OfferScenarioGate productId="prd_other" />, session);
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('locks offer selection until the estimate is approved, and order placement until an offer is selected', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(<OfferScenarioGate productId={FIXTURE_ENTRY_POINTS.productId} />, session);

    expect(await screen.findByRole('button', { name: 'انتخاب این پیشنهاد' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ثبت سفارش' })).toBeDisabled();
    expect(
      screen.getByText('ابتدا برآورد هزینهٔ درخواست تعمیر باید تأیید شود.'),
    ).toBeInTheDocument();
    expect(screen.getByText('ابتدا یک پیشنهاد تأمین‌کننده انتخاب کنید.')).toBeInTheDocument();
  });

  it('selects the offer, then places the order, each unlocking the next', async () => {
    approveEstimate();

    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(<OfferScenarioGate productId={FIXTURE_ENTRY_POINTS.productId} />, session);

    const selectOffer = await screen.findByRole('button', { name: 'انتخاب این پیشنهاد' });
    expect(selectOffer).not.toBeDisabled();
    const placeOrder = screen.getByRole('button', { name: 'ثبت سفارش' });
    expect(placeOrder).toBeDisabled();

    await userEvent.click(selectOffer);
    expect(await screen.findByText('پیشنهاد انتخاب شد')).toBeInTheDocument();

    const placeOrderNowEnabled = screen.getByRole('button', { name: 'ثبت سفارش' });
    expect(placeOrderNowEnabled).not.toBeDisabled();
    await userEvent.click(placeOrderNowEnabled);

    expect(await screen.findByText('سفارش ثبت شد')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /گام بعدی/ });
    expect(link).toHaveAttribute('href', `/orders/${FIXTURE_ENTRY_POINTS.orderId}`);
  });

  it('has no accessibility violations across the locked, partially-unlocked and completed phases', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    const { container } = renderWithSession(
      <OfferScenarioGate productId={FIXTURE_ENTRY_POINTS.productId} />,
      session,
    );

    await screen.findByRole('button', { name: 'انتخاب این پیشنهاد' });
    await expectNoAxeViolations(container);

    approveEstimate();
    const selectOffer = await screen.findByRole('button', { name: 'انتخاب این پیشنهاد' });
    await userEvent.click(selectOffer);
    await screen.findByText('پیشنهاد انتخاب شد');
    await expectNoAxeViolations(container);

    await userEvent.click(screen.getByRole('button', { name: 'ثبت سفارش' }));
    await screen.findByText('سفارش ثبت شد');
    await expectNoAxeViolations(container);
  });
});
