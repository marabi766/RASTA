import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { EMPTY_UPDATE_DRIVER_FORM } from '@/lib/driver-fields';

import { UpdateDriverForm } from './UpdateDriverForm';
import { ChangeStatusForm } from './ChangeStatusForm';
import { AssignDriverForm } from './AssignDriverForm';
import { EndAssignmentForm } from './EndAssignmentForm';
import type {
  AssignFormState,
  ChangeStatusFormState,
  EndAssignmentFormState,
  UpdateDriverFormState,
} from './form-state';

/**
 * The four `/drivers/[id]` forms, each in every state its own action can put
 * it in. Same technique as `usage.spec.tsx` (PR #75) and `drivers.spec.tsx`:
 * `useActionState` is stubbed so a state can be rendered directly without a
 * server action actually running.
 *
 * One file for all four because each is rendered alone in every test here —
 * `DriverDetailScreen` is what composes them for real, and its own spec
 * covers the read-side branching that decides *which* of `AssignDriverForm`
 * or `EndAssignmentForm` appears, not their internal states.
 */

type AnyFormState =
  UpdateDriverFormState | ChangeStatusFormState | AssignFormState | EndAssignmentFormState;

let currentState: AnyFormState = { kind: 'IDLE' };
let pending = false;

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useActionState: () => [currentState, '/drivers/DRV_1#action', pending] as const,
  };
});

const CSRF = 'csrf-token-for-this-session';
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';

afterEach(() => {
  currentState = { kind: 'IDLE' };
  pending = false;
});

