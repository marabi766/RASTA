import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import { EMPTY_DISPUTE_FORM, type DisputeCommand } from '@/lib/transaction-dispute-fields';
import type { ReadResult, Transaction } from '@/server/transactions';

import { TransactionDetailScreen } from './[id]/TransactionDetailScreen';
import { DisputeCommandForm } from './[id]/DisputeCommandForm';
import type { DisputeFormState } from './[id]/form-state';

/**
 * What `/transactions/[id]` renders: every outcome the read can hand back, the
 * dispute state exactly as the record says it, money as a Persian-digit decimal
 * string, Jalali dates, no raw service text — and each dispute form in every
 * state its action can put it in. One jest-axe check per state.
 *
 * `useActionState` is stubbed so a form state can be rendered directly (the
 * technique of `place-order-form.spec.tsx`); `dispute-retry.spec.tsx` drives
 * the real hook.
 */

let formState: DisputeFormState = { kind: 'IDLE' };
let pending = false;

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useActionState: () => [formState, '/transactions/TXN_1#action', pending] as const,
  };
});

jest.mock('./[id]/actions', () => ({ submitDisputeCommand: jest.fn() }));

// A plain anchor: `next/link` prefetches through an intersection observer whose
// state updates land outside `act` and drown the output in warnings.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  formState = { kind: 'IDLE' };
  pending = false;
});

const CSRF = 'csrf-token-for-this-session';
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';
const REASON = 'کالا تحویل نشده و پاسخی هم نیامده است';

const HELD: Transaction = {
  id: 'TXN_1',
  organizationId: 'ORG-DEH-0001',
  counterpartyOrganizationId: 'ORG-DEH-0002',
  transactionType: 'MAINTENANCE_SERVICE',
  status: 'HELD',
  grossAmountMinor: '90071992547409931234',
  commissionAmountMinor: '0',
  netAmountMinor: '90071992547409931234',
  currency: 'IRR',
  occurredAt: '2026-10-01T08:00:00.000Z',
  sourceType: 'E2E',
  sourceReference: 'ref-1',
  disputedAt: null,
  disputeReason: null,
  settledAt: null,
  failureReason: null,
  createdAt: '2026-10-01T08:00:01.000Z',
  settlement: null,
};

const DISPUTED: Transaction = {
  ...HELD,
  status: 'DISPUTED',
  disputedAt: '2026-10-02T09:00:00.000Z',
  disputeReason: REASON,
};

const ok = (data: Transaction): ReadResult<Transaction> => ({ kind: 'OK', data });

function renderScreen(
  result: ReadResult<Transaction>,
  commands: readonly DisputeCommand[] = [],
  done?: DisputeCommand,
) {
  return render(
    <TransactionDetailScreen
      result={result}
      commands={commands}
      csrfToken={CSRF}
      mintSubmissionId={() => SUBMISSION}
      done={done}
    />,
  );
}

async function expectAccessible(container: HTMLElement) {
  expect(await axe(container)).toHaveNoViolations();
}

describe('the transaction', () => {
  it('shows its money digit for digit in Persian, and its dates in the Jalali calendar', async () => {
    const { container } = renderScreen(ok(HELD), ['DISPUTE']);
    const text = container.textContent ?? '';
    expect(text).toContain('۹۰٬۰۷۱٬۹۹۲٬۵۴۷٬۴۰۹٬۹۳۱٬۲۳۴');
    expect(text).not.toMatch(/9007199254740993/);
    expect(text).toContain('۱۴۰۵');
    expect(text).toContain('ORG-DEH-0001');
    expect(text).toContain('ORG-DEH-0002');
    await expectAccessible(container);
  });

  it('says no bank is behind it, and never claims payment', () => {
    const { container } = renderScreen(ok(HELD));
    expect(container.textContent).toContain('به هیچ بانک یا درگاه واقعی متصل نیست');
    expect(container.textContent).not.toMatch(/پرداخت امن|درگاه پرداخت|کارت بانکی/);
  });

  it('links its settlement, and says a missing payee rather than hiding the row', async () => {
    const { container, getByRole } = renderScreen(
      ok({
        ...HELD,
        status: 'SETTLED',
        counterpartyOrganizationId: null,
        settledAt: '2026-10-03T09:00:00.000Z',
        settlement: { id: 'SET_1', settledAt: '2026-10-03T09:00:00.000Z' },
      }),
    );
    expect(getByRole('link', { name: 'SET_1' })).toHaveAttribute('href', '/settlements/SET_1');
    expect(container.textContent).toContain('ثبت نشده');
    await expectAccessible(container);
  });

  it('isolates stored free text and strips its bidi controls', () => {
    const { container } = renderScreen(ok({ ...DISPUTED, disputeReason: 'دلیل ‮برعکس‬ اینجا' }));
    expect(container.textContent).not.toMatch(/[‪-‮⁦-⁩]/);
    expect(container.querySelector('bdi[dir="auto"]')).not.toBeNull();
  });
});

