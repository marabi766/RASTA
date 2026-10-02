import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import { BASELINE_FIELD, CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { APPROVAL_TOTAL_CHANGED_MESSAGE } from '@/server/maintenance-commands';

import { ApproveRequestForm, AssignWorkshopForm, CancelRequestForm } from './RequestCommandForms';
import type { RequestCommandFormState } from './form-state';

/**
 * The three command forms in every state their own actions can put them in.
 * `useActionState` is stubbed so a state can be rendered without a server
 * action running (the technique of `../report-form.spec.tsx`).
 */

let currentState: RequestCommandFormState<unknown, string> = { kind: 'IDLE' };
let pending = false;

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useActionState: () => [currentState, '/maintenance#action', pending] as const,
  };
});

const CSRF = 'csrf-token-for-this-session';
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';
const REQUEST = 'MNT_01J00000000000000000000000';
const BASELINE = 'signed-baseline-token';
const IDENTITY = { csrfToken: CSRF, submissionId: SUBMISSION, requestId: REQUEST };

/** Physical-direction utilities that would break the right-to-left layout. */
const PHYSICAL_DIRECTION = /\b(?:m[lr]|p[lr]|left|right|text-left|text-right)-/;

afterEach(() => {
  currentState = { kind: 'IDLE' };
  pending = false;
});

function setState(state: RequestCommandFormState<unknown, string>, isPending = false) {
  currentState = state;
  pending = isPending;
}

const FORMS = [
  {
    name: 'the assign form',
    render: () => render(<AssignWorkshopForm {...IDENTITY} />),
    button: 'ارجاع به تعمیرگاه',
    busy: 'در حال ارجاع…',
  },
  {
    name: 'the approve form',
    render: () =>
      render(<ApproveRequestForm {...IDENTITY} totalCostMinor="12500000" baseline={BASELINE} />),
    button: 'تأیید هزینه',
    busy: 'در حال تأیید…',
  },
  {
    name: 'the cancel form',
    render: () => render(<CancelRequestForm {...IDENTITY} />),
    button: 'لغو درخواست',
    busy: 'در حال لغو…',
  },
] as const;

