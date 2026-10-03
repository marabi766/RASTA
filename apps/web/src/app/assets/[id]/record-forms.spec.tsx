import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { POLICY_COVERAGES } from '@/lib/asset-record-fields';

import { RecordInspectionForm, RecordPolicyForm } from './AssetRecordForms';
import type { RecordFormState } from './record-form-state';

/**
 * The two record forms in every state their own actions can put them in.
 * `useActionState` is stubbed so a state can be rendered without a server action
 * running (the technique of `lifecycle-forms.spec.tsx`).
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
jest.mock('./record-actions', () => ({
  submitRecordPolicy: jest.fn(),
  submitRecordInspection: jest.fn(),
}));

const CSRF = 'csrf-token-for-this-session';
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';
const ASSET = 'AST_01J00000000000000000000000';
const IDENTITY = { assetId: ASSET, csrfToken: CSRF, submissionId: SUBMISSION };

/** Physical-direction utilities that would break the right-to-left layout. */
const PHYSICAL_DIRECTION = /\b(?:m[lr]|p[lr]|left|right|text-left|text-right)-/;

afterEach(() => {
  currentState = { kind: 'IDLE' };
  pending = false;
});

function setState(state: RecordFormState<unknown, string>, isPending = false) {
  currentState = state;
  pending = isPending;
}

const FORMS = [
  {
    name: 'the policy form',
    render: () => render(<RecordPolicyForm {...IDENTITY} />),
    button: 'ثبت بیمه‌نامه',
    busy: 'در حال ثبت…',
    fields: ['policyNumber', 'insurerName', 'coverage', 'validFrom', 'validTo'],
  },
  {
    name: 'the inspection form',
    render: () => render(<RecordInspectionForm {...IDENTITY} />),
    button: 'ثبت معاینهٔ فنی',
    busy: 'در حال ثبت…',
    fields: ['certificateNo', 'result', 'inspectedAt', 'validTo'],
  },
] as const;