describe('the dispute state, as the record says it', () => {
  it('no dispute: says so, and offers the payer the form', async () => {
    const { container, getByRole } = renderScreen(ok(HELD), ['DISPUTE']);
    expect(container.textContent).toContain('اعتراضی ثبت نشده است');
    expect(getByRole('form', { name: 'ثبت اعتراض' })).toBeInTheDocument();
    await expectAccessible(container);
  });

  it('no dispute, and no command for this viewer: no form at all', async () => {
    const { container, queryByRole } = renderScreen(ok(HELD));
    expect(queryByRole('form')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    await expectAccessible(container);
  });

  it('disputed: the halt, when, and why — with no deadline and no automatic release', async () => {
    const { container, queryByRole } = renderScreen(ok(DISPUTED));
    const text = container.textContent ?? '';
    expect(text).toContain('تسویهٔ آن متوقف است');
    expect(text).toContain(REASON);
    expect(text).toContain('هیچ مهلت یا سازوکار خودکاری');
    expect(text).not.toMatch(/مهلت\s+\S+\s+روز|به‌طور خودکار (تسویه|آزاد)/);
    expect(queryByRole('form')).toBeNull();
    await expectAccessible(container);
  });

  it('disputed, for a platform operator: the resolution form, saying it does not settle', async () => {
    const { container, getByRole } = renderScreen(ok(DISPUTED), ['RESOLVE_DISPUTE']);
    const form = getByRole('form', { name: 'رسیدگی به اعتراض' });
    expect(form).toHaveTextContent('تسویه نمی‌کند');
    expect(form.querySelector('textarea[name="resolution"]')).toHaveAttribute('minlength', '10');
    expect(form.querySelector('textarea[name="resolution"]')).toHaveAttribute('maxlength', '1000');
    await expectAccessible(container);
  });

  it('disputed earlier, now elsewhere: says when, and that the text may be either', async () => {
    const { container } = renderScreen(
      ok({ ...DISPUTED, status: 'PENDING_SETTLEMENT', disputeReason: 'تحویل تأیید شد' }),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('اعتراض ثبت شده بود');
    expect(text).toContain('در انتظار تسویه');
    expect(text).toContain('تحویل تأیید شد');
    expect(text).toContain('نمی‌تواند بگوید کدام است');
    await expectAccessible(container);
  });

  it.each([
    ['DISPUTE', 'اعتراض ثبت شد'],
    ['RESOLVE_DISPUTE', 'تسویه انجام نشده است'],
  ] as const)('after %s, confirms only what the service confirmed', async (done, words) => {
    const { container } = renderScreen(ok(DISPUTED), [], done);
    expect(container.textContent).toContain(words);
    await expectAccessible(container);
  });
});

describe('what the read can hand back', () => {
  it('another party’s, or a missing, transaction: one wording for both', async () => {
    const { container } = renderScreen({ kind: 'NOT_FOUND' });
    expect(container.textContent).toContain('تراکنشی یافت نشد');
    await expectAccessible(container);
  });

  it('a refusal reads as no access, not as an error', async () => {
    const { container } = renderScreen({ kind: 'FORBIDDEN' });
    expect(container.textContent).toContain('این تراکنش در اختیار شما نیست');
    await expectAccessible(container);
  });

  it('an outage shows a fixed sentence and the tracking code', async () => {
    const { container } = renderScreen({
      kind: 'UNAVAILABLE',
      status: 503,
      correlationId: 'C-503',
    });
    expect(container.textContent).toContain('این تراکنش خوانده نشد');
    expect(container.textContent).toContain('C-503');
    await expectAccessible(container);
  });

  it('a malformed answer is never rendered as data', async () => {
    const { container } = renderScreen({ kind: 'MALFORMED', correlationId: 'C-BAD' });
    expect(container.textContent).toContain('این تراکنش خوانده نشد');
    expect(container.textContent).not.toContain('HELD');
    await expectAccessible(container);
  });
});

function renderForm(state: DisputeFormState, command: DisputeCommand = 'DISPUTE') {
  formState = state;
  return render(
    <DisputeCommandForm
      transactionId="TXN_1"
      command={command}
      csrfToken={CSRF}
      submissionId={SUBMISSION}
    />,
  );
}

const UNCONFIRMED: DisputeFormState = {
  kind: 'UNCONFIRMED',
  command: 'DISPUTE',
  correlationId: 'COR_ORIGINAL',
  submissionId: 'sub_ORIGINALORIGINALORIG',
  values: { ...EMPTY_DISPUTE_FORM, reason: REASON },
};

describe('a dispute form, in each state', () => {
  it('idle: carries the CSRF token, its own submission id, the command and only its field', async () => {
    const { container } = renderForm({ kind: 'IDLE' });
    expect(container.querySelector('[name="csrf"]')).toHaveValue(CSRF);
    expect(container.querySelector('[name="submission"]')).toHaveValue(SUBMISSION);
    expect(container.querySelector('[name="command"]')).toHaveValue('DISPUTE');
    expect(container.querySelector('[name="reason"]')).toHaveAttribute('minlength', '10');
    expect(container.querySelector('[name="resolution"]')).toBeNull();
    // No invented categories, deadlines or outcomes.
    expect(container.querySelector('select, input[type="radio"], input[type="date"]')).toBeNull();
    await expectAccessible(container);
  });

  it('invalid: the person’s text and key stay, the error sits on the field', async () => {
    const { container, getByText } = renderForm({
      kind: 'INVALID',
      command: 'DISPUTE',
      submissionId: 'sub_KEPTKEPTKEPTKEPTKEPT',
      values: { ...EMPTY_DISPUTE_FORM, reason: 'کوتاه' },
      fieldErrors: { reason: 'دلیل اعتراض را دست‌کم در ۱۰ نویسه بنویسید' },
      message: null,
    });
    expect(container.querySelector('[name="reason"]')).toHaveValue('کوتاه');
    expect(container.querySelector('[name="reason"]')).toHaveAttribute('aria-invalid', 'true');
    expect(container.querySelector('[name="submission"]')).toHaveValue('sub_KEPTKEPTKEPTKEPTKEPT');
    expect(getByText('دلیل اعتراض را دست‌کم در ۱۰ نویسه بنویسید')).toBeInTheDocument();
    await expectAccessible(container);
  });

  it('invalid with a message: the fixed sentence, above the form', async () => {
    const { container } = renderForm({
      kind: 'INVALID',
      command: 'DISPUTE',
      submissionId: SUBMISSION,
      values: { ...EMPTY_DISPUTE_FORM, reason: REASON },
      fieldErrors: {},
      message: 'وضعیت کنونی این تراکنش اجازهٔ این اقدام را نمی‌دهد',
    });
    expect(screen.getByRole('alert')).toHaveTextContent('وضعیت کنونی این تراکنش');
    await expectAccessible(container);
  });

  it.each([
    [{ kind: 'REFUSED', reason: 'NO_SESSION' } as const, 'نشست شما پایان یافته است'],
    [{ kind: 'REFUSED', reason: 'CSRF' } as const, 'معتبر شناخته نشد'],
    [{ kind: 'FORBIDDEN', correlationId: 'C-403' } as const, 'در اختیار شما نیست'],
    [{ kind: 'NOT_FOUND' } as const, 'دیگر در دسترس نیست'],
  ])('%j: a fixed sentence', async (state, words) => {
    const { container } = renderForm(state);
    expect(container.textContent).toContain(words);
    await expectAccessible(container);
  });

  it('unconfirmed: never "nothing changed"; re-sends the same key and text', async () => {
    const { container, getByRole } = renderForm(UNCONFIRMED);
    const text = container.textContent ?? '';
    expect(text).toContain('نتوانستیم تأیید کنیم');
    expect(text).toContain('ممکن است انجام شده باشد');
    expect(text).toContain('COR_ORIGINAL');
    expect(text).not.toMatch(/انجام نشد|تغییری نکرد|ثبت نشد/);
    expect(container.querySelector('[name="submission"]')).toHaveValue('sub_ORIGINALORIGINALORIG');
    expect(container.querySelector('[name="reason"]')).toHaveValue(REASON);
    expect(container.querySelector('[name="command"]')).toHaveValue('DISPUTE');
    expect(getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeEnabled();
    expect(getByRole('link', { name: 'این صفحه را تازه کنید' })).toHaveAttribute(
      'href',
      '/transactions/TXN_1',
    );
    await expectAccessible(container);
  });

  it('unconfirmed with no answer at all: no tracking code to show', async () => {
    const { container } = renderForm({ ...UNCONFIRMED, correlationId: null });
    expect(container.textContent).not.toContain('کد پیگیری');
    await expectAccessible(container);
  });

  it('unconfirmed, retry refused: still unconfirmed, with the original code', async () => {
    const { container } = renderForm({ ...UNCONFIRMED, retryRefused: true });
    expect(container.textContent).toContain('ارسال دوباره رد شد');
    expect(container.textContent).toContain('COR_ORIGINAL');
    await expectAccessible(container);
  });

  it('unconfirmed, retry unknown: still unconfirmed', async () => {
    const { container } = renderForm({ ...UNCONFIRMED, retryUnknown: true });
    expect(container.textContent).toContain('نتیجهٔ روشنی نداشت');
    await expectAccessible(container);
  });

  it('unconfirmed, session ended: no retry button — the key belongs to the old login', async () => {
    const { container, queryByRole } = renderForm({ ...UNCONFIRMED, sessionEnded: true });
    expect(container.textContent).toContain('نشست شما پایان یافته است');
    expect(queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeNull();
    await expectAccessible(container);
  });

  it('pending: the button is disabled while the request is out', async () => {
    pending = true;
    const { container, getByRole } = renderForm({ kind: 'IDLE' }, 'RESOLVE_DISPUTE');
    expect(getByRole('button')).toBeDisabled();
    expect(container.querySelector('[name="command"]')).toHaveValue('RESOLVE_DISPUTE');
    await expectAccessible(container);
  });
});
