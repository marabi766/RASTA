import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import { BASELINE_FIELD, CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import { EMPTY_REGISTER_ASSET_FORM } from '@/lib/asset-form-fields';

import { RegisterAssetForm } from './RegisterAssetForm';
import { UpdateAssetForm } from './[id]/UpdateAssetForm';
import type { RegisterAssetFormState } from './form-state';
import type { UpdateAssetFormState } from './[id]/form-state';

/**
 * The two asset write forms, each in every state its own action can put it in.
 * Same technique as `driver-forms.spec.tsx` and `report-form.spec.tsx`:
 * `useActionState` is stubbed so a state can be rendered directly without a
 * server action actually running.
 */

type AnyFormState = RegisterAssetFormState | UpdateAssetFormState;

let currentState: AnyFormState = { kind: 'IDLE' };
let pending = false;

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useActionState: () => [currentState, '/assets#action', pending] as const,
  };
});

const CSRF = 'csrf-token-for-this-session';
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';
const PHYSICAL_DIRECTION = /\b(ml|mr|pl|pr|left|right)-|text-(left|right)/;

afterEach(() => {
  currentState = { kind: 'IDLE' };
  pending = false;
});

describe('RegisterAssetForm', () => {
  function renderForm(state: RegisterAssetFormState = { kind: 'IDLE' }, isPending = false) {
    currentState = state;
    pending = isPending;
    return render(<RegisterAssetForm csrfToken={CSRF} submissionId={SUBMISSION} />);
  }

  it('carries the session CSRF token and the submission id it was rendered with', () => {
    const { container } = renderForm();
    expect(container.querySelector(`input[name="${CSRF_FIELD}"]`)).toHaveValue(CSRF);
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(SUBMISSION);
  });

  it('is a plain form post to a server action, so it works before any bundle loads', () => {
    const { container } = renderForm();
    expect(container.querySelector('form')?.getAttribute('action')).toBe('/assets#action');
  });

  it('labels every control, marking only the name and the type as required', () => {
    renderForm();
    expect(screen.getByLabelText(/نام ماشین/)).toBeRequired();
    expect(screen.getByLabelText(/نوع ماشین/)).toBeRequired();
    for (const label of [
      /شمارهٔ دارایی/,
      /شمارهٔ سریال/,
      /سازنده/,
      /مدل/,
      /سال ساخت/,
      /محل نگهداری/,
      /نشانی/,
    ]) {
      expect(screen.getByLabelText(label)).not.toBeRequired();
    }
  });

  it('offers every asset type the service has, and starts on none of them', () => {
    const { container } = renderForm();
    const type = container.querySelector('[name="type"]') as HTMLSelectElement;
    expect(type).toHaveValue('');
    expect([...type.options].map((option) => option.value).filter(Boolean)).toEqual([
      'GRADER',
      'LOADER',
      'EXCAVATOR',
      'BULLDOZER',
      'TRUCK',
      'LIGHT_TRUCK',
      'TRACTOR',
      'WATER_TANKER',
      'WASTE_COLLECTOR',
      'EMERGENCY_VEHICLE',
      'PASSENGER_VEHICLE',
      'FIXED_EQUIPMENT',
      'OTHER',
    ]);
  });

  it('writes identifiers and the year left to right inside a right-to-left page', () => {
    const { container } = renderForm();
    for (const name of ['assetTag', 'serialNumber', 'manufactureYear']) {
      expect(container.querySelector(`[name="${name}"]`)).toHaveAttribute('dir', 'ltr');
    }
  });

  it('asks for the year with a numeric keypad, and says that the serial cannot change later', () => {
    const { container } = renderForm();
    expect(container.querySelector('[name="manufactureYear"]')).toHaveAttribute(
      'inputmode',
      'numeric',
    );
    expect(screen.getByText('پس از ثبت قابل تغییر نیست')).toBeInTheDocument();
  });

  it('has no coordinate or document field: the portal shows neither back', () => {
    const { container } = renderForm();
    expect(
      container.querySelector('[name="latitude"], [name="longitude"], input[type="file"]'),
    ).toBeNull();
  });

  it('uses no physical-direction utility, so it mirrors with the page', () => {
    const { container } = renderForm();
    expect(container.innerHTML).not.toMatch(PHYSICAL_DIRECTION);
  });

  it('has no accessibility violations', async () => {
    const { container } = renderForm();
    expect(await axe(container)).toHaveNoViolations();
  });

  describe('after an attempt', () => {
    const VALUES = {
      ...EMPTY_REGISTER_ASSET_FORM,
      name: '',
      type: 'LOADER',
      model: 'WA320',
      manufactureYear: '۱۴۰۲',
    };

    it('keeps what was typed and puts each error under its own field', async () => {
      const { container } = renderForm({
        kind: 'INVALID',
        submissionId: 'sub_BBBBBBBBBBBBBBBBBBBB',
        values: VALUES,
        fieldErrors: { name: 'نام دست‌کم ۲ نویسه باشد', manufactureYear: 'سال ساخت معتبر نیست' },
        message: null,
      });

      expect(container.querySelector('[name="type"]')).toHaveValue('LOADER');
      expect(container.querySelector('[name="model"]')).toHaveValue('WA320');
      expect(container.querySelector('[name="manufactureYear"]')).toHaveValue('۱۴۰۲');
      expect(screen.getByText('نام دست‌کم ۲ نویسه باشد')).toBeInTheDocument();
      expect(screen.getByLabelText(/نام ماشین/)).toHaveAttribute('aria-invalid', 'true');
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
        message: 'ماشینی با این شمارهٔ سریال یا شمارهٔ دارایی پیش‌تر ثبت شده است',
      });

      expect(
        screen.getByText('ماشینی با این شمارهٔ سریال یا شمارهٔ دارایی پیش‌تر ثبت شده است'),
      ).toBeInTheDocument();
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
      renderForm({ kind: 'IDLE' }, true);
      expect(screen.getByRole('button', { name: 'در حال ثبت…' })).toBeDisabled();
    });
  });
});

