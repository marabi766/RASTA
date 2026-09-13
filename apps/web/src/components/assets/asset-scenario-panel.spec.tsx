import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FIXTURE_ENTRY_POINTS } from '@/lib/demo/entry-points';
import { resetScenarioStoreSingletonForTests } from '@/lib/demo/scenario/store';
import { expectNoAxeViolations, makeHarness, renderWithSession, settle } from '@/test/harness';
import { AssetScenarioGate } from './asset-scenario-gate';

describe('AssetScenarioGate', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetScenarioStoreSingletonForTests();
  });

  it('renders nothing in live mode', async () => {
    const { session } = makeHarness({ dataMode: 'live' });
    const { container } = renderWithSession(
      <AssetScenarioGate assetId={FIXTURE_ENTRY_POINTS.assetId} />,
      session,
    );
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an asset other than the scenario canonical asset', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    const { container } = renderWithSession(
      <AssetScenarioGate assetId="ast_demo_loader" />,
      session,
    );
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('creates the maintenance request and reveals the next-step link', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(<AssetScenarioGate assetId={FIXTURE_ENTRY_POINTS.assetId} />, session);

    const button = await screen.findByRole('button', { name: 'ثبت درخواست تعمیر' });
    expect(screen.queryByRole('link', { name: /گام بعدی/ })).not.toBeInTheDocument();

    await userEvent.click(button);

    expect(await screen.findByText('درخواست تعمیر ثبت شد')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ثبت درخواست تعمیر' })).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: /گام بعدی/ });
    expect(link).toHaveAttribute(
      'href',
      `/maintenance/${FIXTURE_ENTRY_POINTS.maintenanceRequestId}`,
    );
  });

  it('does not create a second request on a later click — the control is gone', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(<AssetScenarioGate assetId={FIXTURE_ENTRY_POINTS.assetId} />, session);

    await userEvent.click(await screen.findByRole('button', { name: 'ثبت درخواست تعمیر' }));
    await screen.findByText('درخواست تعمیر ثبت شد');

    // The button that would re-dispatch MAINTENANCE_REQUEST_CREATED no
    // longer exists — idempotency is enforced by the panel not offering the
    // action a second time, on top of the reducer's own INVALID_TRANSITION.
    expect(screen.queryByRole('button', { name: 'ثبت درخواست تعمیر' })).not.toBeInTheDocument();
  });

  it('has no accessibility violations before or after dispatch', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    const { container } = renderWithSession(
      <AssetScenarioGate assetId={FIXTURE_ENTRY_POINTS.assetId} />,
      session,
    );

    await screen.findByRole('button', { name: 'ثبت درخواست تعمیر' });
    await expectNoAxeViolations(container);

    await userEvent.click(screen.getByRole('button', { name: 'ثبت درخواست تعمیر' }));
    await screen.findByText('درخواست تعمیر ثبت شد');
    await expectNoAxeViolations(container);
  });
});
