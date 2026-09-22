import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';

import { UsageForm } from './UsageForm';
import type { UsageFormState } from './form-state';

/**
 * The usage form, in each state its action can put it in.
 *
 * `useActionState` is stubbed so every state can be rendered directly. What
 * is asserted is what the person sees and what the browser would send —
 * including the two hidden fields, which are the whole write-path
 * foundation as far as the markup is concerned: a CSRF token bound to the
 * session, and a submission id that makes a retry a retry.
 */

let currentState: UsageFormState = { kind: 'IDLE' };
let pending = false;

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useActionState: () => [currentState, '/usage#action', pending] as const,
  };
});

const CSRF = 'csrf-token-for-this-session';
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';

function renderForm(state: UsageFormState = { kind: 'IDLE' }, isPending = false) {
  currentState = state;
  pending = isPending;
  return render(<UsageForm csrfToken={CSRF} submissionId={SUBMISSION} />);
}

const VALUES = {
  assetId: 'AST_01JASSET000000000000000000',
  periodStart: '2026-09-21T08:00',
  periodEnd: '2026-09-21T16:30',
  hours: '8.5',
  kilometres: '',
  hourMeter: '',
  odometer: '',
  notes: 'جاده روستایی',
};

afterEach(() => {
  currentState = { kind: 'IDLE' };
  pending = false;
});

describe('what the browser would send', () => {
  it('carries the session CSRF token as a hidden field, so it works without javascript', () => {
    const { container } = renderForm();
    const field = container.querySelector(`input[name="${CSRF_FIELD}"]`);
    expect(field).toHaveAttribute('type', 'hidden');
    expect(field).toHaveValue(CSRF);
  });

  it('carries the submission id the server minted', () => {
    const { container } = renderForm();
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(SUBMISSION);
  });

  it('reuses the failed attempt’s submission id on a retry', () => {
    // Otherwise a second click after a validation error would reach the
    // service as a different submission, and a slow first request that
    // succeeded after all would leave two records.
    const { container } = renderForm({
      kind: 'INVALID',
      submissionId: 'sub_BBBBBBBBBBBBBBBBBBBB',
      values: VALUES,
      fieldErrors: { hours: 'خطا' },
      message: null,
    });
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(
      'sub_BBBBBBBBBBBBBBBBBBBB',
    );
  });

  it('names every field the service expects', () => {
    const { container } = renderForm();
    for (const name of ['assetId', 'periodStart', 'periodEnd', 'hours', 'kilometres', 'notes']) {
      expect(container.querySelector(`[name="${name}"]`)).toBeInTheDocument();
    }
  });

  it('uses a text input with a decimal keypad for quantities, not a number input', () => {
    // `type="number"` silently empties itself when it sees Persian digits,
    // so the value a person typed would vanish instead of being normalised.
    const { container } = renderForm();
    const hours = container.querySelector('[name="hours"]');
    expect(hours).not.toHaveAttribute('type', 'number');
    expect(hours).toHaveAttribute('inputmode', 'decimal');
  });
});

describe('what the person sees', () => {
  it('keeps the values they typed when the form comes back invalid', () => {
    const { container } = renderForm({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: VALUES,
      fieldErrors: { hours: 'دست‌کم یکی از ساعت کارکرد یا کیلومتر را وارد کنید' },
      message: null,
    });
    expect(container.querySelector('[name="assetId"]')).toHaveValue(VALUES.assetId);
    expect(container.querySelector('[name="notes"]')).toHaveValue(VALUES.notes);
  });

  it('puts a field error under its own field, announced', () => {
    const { container, getByText } = renderForm({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: VALUES,
      fieldErrors: { periodEnd: 'پایان بازه باید پس از شروع آن باشد' },
      message: null,
    });

    const message = getByText('پایان بازه باید پس از شروع آن باشد');
    expect(message).toHaveAttribute('role', 'alert');
    // Queried by name rather than by role: a `datetime-local` input has no
    // `textbox` role, which is a fact about the control, not about the wiring.
    const input = container.querySelector('[name="periodEnd"]');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    // The message is tied to the control it belongs to, so a screen reader
    // reads it instead of announcing a bare "invalid entry".
    const described = input?.getAttribute('aria-describedby') ?? '';
    expect(described).toContain(message.id);
  });

  it('shows a rule the service stated without naming a field as a banner', () => {
    const { getByText } = renderForm({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: VALUES,
      fieldErrors: {},
      message: 'بازهٔ کارکرد نمی‌تواند در آینده باشد',
    });
    expect(getByText('بازهٔ کارکرد نمی‌تواند در آینده باشد')).toBeInTheDocument();
  });

  it('says a machine is out of reach on the machine field, not as a generic failure', () => {
    const { getByText } = renderForm({
      kind: 'NOT_FOUND',
      submissionId: SUBMISSION,
      values: VALUES,
      correlationId: 'corr-sample',
    });
    expect(getByText('این ماشین در دسترس شما نیست یا وجود ندارد')).toBeInTheDocument();
  });

  it('asks the person to sign in again when the session is gone', () => {
    const { getByText } = renderForm({ kind: 'REFUSED', reason: 'NO_SESSION' });
    expect(getByText(/نشست شما پایان یافته است/)).toBeInTheDocument();
  });

  it('answers a refused CSRF check without pretending anything was saved', () => {
    const { getByText, queryByText } = renderForm({ kind: 'REFUSED', reason: 'CSRF' });
    expect(getByText(/این درخواست معتبر شناخته نشد/)).toBeInTheDocument();
    expect(queryByText(/ثبت شد/)).not.toBeInTheDocument();
  });

  it('shows the correlation id on an outage, and says nothing was saved', () => {
    const { getByText } = renderForm({ kind: 'FAILED', status: 503, correlationId: 'corr-sample' });
    expect(getByText(/corr-sample/)).toBeInTheDocument();
    expect(getByText(/چیزی ذخیره نشد/)).toBeInTheDocument();
  });

  it('shows a refusal with its correlation id', () => {
    const { getByText } = renderForm({ kind: 'FORBIDDEN', correlationId: 'corr-sample' });
    expect(getByText(/اجازهٔ ثبت کارکرد/)).toBeInTheDocument();
    expect(getByText(/corr-sample/)).toBeInTheDocument();
  });

  it('disables the submit button while a submission is in flight', () => {
    const { getByRole } = renderForm({ kind: 'IDLE' }, true);
    expect(getByRole('button', { name: 'در حال ثبت…' })).toBeDisabled();
  });
});

describe('accessibility', () => {
  it('has no violations when empty', async () => {
    const { container } = renderForm();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations while showing field errors', async () => {
    const { container } = renderForm({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: VALUES,
      fieldErrors: { hours: 'خطا', periodEnd: 'خطا' },
      message: 'یک مشکل کلی',
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});
