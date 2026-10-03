import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import { BASELINE_FIELD, CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';

import {
  CancelRepairForm,
  CompleteRepairForm,
  RecordCostForm,
  RecordLabourForm,
  RecordPartForm,
  StartRepairForm,
} from './RepairOrderForms';
import type { RequestCommandFormState } from './form-state';

/**
 * The six repair-order forms in every state their own actions can put them in.
 * `useActionState` is stubbed so a state can be rendered without a server
 * action running (the technique of `request-command-forms.spec.tsx`).
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
const IDENTITY = {
  csrfToken: CSRF,
  submissionId: SUBMISSION,
  requestId: REQUEST,
  baseline: BASELINE,
};

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
    name: 'the start form',
    render: () => render(<StartRepairForm {...IDENTITY} />),
    button: 'آغاز تعمیر',
    busy: 'در حال آغاز…',
  },
  {
    name: 'the complete form',
    render: () => render(<CompleteRepairForm {...IDENTITY} totalCostMinor="750000" />),
    button: 'تکمیل تعمیر',
    busy: 'در حال تکمیل…',
  },
  {
    name: 'the withdraw form',
    render: () => render(<CancelRepairForm {...IDENTITY} />),
    button: 'پس‌گرفتن ارجاع',
    busy: 'در حال لغو…',
  },
  {
    name: 'the part form',
    render: () => render(<RecordPartForm {...IDENTITY} />),
    button: 'ثبت قطعه',
    busy: 'در حال ثبت…',
  },
  {
    name: 'the labour form',
    render: () => render(<RecordLabourForm {...IDENTITY} />),
    button: 'ثبت اجرت',
    busy: 'در حال ثبت…',
  },
  {
    name: 'the cost form',
    render: () => render(<RecordCostForm {...IDENTITY} />),
    button: 'ثبت هزینه',
    busy: 'در حال ثبت…',
  },
] as const;

describe.each(FORMS)('$name', (form) => {
  it('carries the CSRF token, the submission id, the request, and the signed baseline', () => {
    const { container } = form.render();
    expect(container.querySelector(`input[name="${CSRF_FIELD}"]`)).toHaveValue(CSRF);
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(SUBMISSION);
    expect(container.querySelector('input[name="requestId"]')).toHaveValue(REQUEST);
    const baseline = container.querySelector(`input[name="${BASELINE_FIELD}"]`);
    expect(baseline).toHaveValue(BASELINE);
    expect(baseline).toHaveAttribute('type', 'hidden');
  });

  it('has no field a person could use to name another order or another amount', () => {
    const { container } = form.render();
    for (const name of ['repairOrderId', 'orderId', 'expectedTotalCostMinor', 'totalCostMinor']) {
      expect(container.querySelector(`[name="${name}"]`)).toBeNull();
    }
  });

  it('is a plain form post to a server action, so it works before any bundle loads', () => {
    const { container } = form.render();
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
    [{ kind: 'REFUSED', reason: 'BASELINE' } as const, /منقضی شده است/],
    [{ kind: 'REFUSED', reason: 'CSRF' } as const, /معتبر شناخته نشد/],
    [{ kind: 'FORBIDDEN', correlationId: 'corr-403' } as const, /corr-403/],
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

describe('the forms that stay closed until asked for', () => {
  it.each([
    ['withdraw', () => render(<CancelRepairForm {...IDENTITY} />)],
    ['part', () => render(<RecordPartForm {...IDENTITY} />)],
    ['labour', () => render(<RecordLabourForm {...IDENTITY} />)],
    ['cost', () => render(<RecordCostForm {...IDENTITY} />)],
  ])('keeps %s closed on a fresh page, and open once an attempt came back', (_name, draw) => {
    const closed = draw();
    expect(closed.container.querySelector('details')).not.toHaveAttribute('open');
    closed.unmount();

    setState({ kind: 'FAILED', status: 503, correlationId: 'corr-503' });
    const opened = draw();
    expect(opened.container.querySelector('details')).toHaveAttribute('open');
  });
});

describe('the complete form', () => {
  it('says what completing closes, with the total as the screen shows it', () => {
    render(<CompleteRepairForm {...IDENTITY} totalCostMinor="750000" />);
    expect(screen.getByText(/۷۵۰٬۰۰۰ ریال/)).toBeInTheDocument();
    expect(screen.getByLabelText(/شرح کار انجام‌شده/)).toBeRequired();
  });

  it('puts a field problem at the field and keeps what was typed', async () => {
    setState({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: { workPerformed: 'ب' },
      fieldErrors: { workPerformed: 'شرح کار انجام‌شده دست‌کم ۲ نویسه باشد' },
      message: null,
    });
    const { container } = render(<CompleteRepairForm {...IDENTITY} totalCostMinor="0" />);
    expect(screen.getByText('شرح کار انجام‌شده دست‌کم ۲ نویسه باشد')).toBeInTheDocument();
    expect(container.querySelector('textarea[name="workPerformed"]')).toHaveValue('ب');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the part form', () => {
  it('offers every source the service knows, in Persian, with the workshop’s own as the default', () => {
    const { container } = render(<RecordPartForm {...IDENTITY} />);
    const select = container.querySelector('select[name="source"]') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      'INVENTORY',
      'MARKETPLACE',
      'WORKSHOP_SUPPLIED',
      'OTHER',
    ]);
    expect(select).toHaveValue('WORKSHOP_SUPPLIED');
    expect([...select.options].map((option) => option.text).join(' ')).not.toMatch(/[A-Za-z]/);
  });

  it('reads amounts as left-to-right numbers, and the rial as the unit in the labels', () => {
    const { container } = render(<RecordPartForm {...IDENTITY} />);
    for (const name of ['quantity', 'unitCostMinor']) {
      expect(container.querySelector(`input[name="${name}"]`)).toHaveAttribute('dir', 'ltr');
    }
    expect(screen.getByLabelText(/بهای هر واحد \(ریال\)/)).toBeRequired();
  });

  it('puts the service’s per-field problems at the field, in Persian, keeping what was typed', async () => {
    setState({
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: {
        partName: 'فیلتر',
        partReference: '',
        quantity: '0',
        unit: 'عدد',
        unitCostMinor: '5',
        source: 'OTHER',
        sourceReference: '',
      },
      fieldErrors: { quantity: 'تعداد باید بیشتر از صفر باشد' },
      message: null,
    });
    const { container } = render(<RecordPartForm {...IDENTITY} />);
    expect(screen.getByText('تعداد باید بیشتر از صفر باشد')).toBeInTheDocument();
    expect(container.querySelector('input[name="partName"]')).toHaveValue('فیلتر');
    expect(container.querySelector('select[name="source"]')).toHaveValue('OTHER');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the cost form', () => {
  it('offers the three categories a person may post, and never PART or LABOUR', () => {
    const { container } = render(<RecordCostForm {...IDENTITY} />);
    const select = container.querySelector('select[name="category"]') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      'SERVICE',
      'EXTERNAL_REPAIR',
      'OTHER',
    ]);
  });
});

describe('the labour form', () => {
  it('says that the technician is free text, with no account needed', () => {
    render(<RecordLabourForm {...IDENTITY} />);
    expect(screen.getByText(/نیازی به حساب در سامانه ندارد/)).toBeInTheDocument();
  });
});
