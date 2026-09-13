import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FIXTURE_ENTRY_POINTS } from '@/lib/demo/entry-points';
import { getScenarioStore, resetScenarioStoreSingletonForTests } from '@/lib/demo/scenario/store';
import { expectNoAxeViolations, makeHarness, renderWithSession, settle } from '@/test/harness';
import { DocumentScenarioGate } from './document-scenario-gate';

function capturePayment(): void {
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
  getScenarioStore().dispatch({
    type: 'PAYMENT_CAPTURED',
    orderId: FIXTURE_ENTRY_POINTS.orderId,
    amountMinor: '284000000',
  });
}

describe('DocumentScenarioGate', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetScenarioStoreSingletonForTests();
  });

  it('renders nothing in live mode', async () => {
    const { session } = makeHarness({ dataMode: 'live' });
    const { container } = renderWithSession(<DocumentScenarioGate />, session);
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('locks attachment until payment is captured, and the scan until a document is attached', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(<DocumentScenarioGate />, session);

    expect(await screen.findByRole('button', { name: 'پیوست سند' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /تکمیل اسکن سند/ })).toBeDisabled();
    expect(screen.getByText('ابتدا باید پرداخت سفارش نهایی شود.')).toBeInTheDocument();
    expect(screen.getByText('ابتدا سند را پیوست کنید.')).toBeInTheDocument();
  });

  it('attaches the document, then completes its scan as clean, calling onApplied each time', async () => {
    capturePayment();
    const onApplied = jest.fn();
    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(<DocumentScenarioGate onApplied={onApplied} />, session);

    const attach = await screen.findByRole('button', { name: 'پیوست سند' });
    expect(attach).not.toBeDisabled();
    await userEvent.click(attach);
    expect(await screen.findByText('سند پیوست شد')).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalledTimes(1);

    const scan = screen.getByRole('button', { name: /تکمیل اسکن سند/ });
    expect(scan).not.toBeDisabled();
    await userEvent.click(scan);

    expect(await screen.findByText('اسکن سند کامل شد — پاک')).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('link', { name: /گام بعدی/ })).toHaveAttribute('href', '/audit');
  });

  it('has no accessibility violations across the locked, attached and scanned phases', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    const { container } = renderWithSession(<DocumentScenarioGate />, session);
    await screen.findByRole('button', { name: 'پیوست سند' });
    await expectNoAxeViolations(container);

    capturePayment();
    const attach = await screen.findByRole('button', { name: 'پیوست سند' });
    await userEvent.click(attach);
    await screen.findByText('سند پیوست شد');
    await expectNoAxeViolations(container);

    await userEvent.click(screen.getByRole('button', { name: /تکمیل اسکن سند/ }));
    await screen.findByText('اسکن سند کامل شد — پاک');
    await expectNoAxeViolations(container);
  });
});
