import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

import { DriversScreen } from './DriversScreen';
import { NewDriverForm } from './NewDriverForm';
import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import type { DriverPicker } from '@/lib/driver-fields';
import { NOT_A_MEMBER_TEXT, type DriverPage, type ReadResult } from '@/server/drivers';
import type { RosterPerson } from '@/server/driver-roster';
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

  describe('names, when the whole member list was read (task 095)', () => {
    const names = new Map<string, RosterPerson>([
      ['USR_9', { userId: 'USR_9', name: 'مریم کاظمی', username: 'maryam.k' }],
    ]);
    const formerMember = { ...DRIVER, id: 'DRV_2', userId: 'USR_GONE', employeeNo: 'EMP-2' };

    it('shows each driver’s name and username, and says so for one not in the member list', () => {
      const { getByRole } = render(
        <DriversScreen result={page({ items: [DRIVER, formerMember] })} query={{}} names={names} />,
      );
      expect(getByRole('columnheader', { name: 'نام' })).toBeInTheDocument();
      const row = getByRole('row', { name: /EMP-1/ });
      expect(row).toHaveTextContent('مریم کاظمی');
      expect(row).toHaveTextContent('maryam.k');
      expect(getByRole('row', { name: /EMP-2/ })).toHaveTextContent(
        'در فهرست اعضای این سازمان نیست',
      );
    });

    it('has no name column without the member list (a fleet manager’s view)', () => {
      const { queryByRole } = render(<DriversScreen result={page()} query={{}} names={null} />);
      expect(queryByRole('columnheader', { name: 'نام' })).toBeNull();
    });

    it('drops bidi controls from a stored name', () => {
      const spoofed = new Map<string, RosterPerson>([
        ['USR_9', { userId: 'USR_9', name: 'علی\u202eرضا', username: 'ali\u2066x' }],
      ]);
      const { getByRole } = render(<DriversScreen result={page()} query={{}} names={spoofed} />);
      const row = getByRole('row', { name: /EMP-1/ });
      expect(row.textContent).not.toMatch(/\p{Bidi_Control}/u);
      expect(row).toHaveTextContent('علیرضا');
    });

    it('has no accessibility violations with the name column', async () => {
      const { container } = render(
        <DriversScreen result={page({ items: [DRIVER, formerMember] })} query={{}} names={names} />,
      );
      expect(await axe(container)).toHaveNoViolations();
    });
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

const ID_FIELD: DriverPicker = { kind: 'ID', reason: 'NOT_ALLOWED' };

function renderForm(
  state: CreateDriverFormState = { kind: 'IDLE' },
  isPending = false,
  picker: DriverPicker = ID_FIELD,
) {
  currentState = state;
  pending = isPending;
  return render(<NewDriverForm csrfToken={CSRF} submissionId={SUBMISSION} picker={picker} />);
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

  it('a session only unavailable: says so, not "ended", with no accessibility violations', async () => {
    const { container, getByText, queryByText } = renderForm({
      kind: 'REFUSED',
      reason: 'SESSION_UNAVAILABLE',
    });
    expect(getByText(/همین حالا در دسترس نیست/)).toBeInTheDocument();
    expect(queryByText(/پایان یافته/)).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows the correlation id on an outage', () => {
    const { getByText } = renderForm({ kind: 'FAILED', status: 503, correlationId: 'corr-sample' });
    expect(getByText(/corr-sample/)).toBeInTheDocument();
  });

  it('says an unconfirmed write may have been saved, and never that nothing was', () => {
    const { container, getByText } = renderForm({
      kind: 'UNCONFIRMED',
      correlationId: 'corr-sample',
    });
    expect(getByText(/نتوانستیم بدانیم که این درخواست ثبت شد یا نه/)).toBeInTheDocument();
    expect(getByText(/صفحه را تازه کنید/)).toBeInTheDocument();
    expect(getByText(/corr-sample/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/چیزی ذخیره نشد|ثبت انجام نشد/);
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

describe('who to register: the member picker (task 095)', () => {
  const PICK: DriverPicker = {
    kind: 'PICK',
    candidates: [
      { userId: 'USR_01J00000000000000000000000', name: 'مریم کاظمی', username: 'maryam.k' },
      { userId: 'USR_01J00000000000000000000001', name: 'رضا نادری', username: 'reza.n' },
    ],
  };

  it('offers the members by name and username, and sends the user id', () => {
    const { container, getByRole } = renderForm({ kind: 'IDLE' }, false, PICK);
    const select = getByRole('combobox', { name: /عضو سازمان/ });
    expect(select).toHaveAttribute('name', 'userId');
    expect(select).toBeRequired();
    expect(getByRole('option', { name: 'مریم کاظمی — maryam.k' })).toHaveValue(
      'USR_01J00000000000000000000000',
    );
    expect(getByRole('option', { name: 'رضا نادری — reza.n' })).toHaveValue(
      'USR_01J00000000000000000000001',
    );
    // Nothing to type: no free-text id field beside the picker.
    expect(container.querySelector('input[name="userId"]')).toBeNull();
  });

  it('starts on no one, so a person is chosen rather than defaulted', () => {
    const { getByRole } = renderForm({ kind: 'IDLE' }, false, PICK);
    expect(getByRole('combobox', { name: /عضو سازمان/ })).toHaveValue('');
  });

  it('keeps the chosen member and shows the refusal in Persian under the picker', () => {
    const { getByRole, getByText } = renderForm(
      {
        kind: 'INVALID',
        submissionId: SUBMISSION,
        values: { ...VALUES, userId: 'USR_01J00000000000000000000001' },
        fieldErrors: { userId: NOT_A_MEMBER_TEXT },
        message: null,
      },
      false,
      PICK,
    );
    const select = getByRole('combobox', { name: /عضو سازمان/ });
    expect(select).toHaveValue('USR_01J00000000000000000000001');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(getByText(NOT_A_MEMBER_TEXT)).toHaveAttribute('role', 'alert');
  });

  it('drops bidi controls from a stored name in an option', () => {
    const { getAllByRole } = renderForm({ kind: 'IDLE' }, false, {
      kind: 'PICK',
      candidates: [{ userId: 'USR_X', name: 'علی\u202eرضا', username: 'ali' }],
    });
    for (const option of getAllByRole('option')) {
      expect(option.textContent).not.toMatch(/\p{Bidi_Control}/u);
    }
  });

  it.each([
    ['NOT_ALLOWED', /از مدیر سازمان بگیرید/],
    ['INCOMPLETE', /کامل نشان داده شود/],
    ['UNAVAILABLE', /اکنون خوانده نشد/],
  ] as const)('keeps the id field, saying why, when the picker is %s', (reason, hint) => {
    const { container, getByText, queryByRole } = renderForm({ kind: 'IDLE' }, false, {
      kind: 'ID',
      reason,
    });
    expect(container.querySelector('input[name="userId"]')).not.toBeNull();
    expect(queryByRole('combobox', { name: /عضو سازمان/ })).toBeNull();
    expect(getByText(hint)).toBeInTheDocument();
  });

  it('has no accessibility violations with the picker', async () => {
    const { container } = renderForm({ kind: 'IDLE' }, false, PICK);
    expect(await axe(container)).toHaveNoViolations();
  });
});
