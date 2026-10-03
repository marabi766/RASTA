import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import { BASELINE_FIELD, CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';

import { ActivateAssetForm, ChangeStatusForm, DecommissionAssetForm } from './AssetLifecycleForms';
import { LifecycleControls } from './LifecycleControls';
import type { LifecycleFormState } from './lifecycle-form-state';

/**
 * The three lifecycle forms in every state their own actions can put them in.
 * `useActionState` is stubbed so a state can be rendered without a server
 * action running (the technique of `repair-order-forms.spec.tsx`).
 */

let currentState: LifecycleFormState<unknown, string> = { kind: 'IDLE' };
let pending = false;

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useActionState: () => [currentState, '/assets/AST#action', pending] as const,
  };
});
// The forms import the server actions only to hand them to `useActionState`.
jest.mock('./lifecycle-actions', () => ({
  submitActivateAsset: jest.fn(),
  submitChangeStatus: jest.fn(),
  submitDecommission: jest.fn(),
}));

const CSRF = 'csrf-token-for-this-session';
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';
const BASELINE = 'signed-baseline-token';
const NAME = 'لودر کوماتسو';
const IDENTITY = { csrfToken: CSRF, submissionId: SUBMISSION, baseline: BASELINE };

/** Physical-direction utilities that would break the right-to-left layout. */
const PHYSICAL_DIRECTION = /\b(?:m[lr]|p[lr]|left|right|text-left|text-right)-/;

afterEach(() => {
  currentState = { kind: 'IDLE' };
  pending = false;
});

function setState(state: LifecycleFormState<unknown, string>, isPending = false) {
  currentState = state;
  pending = isPending;
}

const FORMS = [
  {
    name: 'the activate form',
    render: () => render(<ActivateAssetForm {...IDENTITY} />),
    button: 'فعال‌سازی دارایی',
    busy: 'در حال فعال‌سازی…',
  },
  {
    name: 'the change-status form',
    render: () =>
      render(
        <ChangeStatusForm
          {...IDENTITY}
          currentStatus="ACTIVE"
          targets={['IDLE', 'OUT_OF_SERVICE']}
        />,
      ),
    button: 'ثبت تغییر وضعیت',
    busy: 'در حال ثبت…',
  },
  {
    name: 'the decommission form',
    render: () => render(<DecommissionAssetForm {...IDENTITY} assetName={NAME} />),
    button: 'اسقاط قطعی دارایی',
    busy: 'در حال اسقاط…',
  },
] as const;

