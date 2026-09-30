import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { EMPTY_REPORT_REQUEST_FORM } from '@/lib/maintenance-fields';

import { ReportRequestForm } from './ReportRequestForm';
import type { ReportRequestFormState } from './form-state';

/**
 * The report form in every state its own action can put it in. Same technique
 * as `driver-forms.spec.tsx`: `useActionState` is stubbed so a state can be
 * rendered directly without a server action actually running.
 */

let currentState: ReportRequestFormState = { kind: 'IDLE' };
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

afterEach(() => {
  currentState = { kind: 'IDLE' };
  pending = false;
});

function renderForm(
  state: ReportRequestFormState = { kind: 'IDLE' },
  options: { pending?: boolean; initialAssetId?: string } = {},
) {
  currentState = state;
  pending = options.pending ?? false;
  return render(
    <ReportRequestForm
      csrfToken={CSRF}
      submissionId={SUBMISSION}
      initialAssetId={options.initialAssetId}
    />,
  );
}

describe('the report form at rest', () => {
  it('carries the session CSRF token and the submission id it was rendered with', () => {
    const { container } = renderForm();
    expect(container.querySelector(`input[name="${CSRF_FIELD}"]`)).toHaveValue(CSRF);
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(SUBMISSION);
  });

  it('is a plain form post to a server action, so it works before any bundle loads', () => {
    const { container } = renderForm();
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    expect(form?.getAttribute('action')).toBe('/maintenance#action');
  });

  it('labels every control, with the machine id, type, title and severity named', () => {
    renderForm();
    expect(screen.getByLabelText(/شناسهٔ ماشین/)).toBeRequired();
    expect(screen.getByLabelText(/نوع کار/)).toBeRequired();
    expect(screen.getByLabelText(/عنوان/)).toBeRequired();
    expect(screen.getByLabelText(/شدت خرابی/)).not.toBeRequired();
    expect(screen.getByLabelText(/شرح/)).toBeInTheDocument();
    expect(screen.getByLabelText(/روزی که ماشین از کار افتاد/)).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText(/مهلت انجام/)).toHaveAttribute('type', 'date');
  });

  it('offers a breakdown by default and every severity, with a blank for planned work', () => {
    const { container } = renderForm();
    expect(container.querySelector('[name="type"]')).toHaveValue('CORRECTIVE');
    const severity = container.querySelector('[name="severity"]') as HTMLSelectElement;
    expect([...severity.options].map((option) => option.value)).toEqual([
      '',
      'LOW',
      'MEDIUM',
      'HIGH',
      'CRITICAL',
    ]);
  });

  it('writes the machine id left to right inside a right-to-left page', () => {
    const { container } = renderForm();
    expect(container.querySelector('[name="assetId"]')).toHaveAttribute('dir', 'ltr');
  });

  it('starts from a machine id it was handed, and from blank otherwise', () => {
    const prefilled = renderForm({ kind: 'IDLE' }, { initialAssetId: 'AST_01JPREFILL' });
    expect(prefilled.container.querySelector('[name="assetId"]')).toHaveValue('AST_01JPREFILL');
    prefilled.unmount();

    const blank = renderForm();
    expect(blank.container.querySelector('[name="assetId"]')).toHaveValue('');
  });

  it('uses no physical-direction utility, so it mirrors with the page', () => {
    const { container } = renderForm();
    expect(container.innerHTML).not.toMatch(/\b(ml|mr|pl|pr|left|right)-|text-(left|right)/);
  });

  it('has no accessibility violations', async () => {
    const { container } = renderForm();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the report form after an attempt', () => {
  const VALUES = {
    ...EMPTY_REPORT_REQUEST_FORM,
    assetId: 'AST_01J00000000000000000000000',
    title: 'نشتی روغن',
    description: 'زیر موتور',
    severity: 'HIGH',
  };

  it('keeps what the person typed and puts each error under its own field', async () => {
    const { container } = renderForm({
      kind: 'INVALID',
      submissionId: 'sub_BBBBBBBBBBBBBBBBBBBB',
      values: { ...VALUES, title: '' },
      fieldErrors: { title: 'عنوان دست‌کم ۲ نویسه باشد' },
      message: null,
    });

    expect(container.querySelector('[name="assetId"]')).toHaveValue(VALUES.assetId);
    expect(container.querySelector('[name="description"]')).toHaveValue('زیر موتور');
    expect(container.querySelector('[name="severity"]')).toHaveValue('HIGH');
    expect(screen.getByText('عنوان دست‌کم ۲ نویسه باشد')).toBeInTheDocument();
    expect(screen.getByLabelText(/عنوان/)).toHaveAttribute('aria-invalid', 'true');
    // The retry reuses the id this attempt carried, not a fresh one.
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(
      'sub_BBBBBBBBBBBBBBBBBBBB',
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows a rule the service did not attach to a field as a message for the form', async () => {
    const { container } = renderForm({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: VALUES,
      fieldErrors: {},
      message: 'این ماشین همین حالا یک درخواست باز از همین نوع دارد.',
    });

    expect(
      screen.getByText('این ماشین همین حالا یک درخواست باز از همین نوع دارد.'),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows the duplicate-open-request refusal as a message and does not invent a link to it', () => {
    // maintenance-service names the existing request only in `internalContext`,
    // which the error filter logs and never sends, so the portal has no id to
    // link to. A link built from anything else would be a guess; until the
    // service sends the id, the message stands alone.
    renderForm({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: VALUES,
      fieldErrors: {},
      message: 'این ماشین همین حالا یک درخواست باز از همین نوع دارد.',
    });

    const banner = screen.getByText('این ماشین همین حالا یک درخواست باز از همین نوع دارد.');
    expect(banner.closest('[role="alert"]')).not.toBeNull();
    expect(banner.closest('[role="alert"]')?.querySelector('a')).toBeNull();
  });

  it('says a machine that is not visible is "not yours or not there", never which', async () => {
    const { container } = renderForm({
      kind: 'NOT_FOUND',
      submissionId: 'sub_CCCCCCCCCCCCCCCCCCCC',
      values: VALUES,
      correlationId: 'corr-1',
    });

    expect(screen.getByText('این ماشین در دسترس شما نیست یا وجود ندارد')).toBeInTheDocument();
    expect(container.querySelector('[name="assetId"]')).toHaveValue(VALUES.assetId);
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(
      'sub_CCCCCCCCCCCCCCCCCCCC',
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    [{ kind: 'REFUSED', reason: 'NO_SESSION' } as const, /نشست شما پایان یافته/],
    [{ kind: 'REFUSED', reason: 'CSRF' } as const, /معتبر شناخته نشد/],
    [{ kind: 'REFUSED', reason: 'SUBMISSION' } as const, /معتبر شناخته نشد/],
    [{ kind: 'FORBIDDEN', correlationId: 'corr-403' } as const, /corr-403/],
    [{ kind: 'FAILED', status: 503, correlationId: 'corr-503' } as const, /corr-503/],
    [{ kind: 'UNCONFIRMED', correlationId: 'corr-unk' } as const, /corr-unk/],
  ])('says so in Persian for %j', async (state, expected) => {
    const { container } = renderForm(state);
    expect(screen.getByRole('alert')).toHaveTextContent(expected);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('never tells the person nothing was saved when that is not known', () => {
    renderForm({ kind: 'UNCONFIRMED', correlationId: 'corr-unk' });
    expect(screen.getByRole('alert').textContent).not.toMatch(/چیزی ذخیره نشد/);
  });

  it('disables the button while a submit is in flight', () => {
    renderForm({ kind: 'IDLE' }, { pending: true });
    expect(screen.getByRole('button', { name: 'در حال ثبت…' })).toBeDisabled();
  });
});
