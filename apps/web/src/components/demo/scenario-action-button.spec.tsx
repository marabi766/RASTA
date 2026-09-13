import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations } from '@/test/harness';
import { ScenarioActionButton } from './scenario-action-button';

/**
 * The one shared control every per-screen scenario panel is built from.
 *
 * Every real panel pre-disables (`lockedReason`) or pre-hides (`done`) an
 * action the reducer would reject, so a user can never actually click their
 * way to a `REJECTED` dispatch through the rendered UI — which is the point
 * of locking rather than failing. This file is where the rejection-rendering
 * path itself is proven, independent of which panel might one day call it.
 */
describe('ScenarioActionButton', () => {
  it('renders a disabled button with its prerequisite explained when locked', () => {
    render(
      <ScenarioActionButton
        label="تأیید برآورد هزینه"
        doneLabel="تأیید شد"
        done={false}
        lockedReason="ابتدا باید درخواست تعمیر ثبت شود."
        onActivate={() => ({ outcome: 'APPLIED' })}
      />,
    );

    const button = screen.getByRole('button', { name: 'تأیید برآورد هزینه' });
    expect(button).toBeDisabled();
    expect(screen.getByText('ابتدا باید درخواست تعمیر ثبت شود.')).toBeInTheDocument();
  });

  it('renders a done badge instead of a button once the action is done', () => {
    render(
      <ScenarioActionButton
        label="تأیید برآورد هزینه"
        doneLabel="برآورد هزینه تأیید شد"
        done
        lockedReason={null}
        onActivate={() => ({ outcome: 'APPLIED' })}
      />,
    );

    expect(screen.getByText('برآورد هزینه تأیید شد')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('calls onActivate on click and shows no alert when it succeeds', async () => {
    const onActivate = jest.fn(() => ({ outcome: 'APPLIED' as const }));
    render(
      <ScenarioActionButton
        label="ثبت درخواست تعمیر"
        doneLabel="ثبت شد"
        done={false}
        lockedReason={null}
        onActivate={onActivate}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'ثبت درخواست تعمیر' }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('surfaces a clear Persian message through role="alert" when the dispatch is rejected', async () => {
    const onActivate = jest.fn(() => ({
      outcome: 'REJECTED' as const,
      message: 'این گام پیش از موعد یا به‌صورت تکراری اجرا شد.',
    }));
    render(
      <ScenarioActionButton
        label="ثبت درخواست تعمیر"
        doneLabel="ثبت شد"
        done={false}
        lockedReason={null}
        onActivate={onActivate}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'ثبت درخواست تعمیر' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'این گام پیش از موعد یا به‌صورت تکراری اجرا شد.',
    );
  });

  it('is keyboard-operable: Tab then Enter activates it', async () => {
    const onActivate = jest.fn(() => ({ outcome: 'APPLIED' as const }));
    render(
      <ScenarioActionButton
        label="ثبت درخواست تعمیر"
        doneLabel="ثبت شد"
        done={false}
        lockedReason={null}
        onActivate={onActivate}
      />,
    );

    screen.getByRole('button', { name: 'ثبت درخواست تعمیر' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('has no accessibility violations when locked, active or rejected', async () => {
    const { container, rerender } = render(
      <ScenarioActionButton
        label="ثبت درخواست تعمیر"
        doneLabel="ثبت شد"
        done={false}
        lockedReason="ابتدا باید مرحلهٔ قبل انجام شود."
        onActivate={() => ({ outcome: 'APPLIED' })}
      />,
    );
    await expectNoAxeViolations(container);

    rerender(
      <ScenarioActionButton
        label="ثبت درخواست تعمیر"
        doneLabel="ثبت شد"
        done={false}
        lockedReason={null}
        onActivate={() => ({ outcome: 'REJECTED', message: 'رد شد.' })}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'ثبت درخواست تعمیر' }));
    await expectNoAxeViolations(container);
  });
});
