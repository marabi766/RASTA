import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FIXTURE_ENTRY_POINTS } from '@/lib/demo/entry-points';
import { getScenarioStore, resetScenarioStoreSingletonForTests } from '@/lib/demo/scenario/store';
import { expectNoAxeViolations, makeHarness, renderWithSession, settle } from '@/test/harness';
import { MaintenanceScenarioGate } from './maintenance-scenario-gate';

describe('MaintenanceScenarioGate', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetScenarioStoreSingletonForTests();
  });

  it('renders nothing in live mode', async () => {
    const { session } = makeHarness({ dataMode: 'live' });
    const { container } = renderWithSession(
      <MaintenanceScenarioGate requestId={FIXTURE_ENTRY_POINTS.maintenanceRequestId} />,
      session,
    );
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a request other than the scenario canonical one', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    const { container } = renderWithSession(
      <MaintenanceScenarioGate requestId="mrq_other" />,
      session,
    );
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('is locked, with its prerequisite explained, before the request exists', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(
      <MaintenanceScenarioGate requestId={FIXTURE_ENTRY_POINTS.maintenanceRequestId} />,
      session,
    );

    const button = await screen.findByRole('button', { name: 'تأیید برآورد هزینه' });
    expect(button).toBeDisabled();
    expect(
      screen.getByText('ابتدا باید درخواست تعمیر از صفحهٔ دارایی ثبت شود.'),
    ).toBeInTheDocument();
  });

  it('approves the estimate, calls onApplied, and reveals the next-step link once unlocked', async () => {
    getScenarioStore().dispatch({
      type: 'MAINTENANCE_REQUEST_CREATED',
      maintenanceRequestId: FIXTURE_ENTRY_POINTS.maintenanceRequestId,
      assetId: FIXTURE_ENTRY_POINTS.assetId,
      organizationId: FIXTURE_ENTRY_POINTS.organizationId,
      title: 'x',
    });

    const onApplied = jest.fn();
    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(
      <MaintenanceScenarioGate
        requestId={FIXTURE_ENTRY_POINTS.maintenanceRequestId}
        onApplied={onApplied}
      />,
      session,
    );

    const button = await screen.findByRole('button', { name: 'تأیید برآورد هزینه' });
    expect(button).not.toBeDisabled();

    await userEvent.click(button);

    expect(await screen.findByText('برآورد هزینه تأیید شد')).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalledTimes(1);
    const link = screen.getByRole('link', { name: /گام بعدی/ });
    expect(link).toHaveAttribute('href', `/marketplace/${FIXTURE_ENTRY_POINTS.productId}`);
  });

  it('has no accessibility violations while locked or after approval', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    const { container } = renderWithSession(
      <MaintenanceScenarioGate requestId={FIXTURE_ENTRY_POINTS.maintenanceRequestId} />,
      session,
    );

    await screen.findByRole('button', { name: 'تأیید برآورد هزینه' });
    await expectNoAxeViolations(container);

    getScenarioStore().dispatch({
      type: 'MAINTENANCE_REQUEST_CREATED',
      maintenanceRequestId: FIXTURE_ENTRY_POINTS.maintenanceRequestId,
      assetId: FIXTURE_ENTRY_POINTS.assetId,
      organizationId: FIXTURE_ENTRY_POINTS.organizationId,
      title: 'x',
    });
    await userEvent.click(await screen.findByRole('button', { name: 'تأیید برآورد هزینه' }));
    await screen.findByText('برآورد هزینه تأیید شد');
    await expectNoAxeViolations(container);
  });
});
