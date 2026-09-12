import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetScenarioStoreSingletonForTests } from '@/lib/demo/scenario/store';
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
    expect(screen.getByText('سازمان انتخاب شد')).toBeInTheDocument();
    expect(screen.getByText('۰')).toBeInTheDocument();
  });

  it('never exposes the raw snapshot as JSON text', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    const { container } = renderWithSession(<ScenarioStatusGate />, session);

    await screen.findByText('scenario_demo_grader_oil_change');
    expect(container.textContent).not.toMatch(/"schemaVersion"|"activityLog"/);
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
