import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import { BASELINE_FIELD, CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';

import { DeclareAvailabilityForm, RevokeAvailabilityForm } from './AvailabilityForms';
import type { RecordFormState } from './record-form-state';

/**
 * The two availability forms in every state their own actions can put them in.
 * `useActionState` is stubbed so a state can be rendered without a server action
 * running (the technique of `record-forms.spec.tsx`).
 */

let currentState: RecordFormState<unknown, string> = { kind: 'IDLE' };
let pending = false;

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useActionState: () => [currentState, '/assets/AST#action', pending] as const,
  };
});
jest.mock('./availability-actions', () => ({
  submitDeclareAvailability: jest.fn(),
  submitRevokeAvailability: jest.fn(),
}));

const CSRF = 'csrf-token-for-this-session';
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';
const ASSET = 'AST_01J00000000000000000000000';
const WINDOW = 'AVW_01J00000000000000000000000';
const BASELINE = 'eyJzaWduZWQiOiJieS10aGUtcGFnZSJ9.sig';
const IDENTITY = { assetId: ASSET, csrfToken: CSRF, submissionId: SUBMISSION, baseline: BASELINE };

const PHYSICAL_DIRECTION = /\b(?:m[lr]|p[lr]|left|right|text-left|text-right)-/;

afterEach(() => {
  currentState = { kind: 'IDLE' };
  pending = false;
});

const setState = (state: RecordFormState<unknown, string>, isPending = false) => {
  currentState = state;
  pending = isPending;
};

const FORMS = [
  {
    name: 'the declare form',
    render: () => render(<DeclareAvailabilityForm {...IDENTITY} />),
    busy: 'در حال ثبت…',
  },
  {
    name: 'the revoke control',
    render: () => render(<RevokeAvailabilityForm {...IDENTITY} windowId={WINDOW} />),
    busy: 'در حال ابطال…',
  },
] as const;