describe.each(FORMS)('$name', (form) => {
  it('carries the CSRF token, the submission id and the signed baseline — and nothing that names an asset or a version', () => {
    const { container } = form.render();
    expect(container.querySelector(`input[name="${CSRF_FIELD}"]`)).toHaveValue(CSRF);
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(SUBMISSION);
    const baseline = container.querySelector(`input[name="${BASELINE_FIELD}"]`);
    expect(baseline).toHaveValue(BASELINE);
    expect(baseline).toHaveAttribute('type', 'hidden');
    for (const name of ['assetId', 'id', 'expectedVersion', 'version', 'status-from']) {
      expect(container.querySelector(`[name="${name}"]`)).toBeNull();
    }
  });

  it('is a plain form post to a server action, so it works before any bundle loads', () => {
    const { container } = form.render();
    expect(container.querySelector('form')?.getAttribute('action')).toBe('/assets/AST#action');
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
    [{ kind: 'REFUSED', reason: 'BASELINE' } as const, /منقضی شده است/],
    [{ kind: 'REFUSED', reason: 'CSRF' } as const, /معتبر شناخته نشد/],
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

describe('the activate form', () => {
  it('says what activation needs, so a refusal is not a surprise', () => {
    render(<ActivateAssetForm {...IDENTITY} />);
    expect(screen.getByText(/بیمه‌نامهٔ معتبر و سند مالکیت/)).toBeInTheDocument();
  });

  it('has nothing to type: only the button', () => {
    const { container } = render(<ActivateAssetForm {...IDENTITY} />);
    expect(container.querySelectorAll('input:not([type="hidden"]), textarea, select')).toHaveLength(
      0,
    );
  });
});

describe('the change-status form', () => {
  it('offers exactly the statuses it was given, in Persian, and the status it was drawn from', () => {
    const { container } = render(
      <ChangeStatusForm
        {...IDENTITY}
        currentStatus="ACTIVE"
        targets={['IDLE', 'OUT_OF_SERVICE']}
      />,
    );
    const select = container.querySelector('select[name="status"]') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      '',
      'IDLE',
      'OUT_OF_SERVICE',
    ]);
    expect([...select.options].map((option) => option.text).join(' ')).not.toMatch(/[A-Za-z]/);
    expect(screen.getByText(/وضعیت فعلی/)).toHaveTextContent('فعال');
  });

  it('starts with no status chosen, so a status is never changed by an unread default', () => {
    const { container } = render(
      <ChangeStatusForm {...IDENTITY} currentStatus="ACTIVE" targets={['IDLE']} />,
    );
    expect(container.querySelector('select[name="status"]')).toHaveValue('');
  });

  it('requires both fields, and says why the reason is asked', () => {
    render(<ChangeStatusForm {...IDENTITY} currentStatus="ACTIVE" targets={['IDLE']} />);
    expect(screen.getByLabelText(/وضعیت تازه/)).toBeRequired();
    expect(screen.getByLabelText(/دلیل تغییر/)).toBeRequired();
    expect(screen.getByText(/در پروندهٔ دارایی و تاریخچهٔ آن ثبت می‌شود/)).toBeInTheDocument();
  });

  it('puts the field problems at the fields and keeps what was typed', async () => {
    setState({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: { status: 'IDLE', reason: 'ب' },
      fieldErrors: { reason: 'دلیل تغییر دست‌کم ۳ نویسه باشد' },
      message: null,
    });
    const { container } = render(
      <ChangeStatusForm {...IDENTITY} currentStatus="ACTIVE" targets={['IDLE']} />,
    );
    expect(screen.getByText('دلیل تغییر دست‌کم ۳ نویسه باشد')).toBeInTheDocument();
    expect(container.querySelector('textarea[name="reason"]')).toHaveValue('ب');
    expect(container.querySelector('select[name="status"]')).toHaveValue('IDLE');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the decommission form', () => {
  it('stays closed on a fresh page, and opens once an attempt came back', () => {
    const closed = render(<DecommissionAssetForm {...IDENTITY} assetName={NAME} />);
    expect(closed.container.querySelector('details')).not.toHaveAttribute('open');
    closed.unmount();

    setState({ kind: 'FAILED', status: 503, correlationId: 'corr-503' });
    const opened = render(<DecommissionAssetForm {...IDENTITY} assetName={NAME} />);
    expect(opened.container.querySelector('details')).toHaveAttribute('open');
  });

  it('names the machine and says it cannot be undone, before the reason is asked', () => {
    render(<DecommissionAssetForm {...IDENTITY} assetName={NAME} />);
    expect(screen.getByText(`اسقاط «${NAME}»`)).toBeInTheDocument();
    expect(screen.getByText(/نهایی و بازگشت‌ناپذیر است/)).toBeInTheDocument();
    expect(screen.getByText(/به‌جای اسقاط وضعیت را «خارج از سرویس» کنید/)).toBeInTheDocument();
  });

  it('asks for an explicit tick that names the machine, unticked by default', () => {
    const { container } = render(<DecommissionAssetForm {...IDENTITY} assetName={NAME} />);
    const tick = screen.getByRole('checkbox', {
      name: `می‌دانم که اسقاط «${NAME}» بازگشت‌ناپذیر است.`,
    });
    expect(tick).toBeRequired();
    expect(tick).not.toBeChecked();
    expect(container.querySelector('input[name="confirm"]')).toHaveAttribute('value', 'yes');
    expect(screen.getByLabelText(/دلیل اسقاط/)).toBeRequired();
  });

  it('shows the missing confirmation at the tick, linked to it, and keeps the reason', async () => {
    setState({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: { reason: 'فرسودگی کامل ماشین', confirm: '' },
      fieldErrors: { confirm: 'برای اسقاط باید تأیید کنید که پیامد آن را می‌دانید' },
      message: null,
    });
    const { container } = render(<DecommissionAssetForm {...IDENTITY} assetName={NAME} />);
    const tick = screen.getByRole('checkbox');
    expect(tick).toHaveAttribute('aria-invalid', 'true');
    expect(tick).toHaveAccessibleDescription('برای اسقاط باید تأیید کنید که پیامد آن را می‌دانید');
    expect(container.querySelector('textarea[name="reason"]')).toHaveValue('فرسودگی کامل ماشین');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders a name that contains markup as text, never as markup', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { container } = render(<DecommissionAssetForm {...IDENTITY} assetName={hostile} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain(hostile);
  });
});

describe('LifecycleControls', () => {
  const token = (n: string) => ({ submissionId: `sub_${n.repeat(20)}`, baseline: `baseline-${n}` });

  it('draws exactly the commands it was given a baseline for, each with its own', () => {
    const { container } = render(
      <LifecycleControls
        assetName={NAME}
        status="ACTIVE"
        csrfToken={CSRF}
        tokens={{ status: token('A'), decommission: token('B') }}
      />,
    );
    expect(screen.queryByRole('heading', { name: 'فعال‌سازی' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'تغییر وضعیت' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'اسقاط' })).toBeInTheDocument();
    const baselines = [...container.querySelectorAll(`input[name="${BASELINE_FIELD}"]`)].map(
      (input) => (input as HTMLInputElement).value,
    );
    expect(baselines).toEqual(['baseline-A', 'baseline-B']);
  });

  it('draws nothing for a command without a baseline, however the status reads', () => {
    const { container } = render(
      <LifecycleControls assetName={NAME} status="REGISTERED" csrfToken={CSRF} tokens={{}} />,
    );
    expect(container.querySelector('form')).toBeNull();
  });

  it('draws no status form when the status leaves no target', () => {
    const { container } = render(
      <LifecycleControls
        assetName={NAME}
        status="DECOMMISSIONED"
        csrfToken={CSRF}
        tokens={{ status: token('A') }}
      />,
    );
    expect(container.querySelector('form')).toBeNull();
  });

  describe.each([
    ['ASSIGNED', 'این دارایی تخصیص باز دارد', '/drivers'],
    ['IN_MAINTENANCE', 'این دارایی در تعمیر است', '/maintenance'],
  ] as const)('an asset with open work (%s) — docs/24 Q-94', (status, title, href) => {
    it('says whose work it is and where to end it, and draws no form', () => {
      const { container } = render(
        <LifecycleControls assetName={NAME} status={status} csrfToken={CSRF} tokens={{}} />,
      );
      expect(screen.getByText(title)).toBeInTheDocument();
      expect(screen.getByText(/وضعیت یا اسقاط آن از اینجا ممکن نیست/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'رفتن به بخش مربوط' })).toHaveAttribute('href', href);
      expect(container.querySelector('form')).toBeNull();
      expect(container.querySelector('button')).toBeNull();
    });

    it('draws no status form even if it was handed a baseline for one', () => {
      const { container } = render(
        <LifecycleControls
          assetName={NAME}
          status={status}
          csrfToken={CSRF}
          tokens={{ status: token('A') }}
        />,
      );
      expect(container.querySelector('form')).toBeNull();
    });

    it('has no accessibility violations', async () => {
      const { container } = render(
        <LifecycleControls assetName={NAME} status={status} csrfToken={CSRF} tokens={{}} />,
      );
      expect(await axe(container)).toHaveNoViolations();
    });
  });

  it('says nothing about open work for an asset that has none', () => {
    render(
      <LifecycleControls
        assetName={NAME}
        status="ACTIVE"
        csrfToken={CSRF}
        tokens={{ status: token('A') }}
      />,
    );
    expect(screen.queryByText(/تخصیص باز دارد|در تعمیر است/)).toBeNull();
  });

  it('has no accessibility violations with every command drawn', async () => {
    const { container } = render(
      <LifecycleControls
        assetName={NAME}
        status="REGISTERED"
        csrfToken={CSRF}
        tokens={{ activate: token('A'), status: token('B'), decommission: token('C') }}
      />,
    );
    expect(container.innerHTML).not.toMatch(PHYSICAL_DIRECTION);
    expect(await axe(container)).toHaveNoViolations();
  });
});