describe.each(FORMS)('$name', (form) => {
  it('carries the CSRF token, the submission id and the request it is about', () => {
    const { container } = form.render();
    expect(container.querySelector(`input[name="${CSRF_FIELD}"]`)).toHaveValue(CSRF);
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(SUBMISSION);
    expect(container.querySelector('input[name="requestId"]')).toHaveValue(REQUEST);
  });

  it('is a plain form post to a server action, so it works before any bundle loads', () => {
    const { container } = form.render();
    expect(container.querySelector('form')).not.toBeNull();
    expect(container.querySelector('form')?.getAttribute('action')).toBe('/maintenance#action');
  });

  it('keeps the same submission id when the form comes back invalid', () => {
    setState({
      kind: 'INVALID',
      submissionId: 'sub_BBBBBBBBBBBBBBBBBBBB',
      values: {},
      fieldErrors: {},
      message: 'جمله‌ای از سرویس',
    });
    const { container } = form.render();
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(
      'sub_BBBBBBBBBBBBBBBBBBBB',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('جمله‌ای از سرویس');
  });

  it('disables the button while a submit is in flight', () => {
    setState({ kind: 'IDLE' }, true);
    form.render();
    expect(screen.getByRole('button', { name: form.busy })).toBeDisabled();
  });

  it.each([
    [{ kind: 'REFUSED', reason: 'NO_SESSION' } as const, /نشست شما پایان یافته/],
    [{ kind: 'REFUSED', reason: 'CSRF' } as const, /معتبر شناخته نشد/],
    [{ kind: 'REFUSED', reason: 'SUBMISSION' } as const, /معتبر شناخته نشد/],
    [{ kind: 'FORBIDDEN', correlationId: 'corr-403' } as const, /corr-403/],
    [
      { kind: 'NOT_FOUND', correlationId: 'corr-404' } as const,
      /پیدا نشد یا در سازمان فعال شما نیست/,
    ],
    [{ kind: 'NOT_FOUND', correlationId: null } as const, /پیدا نشد یا در سازمان فعال شما نیست/],
    [{ kind: 'FAILED', status: 503, correlationId: 'corr-503' } as const, /corr-503/],
    [{ kind: 'UNCONFIRMED', correlationId: 'corr-unk' } as const, /corr-unk/],
  ])('says so in Persian for %j', (state, expected) => {
    setState(state);
    form.render();
    expect(screen.getByRole('alert')).toHaveTextContent(expected);
  });

  it('never claims a write was not made when its outcome is unknown', () => {
    setState({ kind: 'UNCONFIRMED', correlationId: 'corr-unk' });
    form.render();
    expect(screen.getByRole('alert')).not.toHaveTextContent('چیزی تغییر نکرد');
  });

  it('uses no physical-direction utility, and has no accessibility violations', async () => {
    const { container } = form.render();
    expect(container.innerHTML).not.toMatch(PHYSICAL_DIRECTION);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the assign form', () => {
  it('says plainly that the workshop is not verified, and asks for an organization id', () => {
    const { container } = render(<AssignWorkshopForm {...IDENTITY} />);
    expect(screen.getByText(/راستی‌آزمایی نمی‌شود/)).toBeInTheDocument();
    expect(container.querySelector('input[name="workshopOrganizationId"]')).toHaveAttribute(
      'dir',
      'ltr',
    );
    expect(screen.getByLabelText(/شناسهٔ سازمان تعمیرگاه/)).toBeRequired();
  });

  it('puts the service’s per-field problems at the field, in Persian', async () => {
    setState({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: { workshopOrganizationId: 'x', workshopName: 'ل', workSummary: '' },
      fieldErrors: { workshopOrganizationId: 'شناسهٔ سازمان معتبر نیست' },
      message: null,
    });
    const { container } = render(<AssignWorkshopForm {...IDENTITY} />);
    expect(screen.getByText('شناسهٔ سازمان معتبر نیست')).toBeInTheDocument();
    expect(container.querySelector('input[name="workshopOrganizationId"]')).toHaveValue('x');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the approve form', () => {
  it('states the sum being approved, in Persian digits, and that it is final', () => {
    render(<ApproveRequestForm {...IDENTITY} totalCostMinor="12500000" baseline={BASELINE} />);
    expect(screen.getByText(/برای تسویه مجاز می‌شود/)).toHaveTextContent('۱۲');
    expect(screen.getByText(/نهایی است/)).toBeInTheDocument();
  });

  it('carries the signed baseline, and no field the person could use to name another amount or request', () => {
    const { container } = render(
      <ApproveRequestForm {...IDENTITY} totalCostMinor="12500000" baseline={BASELINE} />,
    );
    const baseline = container.querySelector(`input[name="${BASELINE_FIELD}"]`);
    expect(baseline).toHaveValue(BASELINE);
    expect(baseline).toHaveAttribute('type', 'hidden');
    // The amount rides in the baseline only: a plain hidden copy would be one
    // more field a script could rewrite.
    expect(container.querySelector('input[name="expectedTotalCostMinor"]')).toBeNull();
  });

  it('says so when the baseline was refused, and offers a way forward', () => {
    setState({ kind: 'REFUSED', reason: 'BASELINE' });
    render(<ApproveRequestForm {...IDENTITY} totalCostMinor="12500000" baseline={BASELINE} />);
    expect(screen.getByRole('alert')).toHaveTextContent('صفحه را تازه کنید');
    expect(screen.getByRole('alert')).toHaveTextContent('مبلغ نمایش‌داده‌شده');
  });

  it('shows a problem with the echoed total as a warning, since there is no field to put it on', () => {
    setState({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: { expectedTotalCostMinor: 'x', notes: '' },
      fieldErrors: { expectedTotalCostMinor: 'مبلغ نمایش‌داده‌شده معتبر نیست؛ صفحه را تازه کنید' },
      message: null,
    });
    render(<ApproveRequestForm {...IDENTITY} totalCostMinor="12500000" baseline={BASELINE} />);
    expect(screen.getByRole('alert')).toHaveTextContent('صفحه را تازه کنید');
  });

  it('keeps the note when the form comes back invalid', () => {
    setState({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: { expectedTotalCostMinor: '12500000', notes: 'یادداشت من' },
      fieldErrors: { notes: 'یادداشت را کامل کنید' },
      message: APPROVAL_TOTAL_CHANGED_MESSAGE,
    });
    const { container } = render(
      <ApproveRequestForm {...IDENTITY} totalCostMinor="12500000" baseline={BASELINE} />,
    );
    expect(container.querySelector('textarea[name="notes"]')).toHaveValue('یادداشت من');
  });
});

describe('the cancel form', () => {
  it('is closed until asked for, and says what cancelling does and that it is final', () => {
    const { container } = render(<CancelRequestForm {...IDENTITY} />);
    expect(container.querySelector('details')).not.toHaveAttribute('open');
    expect(screen.getByText('لغو این درخواست')).toBeInTheDocument();
    expect(screen.getByText(/لغو نهایی است/)).toBeInTheDocument();
    expect(screen.getByText(/هزینهٔ ثبت‌شده می‌ماند/)).toBeInTheDocument();
  });

  it('opens by itself when an attempt came back with something to read', () => {
    setState({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: { reason: 'ab' },
      fieldErrors: { reason: 'دلیل لغو دست‌کم ۳ نویسه باشد' },
      message: null,
    });
    const { container } = render(<CancelRequestForm {...IDENTITY} />);
    expect(container.querySelector('details')).toHaveAttribute('open');
    expect(screen.getByText('دلیل لغو دست‌کم ۳ نویسه باشد')).toBeInTheDocument();
    expect(container.querySelector('textarea[name="reason"]')).toHaveValue('ab');
  });

  it('is not a primary action: abandoning work is the thing least asked of this page', () => {
    render(<CancelRequestForm {...IDENTITY} />);
    expect(screen.getByRole('button', { name: 'لغو درخواست', hidden: true }).className).not.toMatch(
      /bg-accent\b/,
    );
  });
});