describe.each(FORMS)('$name', (form) => {
  it('carries the CSRF token, the submission id and the signed baseline — and no field that names an asset or a window', () => {
    const { container } = form.render();
    expect(container.querySelector(`input[name="${CSRF_FIELD}"]`)).toHaveValue(CSRF);
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(SUBMISSION);
    expect(container.querySelector(`input[name="${BASELINE_FIELD}"]`)).toHaveValue(BASELINE);
    for (const name of ['assetId', 'id', 'asset', 'windowId', 'window']) {
      expect(container.querySelector(`[name="${name}"]`)).toBeNull();
    }
    expect(container.innerHTML).not.toContain(ASSET);
    expect(container.innerHTML).not.toContain(WINDOW);
  });

  it('is a plain form post to a server action, so it works before any bundle loads', () => {
    const { container } = form.render();
    expect(container.querySelector('form')?.getAttribute('action')).toBe('/assets/AST#action');
  });

  it('keeps the same submission id after an attempt that could not be confirmed, so a resend is a replay', () => {
    setState({ kind: 'UNCONFIRMED', correlationId: 'corr-unk' });
    const { container } = form.render();
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(SUBMISSION);
  });

  it('disables the button while a submit is in flight, so a double click is one send', () => {
    setState({ kind: 'IDLE' }, true);
    form.render();
    expect(screen.getByRole('button', { name: form.busy })).toBeDisabled();
  });

  it.each([
    [{ kind: 'REFUSED', reason: 'NO_SESSION' } as const, /نشست شما پایان یافته/],
    [{ kind: 'REFUSED', reason: 'BASELINE' } as const, /معتبر شناخته نشد/],
    [{ kind: 'FORBIDDEN', correlationId: 'corr-403' } as const, /corr-403/],
    [
      { kind: 'NOT_FOUND', correlationId: 'corr-404' } as const,
      /پیدا نشد یا در سازمان فعال شما نیست/,
    ],
    [{ kind: 'FAILED', status: 503, correlationId: 'corr-503' } as const, /corr-503/],
    [{ kind: 'UNCONFIRMED', correlationId: 'corr-unk' } as const, /corr-unk/],
    [
      {
        kind: 'INVALID',
        submissionId: SUBMISSION,
        values: {},
        fieldErrors: {},
        message: 'جملهٔ سرویس',
      } as const,
      /جملهٔ سرویس/,
    ],
  ])('says so in Persian for %j', (state, expected) => {
    setState(state);
    form.render();
    expect(screen.getByRole('alert')).toHaveTextContent(expected);
  });

  it('never claims nothing changed when the outcome is unknown, and does when it is known', () => {
    setState({ kind: 'UNCONFIRMED', correlationId: 'corr-unk' });
    const unknown = form.render();
    expect(screen.getByRole('alert')).not.toHaveTextContent('چیزی تغییر نکرد');
    unknown.unmount();
    setState({ kind: 'FAILED', status: 503, correlationId: 'corr-503' });
    form.render();
    expect(screen.getByRole('alert')).toHaveTextContent('چیزی تغییر نکرد');
  });

  it('uses no physical-direction utility, and has no accessibility violations', async () => {
    setState({ kind: 'UNCONFIRMED', correlationId: 'corr' });
    const { container } = form.render();
    expect(container.innerHTML).not.toMatch(PHYSICAL_DIRECTION);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the declare form', () => {
  it('stays closed on a fresh page, and opens once an attempt came back', () => {
    const closed = render(<DeclareAvailabilityForm {...IDENTITY} />);
    expect(closed.container.querySelector('details')).not.toHaveAttribute('open');
    closed.unmount();
    setState({ kind: 'UNCONFIRMED', correlationId: 'corr' });
    expect(
      render(<DeclareAvailabilityForm {...IDENTITY} />).container.querySelector('details'),
    ).toHaveAttribute('open');
  });

  it('offers exactly the two choices, in Persian, with none chosen — and says a declaration does not lift a platform block', () => {
    const { container } = render(<DeclareAvailabilityForm {...IDENTITY} />);
    const select = container.querySelector('select[name="available"]') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['', 'false', 'true']);
    expect(select).toHaveValue('');
    expect([...select.options].map((option) => option.text).join(' ')).not.toMatch(/[A-Za-z]/);
    expect(screen.getByText(/مانعی را که سامانه اعمال کرده/)).toBeInTheDocument();
  });

  it('requires the choice and the reason, takes the two days as calendar days and leaves them optional', () => {
    const { container } = render(<DeclareAvailabilityForm {...IDENTITY} />);
    for (const name of ['available', 'reason'])
      expect(container.querySelector(`[name="${name}"]`)).toBeRequired();
    for (const name of ['fromAt', 'toAt']) {
      expect(container.querySelector(`[name="${name}"]`)).toHaveAttribute('type', 'date');
      expect(container.querySelector(`[name="${name}"]`)).not.toBeRequired();
    }
    expect(screen.getByText(/خالی یعنی از همین اکنون/)).toBeInTheDocument();
    expect(screen.getByText(/خالی یعنی تا زمانی که ابطال شود/)).toBeInTheDocument();
  });

  it('puts the field problems at the fields and keeps what was typed', async () => {
    setState({
      kind: 'INVALID',
      submissionId: 'sub_BBBBBBBBBBBBBBBBBBBB',
      values: { available: 'true', reason: 'رز', fromAt: '2026-10-10', toAt: '2026-10-01' },
      fieldErrors: { reason: 'دلیل دست‌کم ۳ نویسه باشد', toAt: 'پایان باید پس از آغاز باشد' },
      message: null,
    });
    const { container } = render(<DeclareAvailabilityForm {...IDENTITY} />);
    expect(screen.getByText('دلیل دست‌کم ۳ نویسه باشد')).toBeInTheDocument();
    expect(screen.getByText('پایان باید پس از آغاز باشد')).toBeInTheDocument();
    expect(container.querySelector('select[name="available"]')).toHaveValue('true');
    expect(container.querySelector('input[name="reason"]')).toHaveValue('رز');
    expect(container.querySelector('input[name="toAt"]')).toHaveValue('2026-10-01');
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(
      'sub_BBBBBBBBBBBBBBBBBBBB',
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the revoke control', () => {
  it('is one button, with no field to fill in', () => {
    const { container } = render(<RevokeAvailabilityForm {...IDENTITY} windowId={WINDOW} />);
    expect(screen.getByRole('button', { name: 'ابطال این اعلام' })).toBeInTheDocument();
    expect(container.querySelectorAll('input:not([type="hidden"]), select, textarea')).toHaveLength(
      0,
    );
  });
});
