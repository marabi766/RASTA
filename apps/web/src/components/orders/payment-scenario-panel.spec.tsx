import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FIXTURE_ENTRY_POINTS } from '@/lib/demo/entry-points';
import { getScenarioStore, resetScenarioStoreSingletonForTests } from '@/lib/demo/scenario/store';
import { expectNoAxeViolations, makeHarness, renderWithSession, settle } from '@/test/harness';
import { PaymentScenarioGate } from './payment-scenario-gate';

function placeOrder(): void {
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
  getScenarioStore().dispatch({
    type: 'SUPPLIER_OFFER_SELECTED',
    maintenanceRequestId: FIXTURE_ENTRY_POINTS.maintenanceRequestId,
    supplierOrganizationId: FIXTURE_ENTRY_POINTS.supplierOrganizationId,
    offerId: FIXTURE_ENTRY_POINTS.offerId,
    unitPriceMinor: '284000000',
  });
  getScenarioStore().dispatch({
    type: 'ORDER_PLACED',
    orderId: FIXTURE_ENTRY_POINTS.orderId,
    offerId: FIXTURE_ENTRY_POINTS.offerId,
    totalAmountMinor: '284000000',
  });
}

describe('PaymentScenarioGate', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetScenarioStoreSingletonForTests();
  });

  it('renders nothing in live mode', async () => {
    const { session } = makeHarness({ dataMode: 'live' });
    const { container } = renderWithSession(
      <PaymentScenarioGate orderId={FIXTURE_ENTRY_POINTS.orderId} />,
      session,
    );
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an order other than the scenario canonical one', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    const { container } = renderWithSession(<PaymentScenarioGate orderId="ord_other" />, session);
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('is locked until the order is placed', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(<PaymentScenarioGate orderId={FIXTURE_ENTRY_POINTS.orderId} />, session);

    const button = await screen.findByRole('button', { name: 'ثبت پرداخت شبیه‌سازی‌شده' });
    expect(button).toBeDisabled();
    expect(screen.getByText('ابتدا باید سفارش از صفحهٔ کالا ثبت شود.')).toBeInTheDocument();
  });

  it('captures the payment, calls onApplied exactly once, and reveals the next-step link', async () => {
    placeOrder();
    const onApplied = jest.fn();
    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(
      <PaymentScenarioGate orderId={FIXTURE_ENTRY_POINTS.orderId} onApplied={onApplied} />,
      session,
    );

    const button = await screen.findByRole('button', { name: 'ثبت پرداخت شبیه‌سازی‌شده' });
    expect(button).not.toBeDisabled();
    await userEvent.click(button);

    expect(await screen.findByText('پرداخت نهایی شد')).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: /گام بعدی/ })).toHaveAttribute('href', '/documents');
  });

  it('has no accessibility violations while locked or after capture', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    const { container } = renderWithSession(
      <PaymentScenarioGate orderId={FIXTURE_ENTRY_POINTS.orderId} />,
      session,
    );
    await screen.findByRole('button', { name: 'ثبت پرداخت شبیه‌سازی‌شده' });
    await expectNoAxeViolations(container);

    placeOrder();
    const button = await screen.findByRole('button', { name: 'ثبت پرداخت شبیه‌سازی‌شده' });
    await userEvent.click(button);
    await screen.findByText('پرداخت نهایی شد');
    await expectNoAxeViolations(container);
  });
});
