import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

import { TopUpForm } from './TopUpForm';
import type { TopUpFormState } from './form-state';

/**
 * `TopUpForm`, in every state its own action can put it in. Same technique
 * as `driver-forms.spec.tsx`: `useActionState` is stubbed so a state can be
 * rendered directly without a server action actually running.
 */

let currentState: TopUpFormState = { kind: 'IDLE' };
let pending = false;

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useActionState: () => [currentState, '/wallet#action', pending] as const,
  };
});

const CSRF = 'csrf-token-for-this-session';
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';

afterEach(() => {
  currentState = { kind: 'IDLE' };
  pending = false;
});

function renderForm(state: TopUpFormState = { kind: 'IDLE' }, isPending = false) {
  currentState = state;
  pending = isPending;
  return render(<TopUpForm walletId="WLT_1" csrfToken={CSRF} submissionId={SUBMISSION} />);
}

describe('TopUpForm', () => {
  it('has no card field, bank name or trust-badge wording — a simulation says so, not a payment box', () => {
    const { container } = renderForm();
    expect(container.querySelector('[name="cardNumber"]')).toBeNull();
    expect(container.textContent).not.toMatch(/کارت|بانک|پرداخت امن/);
  });

  it('names the one field it collects', () => {
    const { container } = renderForm();
    expect(container.querySelector('[name="amountMinor"]')).toBeInTheDocument();
  });

  it('shows the field error the service named', () => {
    const { getByText, container } = renderForm({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: { amountMinor: '0' },
      fieldErrors: { amountMinor: 'مبلغ باید بیشتر از صفر باشد' },
      message: null,
    });
    expect(getByText('مبلغ باید بیشتر از صفر باشد')).toBeInTheDocument();
    expect(container.querySelector('[name="amountMinor"]')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows a session-expired banner distinctly from a tampered-request banner', () => {
    const expired = renderForm({ kind: 'REFUSED', reason: 'NO_SESSION' });
    expect(expired.getByText(/نشست شما پایان یافته/)).toBeInTheDocument();

    const tampered = renderForm({ kind: 'REFUSED', reason: 'CSRF' });
    expect(tampered.getByText(/این درخواست معتبر شناخته نشد/)).toBeInTheDocument();
  });

  it('shows the correlation id on a forbidden or failed attempt', () => {
    const forbidden = renderForm({ kind: 'FORBIDDEN', correlationId: 'COR_1' });
    expect(forbidden.getByText(/COR_1/)).toBeInTheDocument();

    const failed = renderForm({ kind: 'FAILED', status: 503, correlationId: 'COR_2' });
    expect(failed.getByText(/COR_2/)).toBeInTheDocument();
  });

  it('disables submission while pending', () => {
    const { getByRole } = renderForm({ kind: 'IDLE' }, true);
    expect(getByRole('button', { name: /در حال ثبت/ })).toBeDisabled();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderForm();
    expect(await axe(container)).toHaveNoViolations();
  });
});
