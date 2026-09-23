import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

import { DriversScreen } from './DriversScreen';
import { NewDriverForm } from './NewDriverForm';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import type { DriverPage, ReadResult } from '@/server/drivers';
import type { CreateDriverFormState } from './form-state';

/**
 * The `/drivers` list, in every state the server can put it in, and the
 * registration form beside it. Mirrors `assets.spec.tsx` (PR #67) for the
 * list and `usage.spec.tsx` (PR #75) for the form.
 */

const DRIVER = {
  id: 'DRV_1',
  userId: 'USR_9',
  employeeNo: 'EMP-1',
  licenceNumber: 'LIC-1',
  licenceClass: 'B',
  licenceValidTo: '2027-01-01T00:00:00.000Z',
  status: 'ACTIVE',
};

const page = (overrides: Partial<DriverPage> = {}): ReadResult<DriverPage> => ({
  kind: 'OK',
  data: { items: [DRIVER], nextCursor: null, hasMore: false, ...overrides },
});

describe('the driver list', () => {
  it('shows a row per driver, linking to its detail', () => {
    const { getByRole } = render(<DriversScreen result={page()} query={{}} />);
    expect(getByRole('link', { name: 'EMP-1' })).toHaveAttribute('href', '/drivers/DRV_1');
  });

  it('falls back to the user id when no employee number is on file', () => {
    const { getByRole } = render(
      <DriversScreen result={page({ items: [{ ...DRIVER, employeeNo: null }] })} query={{}} />,
    );
    expect(getByRole('link', { name: 'USR_9' })).toBeInTheDocument();
  });

  it('translates status without translating the data', () => {
    const { getByRole } = render(<DriversScreen result={page()} query={{}} />);
    const row = getByRole('row', { name: /EMP-1/ });
    expect(row).toHaveTextContent('فعال');
    expect(getByRole('option', { name: 'فعال' })).toHaveValue('ACTIVE');
  });

  it('shows an unknown status as it arrived, rather than hiding it', () => {
    const { getByText } = render(
      <DriversScreen result={page({ items: [{ ...DRIVER, status: 'ON_LEAVE' }] })} query={{}} />,
    );
    expect(getByText('ON_LEAVE')).toBeInTheDocument();
  });

  it('offers the next page only when there is one', () => {
    const { queryByRole } = render(<DriversScreen result={page()} query={{}} />);
    expect(queryByRole('link', { name: 'صفحهٔ بعد' })).toBeNull();

    const { getByRole } = render(
      <DriversScreen
        result={page({ hasMore: true, nextCursor: 'CUR_2' })}
        query={{ status: 'ACTIVE' }}
      />,
    );
    expect(getByRole('link', { name: 'صفحهٔ بعد' })).toHaveAttribute(
      'href',
      '/drivers?status=ACTIVE&cursor=CUR_2',
    );
  });

  it('says something different when a filter matched nothing', () => {
    const empty = page({ items: [] });

    const unfiltered = render(<DriversScreen result={empty} query={{}} />);
    expect(unfiltered.getByText('هنوز راننده‌ای ثبت نشده')).toBeInTheDocument();

    const filtered = render(<DriversScreen result={empty} query={{ q: 'چیزی' }} />);
    expect(filtered.getByText('چیزی با این پالایش پیدا نشد')).toBeInTheDocument();
    expect(filtered.getByRole('link', { name: 'نمایش همه' })).toHaveAttribute('href', '/drivers');
  });

  it('renders a refusal as a refusal and an outage as an outage', () => {
    const forbidden = render(<DriversScreen result={{ kind: 'FORBIDDEN' }} query={{}} />);
    expect(forbidden.getByText('دسترسی ندارید')).toBeInTheDocument();

    const down = render(
      <DriversScreen
        result={{ kind: 'UNAVAILABLE', status: 503, correlationId: 'COR_9' }}
        query={{}}
      />,
    );
    expect(down.getByText(/COR_9/)).toBeInTheDocument();
  });

  it('filters through the URL, with no javascript', () => {
    const { getByRole } = render(<DriversScreen result={page()} query={{}} />);
    const form = getByRole('form', { name: 'پالایش فهرست' });
    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/drivers');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<DriversScreen result={page()} query={{}} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

let currentState: CreateDriverFormState = { kind: 'IDLE' };
let pending = false;

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useActionState: () => [currentState, '/drivers#action', pending] as const,
  };
});

const CSRF = 'csrf-token-for-this-session';
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';

function renderForm(state: CreateDriverFormState = { kind: 'IDLE' }, isPending = false) {
  currentState = state;
  pending = isPending;
  return render(<NewDriverForm csrfToken={CSRF} submissionId={SUBMISSION} />);
}

afterEach(() => {
  currentState = { kind: 'IDLE' };
  pending = false;
});

const VALUES = {
  userId: 'USR_01J00000000000000000000000',
  employeeNo: 'EMP-1',
  licenceNumber: 'LIC-1',
  licenceClass: 'B',
  licenceValidTo: '2027-01-01',
  notes: '',
};

describe('the registration form', () => {
  it('carries the session CSRF token and the submission id as hidden fields', () => {
    const { container } = renderForm();
    expect(container.querySelector(`input[name="${CSRF_FIELD}"]`)).toHaveValue(CSRF);
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(SUBMISSION);
  });

  it('reuses the failed attempt’s submission id on a retry', () => {
    const { container } = renderForm({
      kind: 'INVALID',
      submissionId: 'sub_BBBBBBBBBBBBBBBBBBBB',
      values: VALUES,
      fieldErrors: { userId: 'خطا' },
      message: null,
    });
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(
      'sub_BBBBBBBBBBBBBBBBBBBB',
    );
  });

  it('keeps the values typed when the form comes back invalid', () => {
    const { container } = renderForm({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: VALUES,
      fieldErrors: {},
      message: null,
    });
    expect(container.querySelector('[name="employeeNo"]')).toHaveValue(VALUES.employeeNo);
  });

  it('puts a field error under its own field, announced', () => {
    const { getByText, container } = renderForm({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: VALUES,
      fieldErrors: { userId: 'شناسهٔ کاربر معتبر نیست' },
      message: null,
    });
    const message = getByText('شناسهٔ کاربر معتبر نیست');
    expect(message).toHaveAttribute('role', 'alert');
    expect(container.querySelector('[name="userId"]')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows a rule the service stated without naming a field as a banner', () => {
    const { getByText } = renderForm({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: VALUES,
      fieldErrors: {},
      message: 'قانونی که به فیلدی مربوط نیست',
    });
    expect(getByText('قانونی که به فیلدی مربوط نیست')).toBeInTheDocument();
  });

  it('asks the person to sign in again when the session is gone', () => {
    const { getByText } = renderForm({ kind: 'REFUSED', reason: 'NO_SESSION' });
    expect(getByText(/نشست شما پایان یافته است/)).toBeInTheDocument();
  });

  it('shows the correlation id on an outage', () => {
    const { getByText } = renderForm({ kind: 'FAILED', status: 503, correlationId: 'corr-sample' });
    expect(getByText(/corr-sample/)).toBeInTheDocument();
  });

  it('disables the submit button while a submission is in flight', () => {
    const { getByRole } = renderForm({ kind: 'IDLE' }, true);
    expect(getByRole('button', { name: 'در حال ثبت…' })).toBeDisabled();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderForm();
    expect(await axe(container)).toHaveNoViolations();
  });
});