describe('UpdateDriverForm', () => {
  const INITIAL_VALUES = {
    employeeNo: 'EMP-1',
    licenceNumber: 'LIC-1',
    licenceClass: 'B',
    licenceValidTo: '2027-01-01',
    notes: '',
  };

  function renderForm(state: UpdateDriverFormState = { kind: 'IDLE' }, isPending = false) {
    currentState = state;
    pending = isPending;
    return render(
      <UpdateDriverForm
        driverId="DRV_1"
        csrfToken={CSRF}
        submissionId={SUBMISSION}
        initialValues={INITIAL_VALUES}
      />,
    );
  }

  it('is pre-filled with the driver’s current values, not blank', () => {
    const { container } = renderForm();
    expect(container.querySelector('[name="employeeNo"]')).toHaveValue('EMP-1');
    expect(container.querySelector('[name="licenceClass"]')).toHaveValue('B');
  });

  it('carries the session CSRF token and a submission id', () => {
    const { container } = renderForm();
    expect(container.querySelector(`input[name="${CSRF_FIELD}"]`)).toHaveValue(CSRF);
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(SUBMISSION);
  });

  it('keeps the retried values and submission id when the form comes back invalid', () => {
    const { container } = renderForm({
      kind: 'INVALID',
      submissionId: 'sub_BBBBBBBBBBBBBBBBBBBB',
      values: { ...EMPTY_UPDATE_DRIVER_FORM, employeeNo: 'EMP-2' },
      fieldErrors: { licenceNumber: 'شمارهٔ گواهینامه حداکثر ۶۴ نویسه است' },
      message: null,
    });
    expect(container.querySelector('[name="employeeNo"]')).toHaveValue('EMP-2');
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(
      'sub_BBBBBBBBBBBBBBBBBBBB',
    );
  });

  it('says an unconfirmed update may have been applied, and never that nothing changed', () => {
    const { container, getByText } = renderForm({
      kind: 'UNCONFIRMED',
      correlationId: 'corr-sample',
    });
    expect(getByText(/نتوانستیم تأیید کنیم/)).toBeInTheDocument();
    expect(getByText(/corr-sample/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/چیزی تغییر نکرد|ذخیره انجام نشد/);
  });

  it('shows the optimistic-lock refusal as a banner', () => {
    const { getByText } = renderForm({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: EMPTY_UPDATE_DRIVER_FORM,
      fieldErrors: {},
      message: 'این رکورد را درخواستی دیگر تغییر داد؛ صفحه را تازه کنید و دوباره تلاش کنید',
    });
    expect(
      getByText('این رکورد را درخواستی دیگر تغییر داد؛ صفحه را تازه کنید و دوباره تلاش کنید'),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderForm();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('ChangeStatusForm', () => {
  function renderForm(
    currentStatus = 'ACTIVE',
    state: ChangeStatusFormState = { kind: 'IDLE' },
    isPending = false,
  ) {
    currentState = state;
    pending = isPending;
    return render(
      <ChangeStatusForm
        driverId="DRV_1"
        currentStatus={currentStatus}
        csrfToken={CSRF}
        submissionId={SUBMISSION}
      />,
    );
  }

  it('offers every status except the driver’s current one', () => {
    const { queryByRole, getByRole } = renderForm('ACTIVE');
    expect(queryByRole('option', { name: 'فعال' })).toBeNull();
    expect(getByRole('option', { name: 'معلق' })).toBeInTheDocument();
    expect(getByRole('option', { name: 'از رده خارج' })).toBeInTheDocument();
  });

  it('renders nothing for a deactivated driver — the lifecycle is terminal', () => {
    const { container } = renderForm('DEACTIVATED');
    expect(container).toBeEmptyDOMElement();
  });

  it('requires a reason field, and shows its error when the service names one', () => {
    const { getByText, container } = renderForm('ACTIVE', {
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: { status: 'SUSPENDED', reason: '' },
      fieldErrors: { reason: 'دلیل را بنویسید' },
      message: null,
    });
    expect(getByText('دلیل را بنویسید')).toBeInTheDocument();
    expect(container.querySelector('[name="reason"]')).toHaveAttribute('aria-invalid', 'true');
  });

  it('has no accessibility violations', async () => {
    const { container } = renderForm('ACTIVE');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('AssignDriverForm', () => {
  function renderForm(state: AssignFormState = { kind: 'IDLE' }, isPending = false) {
    currentState = state;
    pending = isPending;
    return render(<AssignDriverForm driverId="DRV_1" csrfToken={CSRF} submissionId={SUBMISSION} />);
  }

  it('names the field the machine goes in', () => {
    const { container } = renderForm();
    expect(container.querySelector('[name="assetId"]')).toBeInTheDocument();
  });

  it('says a machine is out of reach on the machine field, not as a generic failure', () => {
    const { getByText } = renderForm({
      kind: 'NOT_FOUND',
      submissionId: SUBMISSION,
      values: { assetId: 'AST_1', startedAt: '', purpose: '' },
      correlationId: 'corr-sample',
    });
    expect(getByText('این ماشین در دسترس شما نیست یا وجود ندارد')).toBeInTheDocument();
  });

  it('shows the double-assignment refusal as a banner', () => {
    const { getByText } = renderForm({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: { assetId: '', startedAt: '', purpose: '' },
      fieldErrors: {},
      message: 'این راننده هم‌اکنون یک تخصیص فعال دارد. پیش از تخصیص تازه، آن را پایان دهید',
    });
    expect(
      getByText('این راننده هم‌اکنون یک تخصیص فعال دارد. پیش از تخصیص تازه، آن را پایان دهید'),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderForm();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('EndAssignmentForm', () => {
  function renderForm(state: EndAssignmentFormState = { kind: 'IDLE' }, isPending = false) {
    currentState = state;
    pending = isPending;
    return render(
      <EndAssignmentForm
        driverId="DRV_1"
        assignmentId="ASG_1"
        csrfToken={CSRF}
        submissionId={SUBMISSION}
      />,
    );
  }

  it('defaults the reason to COMPLETED', () => {
    const { container } = renderForm();
    expect(container.querySelector('[name="reason"]')).toHaveValue('COMPLETED');
  });

  it('shows the already-ended refusal as a banner rather than a field error', () => {
    const { getByText } = renderForm({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: { reason: 'COMPLETED', notes: '' },
      fieldErrors: {},
      message: 'این تخصیص پیش‌تر پایان یافته است',
    });
    expect(getByText('این تخصیص پیش‌تر پایان یافته است')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderForm();
    expect(await axe(container)).toHaveNoViolations();
  });
});
