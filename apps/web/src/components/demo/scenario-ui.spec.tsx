import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FIXTURE_ENTRY_POINTS } from '@/lib/demo/entry-points';
import { getScenarioStore, resetScenarioStoreSingletonForTests } from '@/lib/demo/scenario/store';
import { expectNoAxeViolations, makeHarness, renderWithSession, settle } from '@/test/harness';
import { ScenarioResetGate } from './scenario-reset-gate';
import { ScenarioStatusGate } from './scenario-status-gate';

/**
 * The two fixture-only UI islands: the status card and the reset control.
 *
 * Both are loaded through `next/dynamic`, so every assertion here awaits a
 * render rather than asserting synchronously — the same thing a real browser
 * does while the chunk loads, just compressed into a test tick.
 */

describe('ScenarioStatusGate', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetScenarioStoreSingletonForTests();
  });

  it('renders nothing in live mode', async () => {
    const { session } = makeHarness({ dataMode: 'live' });
    const { container } = renderWithSession(<ScenarioStatusGate />, session);
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the scenario name, stage and revision in fixture mode', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(<ScenarioStatusGate />, session);

    await screen.findByText('scenario_demo_grader_oil_change');
    // Two matches now exist: the summary line and the current-stage stepper
    // chip (added for Phase C) — both legitimately say the same thing.
    expect(screen.getAllByText('سازمان انتخاب شد').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('۰')).toBeInTheDocument();
  });

  it('never exposes the raw snapshot as JSON text', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    const { container } = renderWithSession(<ScenarioStatusGate />, session);

    await screen.findByText('scenario_demo_grader_oil_change');
    expect(container.textContent).not.toMatch(/"schemaVersion"|"activityLog"/);
  });

  it('selects a persona, idempotently, and reflects the choice visually', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(<ScenarioStatusGate />, session);

    await screen.findByText('scenario_demo_grader_oil_change');
    const fleetManager = screen.getByRole('button', { name: 'مدیر ناوگان' });
    await userEvent.click(fleetManager);
    expect(fleetManager).toHaveTextContent('✓');

    // Re-selecting the same persona is idempotent — no rejection, no change.
    await userEvent.click(fleetManager);
    expect(fleetManager).toHaveTextContent('✓');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the current stage on the stepper and the matching next-destination link', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(<ScenarioStatusGate />, session);

    await screen.findByText('scenario_demo_grader_oil_change');
    const current = screen.getByText('سازمان انتخاب شد', { selector: '[aria-current="step"]' });
    expect(current).toBeInTheDocument();

    const link = screen.getByRole('link', { name: /گام بعدی/ });
    expect(link).toHaveAttribute('href', '/assets/ast_demo_grader');

    getScenarioStore().dispatch({
      type: 'MAINTENANCE_REQUEST_CREATED',
      maintenanceRequestId: FIXTURE_ENTRY_POINTS.maintenanceRequestId,
      assetId: FIXTURE_ENTRY_POINTS.assetId,
      organizationId: FIXTURE_ENTRY_POINTS.organizationId,
      title: 'x',
    });

    expect(
      await screen.findByText('درخواست تعمیر ثبت شد', { selector: '[aria-current="step"]' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /گام بعدی/ })).toHaveAttribute(
      'href',
      `/maintenance/${FIXTURE_ENTRY_POINTS.maintenanceRequestId}`,
    );
  });

  it('has no accessibility violations after a persona change and a stage advance', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    const { container } = renderWithSession(<ScenarioStatusGate />, session);

    await screen.findByText('scenario_demo_grader_oil_change');
    await userEvent.click(screen.getByRole('button', { name: 'مدیر ناوگان' }));
    await expectNoAxeViolations(container);

    getScenarioStore().dispatch({
      type: 'MAINTENANCE_REQUEST_CREATED',
      maintenanceRequestId: FIXTURE_ENTRY_POINTS.maintenanceRequestId,
      assetId: FIXTURE_ENTRY_POINTS.assetId,
      organizationId: FIXTURE_ENTRY_POINTS.organizationId,
      title: 'x',
    });
    await screen.findByText('درخواست تعمیر ثبت شد', { selector: '[aria-current="step"]' });
    await expectNoAxeViolations(container);
  });
});

describe('ScenarioResetGate', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetScenarioStoreSingletonForTests();
  });

  it('renders nothing in live mode', async () => {
    const { session } = makeHarness({ dataMode: 'live' });
    const { container } = renderWithSession(<ScenarioResetGate />, session);
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('asks for confirmation before resetting', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(<ScenarioResetGate />, session);

    const trigger = await screen.findByRole('button', { name: 'بازنشانی سناریوی نمایشی' });
    await userEvent.click(trigger);

    expect(screen.getByRole('button', { name: 'بازنشانی' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'انصراف' })).toBeInTheDocument();
    // Not reset yet — no success status.
    expect(screen.queryByText('سناریوی نمایشی بازنشانی شد.')).not.toBeInTheDocument();
  });

  it('moves focus to the confirm button, and cancel returns it to the trigger', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(<ScenarioResetGate />, session);

    const trigger = await screen.findByRole('button', { name: 'بازنشانی سناریوی نمایشی' });
    await userEvent.click(trigger);

    const confirm = screen.getByRole('button', { name: 'بازنشانی' });
    expect(confirm).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'انصراف' }));
    expect(screen.getByRole('button', { name: 'بازنشانی سناریوی نمایشی' })).toHaveFocus();
  });

  it('is fully keyboard-operable: Tab to the trigger, Enter to open, Enter to confirm', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(<ScenarioResetGate />, session);

    const trigger = await screen.findByRole('button', { name: 'بازنشانی سناریوی نمایشی' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');

    const confirm = await screen.findByRole('button', { name: 'بازنشانی' });
    expect(confirm).toHaveFocus();
    await userEvent.keyboard('{Enter}');

    expect(await screen.findByText('سناریوی نمایشی بازنشانی شد.')).toBeInTheDocument();
  });

  it('announces success through an aria-live status region, focused', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(<ScenarioResetGate />, session);

    await userEvent.click(await screen.findByRole('button', { name: 'بازنشانی سناریوی نمایشی' }));
    await userEvent.click(screen.getByRole('button', { name: 'بازنشانی' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('سناریوی نمایشی بازنشانی شد.');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveFocus();
  });

  it('has no accessibility violations in any of its three phases', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    const { container } = renderWithSession(<ScenarioResetGate />, session);

    await screen.findByRole('button', { name: 'بازنشانی سناریوی نمایشی' });
    await expectNoAxeViolations(container);

    await userEvent.click(screen.getByRole('button', { name: 'بازنشانی سناریوی نمایشی' }));
    await expectNoAxeViolations(container);

    await userEvent.click(screen.getByRole('button', { name: 'بازنشانی' }));
    await screen.findByRole('status');
    await expectNoAxeViolations(container);
  });
});