describe.each(FORMS)('$name', (form) => {
  it('carries the CSRF token and the submission id — and nothing that names an asset', () => {
    const { container } = form.render();
    expect(container.querySelector(`input[name="${CSRF_FIELD}"]`)).toHaveValue(CSRF);
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(SUBMISSION);
    for (const name of ['assetId', 'id', 'asset', 'baseline', 'expectedVersion', 'documentId']) {
      expect(container.querySelector(`[name="${name}"]`)).toBeNull();
    }
  });

  it('is a plain form post to a server action, so it works before any bundle loads', () => {
    const { container } = form.render();
    expect(container.querySelector('form')?.getAttribute('action')).toBe('/assets/AST#action');
  });

  it('stays closed on a fresh page, and opens once an attempt came back', () => {
    const closed = form.render();
    expect(closed.container.querySelector('details')).not.toHaveAttribute('open');
    closed.unmount();

    setState({ kind: 'UNCONFIRMED', correlationId: 'corr' });
    const reopened = form.render();
    expect(reopened.container.querySelector('details')).toHaveAttribute('open');
  });

  it('requires what the service requires', () => {
    const { container } = form.render();
    for (const name of form.fields) {
      expect(container.querySelector(`[name="${name}"]`)).toBeRequired();
    }
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
    [{ kind: 'REFUSED', reason: 'CSRF' } as const, /معتبر شناخته نشد/],
    [{ kind: 'REFUSED', reason: 'SUBMISSION' } as const, /معتبر شناخته نشد/],
    [{ kind: 'FORBIDDEN', correlationId: 'corr-403' } as const, /corr-403/],
    [
      { kind: 'NOT_FOUND', correlationId: 'corr-404' } as const,
      /پیدا نشد یا در سازمان فعال شما نیست/,
    ],
    [{ kind: 'FAILED', status: 503, correlationId: 'corr-503' } as const, /corr-503/],
    [{ kind: 'UNCONFIRMED', correlationId: 'corr-unk' } as const, /corr-unk/],
  ])('says so in Persian for %j', (state, expected) => {
    setState(state);
    form.render();
    expect(screen.getByRole('alert')).toHaveTextContent(expected);
  });

  it('never claims nothing was saved when the outcome is unknown, and does when it is known', () => {
    setState({ kind: 'UNCONFIRMED', correlationId: 'corr-unk' });
    const unknown = form.render();
    expect(screen.getByRole('alert')).not.toHaveTextContent('چیزی ثبت نشد');
    unknown.unmount();

    setState({ kind: 'FAILED', status: 503, correlationId: 'corr-503' });
    form.render();
    expect(screen.getByRole('alert')).toHaveTextContent('چیزی ثبت نشد');
  });

  it('uses no physical-direction utility, and has no accessibility violations', async () => {
    setState({ kind: 'UNCONFIRMED', correlationId: 'corr' });
    const { container } = form.render();
    expect(container.innerHTML).not.toMatch(PHYSICAL_DIRECTION);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the policy form', () => {
  it('offers exactly the service’s coverages, in Persian, with none chosen', () => {
    const { container } = render(<RecordPolicyForm {...IDENTITY} />);
    const select = container.querySelector('select[name="coverage"]') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['', ...POLICY_COVERAGES]);
    expect(select).toHaveValue('');
    expect([...select.options].map((option) => option.text).join(' ')).not.toMatch(/[A-Za-z]/);
  });

  it('takes the two dates as calendar days, and says what the end date means', () => {
    const { container } = render(<RecordPolicyForm {...IDENTITY} />);
    expect(container.querySelector('input[name="validFrom"]')).toHaveAttribute('type', 'date');
    expect(container.querySelector('input[name="validTo"]')).toHaveAttribute('type', 'date');
    expect(screen.getByText(/از آغاز این روز دیگر معتبر شمرده نمی‌شود/)).toBeInTheDocument();
  });

  it('leaves the amounts optional, as the service does', () => {
    const { container } = render(<RecordPolicyForm {...IDENTITY} />);
    expect(container.querySelector('input[name="premium"]')).not.toBeRequired();
    expect(container.querySelector('input[name="insuredValue"]')).not.toBeRequired();
  });

  it('puts the field problems at the fields and keeps what was typed', async () => {
    setState({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: {
        policyNumber: 'ab',
        insurerName: 'بیمه ایران',
        coverage: 'LIABILITY',
        premium: '۱۲۰',
        insuredValue: '',
        validFrom: '2026-10-01',
        validTo: '2026-09-01',
      },
      fieldErrors: {
        policyNumber: 'شمارهٔ بیمه‌نامه دست‌کم ۳ نویسه باشد',
        validTo: 'تاریخ پایان باید پس از تاریخ شروع باشد',
      },
      message: null,
    });
    const { container } = render(<RecordPolicyForm {...IDENTITY} />);
    expect(screen.getByText('شمارهٔ بیمه‌نامه دست‌کم ۳ نویسه باشد')).toBeInTheDocument();
    expect(screen.getByText('تاریخ پایان باید پس از تاریخ شروع باشد')).toBeInTheDocument();
    expect(container.querySelector('input[name="policyNumber"]')).toHaveValue('ab');
    expect(container.querySelector('select[name="coverage"]')).toHaveValue('LIABILITY');
    expect(container.querySelector('input[name="validTo"]')).toHaveValue('2026-09-01');
    expect(container.querySelector('input[name="premium"]')).toHaveValue('۱۲۰');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the inspection form', () => {
  it('offers exactly the service’s results, in Persian, with none chosen', () => {
    const { container } = render(<RecordInspectionForm {...IDENTITY} />);
    const select = container.querySelector('select[name="result"]') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      '',
      'PASSED',
      'CONDITIONAL',
      'FAILED',
    ]);
    expect(select).toHaveValue('');
    expect([...select.options].map((option) => option.text).join(' ')).not.toMatch(/[A-Za-z]/);
  });

  it('says the end date is the next inspection due, and leaves centre and notes optional', () => {
    const { container } = render(<RecordInspectionForm {...IDENTITY} />);
    expect(screen.getByText(/موعد معاینهٔ بعدی/)).toBeInTheDocument();
    expect(container.querySelector('input[name="centerName"]')).not.toBeRequired();
    expect(container.querySelector('textarea[name="notes"]')).not.toBeRequired();
  });

  it('puts the field problems at the fields and keeps what was typed', async () => {
    setState({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: {
        certificateNo: 'INSP-1',
        centerName: '',
        inspectedAt: '2026-09-20',
        validTo: '2026-01-01',
        result: 'FAILED',
        notes: 'لنت',
      },
      fieldErrors: { validTo: 'تاریخ پایان اعتبار باید پس از تاریخ معاینه باشد' },
      message: null,
    });
    const { container } = render(<RecordInspectionForm {...IDENTITY} />);
    expect(screen.getByText('تاریخ پایان اعتبار باید پس از تاریخ معاینه باشد')).toBeInTheDocument();
    expect(container.querySelector('select[name="result"]')).toHaveValue('FAILED');
    expect(container.querySelector('textarea[name="notes"]')).toHaveValue('لنت');
    expect(await axe(container)).toHaveNoViolations();
  });
});