describe('UpdateAssetForm', () => {
  const INITIAL = {
    name: 'لودر کوماتسو',
    assetTag: 'AB-12',
    manufacturer: 'کوماتسو',
    model: 'WA320',
    manufactureYear: '2019',
  };

  function renderForm(state: UpdateAssetFormState = { kind: 'IDLE' }, isPending = false) {
    currentState = state;
    pending = isPending;
    return render(
      <UpdateAssetForm
        assetId="AST_1"
        csrfToken={CSRF}
        submissionId={SUBMISSION}
        baseline="signed-baseline-token"
        initialValues={INITIAL}
      />,
    );
  }

  it('is pre-filled with the machine’s current record, not blank', () => {
    const { container } = renderForm();
    expect(container.querySelector('[name="name"]')).toHaveValue('لودر کوماتسو');
    expect(container.querySelector('[name="assetTag"]')).toHaveValue('AB-12');
    expect(container.querySelector('[name="manufactureYear"]')).toHaveValue('2019');
  });

  it('carries the session CSRF token and a submission id', () => {
    const { container } = renderForm();
    expect(container.querySelector(`input[name="${CSRF_FIELD}"]`)).toHaveValue(CSRF);
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(SUBMISSION);
  });

  it('carries the signed baseline it was drawn from, which the action diffs against', () => {
    const { container } = renderForm();
    expect(container.querySelector(`input[name="${BASELINE_FIELD}"]`)).toHaveValue(
      'signed-baseline-token',
    );
  });

  it('offers no type and no serial number: the service cannot change either', () => {
    const { container } = renderForm();
    expect(container.querySelector('[name="type"]')).toBeNull();
    expect(container.querySelector('[name="serialNumber"]')).toBeNull();
  });

  it('does not put the asset id in the form: it is bound to the action, not collected', () => {
    const { container } = renderForm();
    expect(container.querySelector('[name="id"], [name="assetId"]')).toBeNull();
    expect(container.innerHTML).not.toContain('AST_1');
  });

  it('uses no physical-direction utility, and has no accessibility violations', async () => {
    const { container } = renderForm();
    expect(container.innerHTML).not.toMatch(PHYSICAL_DIRECTION);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('keeps the retried values and submission id when the form comes back invalid', async () => {
    const { container } = renderForm({
      kind: 'INVALID',
      submissionId: 'sub_BBBBBBBBBBBBBBBBBBBB',
      values: { ...INITIAL, name: 'ل', manufactureYear: '99' },
      fieldErrors: { name: 'نام دست‌کم ۲ نویسه باشد', manufactureYear: 'سال ساخت معتبر نیست' },
      message: null,
    });

    expect(container.querySelector('[name="name"]')).toHaveValue('ل');
    expect(screen.getByText('نام دست‌کم ۲ نویسه باشد')).toBeInTheDocument();
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(
      'sub_BBBBBBBBBBBBBBBBBBBB',
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('says a machine that is no longer visible is "not yours or not there", never which', async () => {
    const { container } = renderForm({ kind: 'NOT_FOUND', correlationId: 'corr-404' });
    expect(screen.getByRole('alert')).toHaveTextContent('در دسترس شما نیست یا وجود ندارد');
    expect(screen.getByRole('alert')).toHaveTextContent('corr-404');
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    [{ kind: 'REFUSED', reason: 'NO_SESSION' } as const, /نشست شما پایان یافته/],
    [{ kind: 'REFUSED', reason: 'CSRF' } as const, /معتبر شناخته نشد/],
    [{ kind: 'REFUSED', reason: 'BASELINE' } as const, /این فرم منقضی شده است/],
    [{ kind: 'FORBIDDEN', correlationId: 'corr-403' } as const, /corr-403/],
    [{ kind: 'FAILED', status: 503, correlationId: 'corr-503' } as const, /corr-503/],
    [{ kind: 'UNCONFIRMED', correlationId: 'corr-unk' } as const, /corr-unk/],
  ])('says so in Persian for %j', (state, expected) => {
    renderForm(state);
    expect(screen.getByRole('alert')).toHaveTextContent(expected);
  });

  it('disables the button while a submit is in flight', () => {
    renderForm({ kind: 'IDLE' }, true);
    expect(screen.getByRole('button', { name: 'در حال ذخیره…' })).toBeDisabled();
  });
});
