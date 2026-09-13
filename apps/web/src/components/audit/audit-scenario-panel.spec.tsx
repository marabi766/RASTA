import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getScenarioStore, resetScenarioStoreSingletonForTests } from '@/lib/demo/scenario/store';
import { expectNoAxeViolations, makeHarness, renderWithSession, settle } from '@/test/harness';
import { AuditScenarioGate } from './audit-scenario-gate';

describe('AuditScenarioGate', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetScenarioStoreSingletonForTests();
  });

  it('renders nothing in live mode', async () => {
    const { session } = makeHarness({ dataMode: 'live' });
    const { container } = renderWithSession(<AuditScenarioGate />, session);
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it('is available from the very first revision — no prerequisite to unlock', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(<AuditScenarioGate />, session);

    const button = await screen.findByRole('button', {
      name: 'افزودن یادداشت بازرسی به خط زمانی',
    });
    expect(button).not.toBeDisabled();
  });

  it('appends a new activity-log entry on every click and calls onApplied each time — repeatable, not a one-shot', async () => {
    const onApplied = jest.fn();
    const { session } = makeHarness({ dataMode: 'fixture' });
    renderWithSession(<AuditScenarioGate onApplied={onApplied} />, session);

    const before = getScenarioStore().getState().activityLog.length;
    const button = await screen.findByRole('button', {
      name: 'افزودن یادداشت بازرسی به خط زمانی',
    });

    await userEvent.click(button);
    await userEvent.click(button);

    expect(getScenarioStore().getState().activityLog.length).toBe(before + 2);
    expect(onApplied).toHaveBeenCalledTimes(2);
    // The control never turns into a "done" checkmark — it stays a button.
    expect(
      screen.getByRole('button', { name: 'افزودن یادداشت بازرسی به خط زمانی' }),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations before or after repeated clicks', async () => {
    const { session } = makeHarness({ dataMode: 'fixture' });
    const { container } = renderWithSession(<AuditScenarioGate />, session);

    const button = await screen.findByRole('button', {
      name: 'افزودن یادداشت بازرسی به خط زمانی',
    });
    await expectNoAxeViolations(container);

    await userEvent.click(button);
    await expectNoAxeViolations(container);
  });
});
