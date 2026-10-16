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
const BINDING = { owner: 'owner-tag', session: 'session-tag' };
const SESSION_MAX_AGE = 12 * 60 * 60;
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
  notice?: DisputeCommand,
) {
  return render(
    <TransactionDetailScreen
      result={result}
      commands={commands}
      csrfToken={CSRF}
      mintSubmissionId={() => SUBMISSION}
      binding={BINDING}
      sessionMaxAgeSeconds={SESSION_MAX_AGE}
      notice={notice}
    />,
  );
}

beforeEach(() => window.sessionStorage.clear());

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
    ['DISPUTE', 'اعتراض شما ثبت شد'],
    ['RESOLVE_DISPUTE', 'رسیدگی شما ثبت شد'],
  ] as const)(
    'after %s, confirms only what the person’s own request did',
    async (notice, words) => {
      const { container, getByText } = renderScreen(ok(DISPUTED), [], notice);
      expect(getByText(new RegExp(words)).closest('[role="status"]')).not.toBeNull();
      await expectAccessible(container);
    },
  );

  it('a notice never claims a present state: a settled record next to a dispute notice says settled', async () => {
    const SETTLED: Transaction = {
      ...DISPUTED,
      status: 'SETTLED',
      settledAt: '2026-10-04T09:00:00.000Z',
      settlement: { id: 'SET_9', settledAt: '2026-10-04T09:00:00.000Z' },
    };
    const { container, getByText } = renderScreen(ok(SETTLED), [], 'DISPUTE');
    const notice = getByText(/اعتراض شما ثبت شد/).closest('[role="status"]') as HTMLElement;
    expect(notice).not.toBeNull();
    expect(notice.textContent).not.toMatch(/متوقف|در انتظار تسویه|تسویه انجام نشده/);
    expect(container.textContent).toContain('تسویه‌شده');
    await expectAccessible(container);
  });

  it('removes the confirmation token from the address once shown, keeping the rest', () => {
    window.history.replaceState(null, '', '/transactions/TXN_1?flash=TOKEN&tab=1#dispute');
    renderScreen(ok(DISPUTED), [], 'DISPUTE');
    expect(window.location.pathname).toBe('/transactions/TXN_1');
    expect(window.location.search).toBe('?tab=1');
    expect(window.location.hash).toBe('#dispute');
  });

  it('without a notice, the address is left alone', () => {
    window.history.replaceState(null, '', '/transactions/TXN_1?flash=FORGED');
    renderScreen(ok(DISPUTED));
    expect(window.location.search).toBe('?flash=FORGED');
    window.history.replaceState(null, '', '/');
  });
});

describe('a marketplace order’s transaction (Q-138)', () => {
  const ORDER_TX: Transaction = {
    ...HELD,
    transactionType: 'MARKETPLACE_ORDER',
    sourceType: 'ORDER',
    sourceReference: 'ORD_42',
  };

  it('offers no dispute form and links to its order', async () => {
    const { container, getByRole, queryByRole } = renderScreen(ok(ORDER_TX), ['DISPUTE']);
    expect(queryByRole('form')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).toContain('فقط از صفحهٔ همان سفارش');
    expect(getByRole('link', { name: 'رفتن به صفحهٔ سفارش' })).toHaveAttribute(
      'href',
      '/orders/ORD_42',
    );
    await expectAccessible(container);
  });

  it('a disputed order transaction: no resolution here either — the order’s is the operator path', async () => {
    const { container, queryByRole } = renderScreen(
      ok({
        ...ORDER_TX,
        status: 'DISPUTED',
        disputedAt: DISPUTED.disputedAt,
        disputeReason: REASON,
      }),
      ['RESOLVE_DISPUTE'],
    );
    expect(queryByRole('form')).toBeNull();
    expect(container.textContent).toContain('تسویهٔ آن متوقف است');
    await expectAccessible(container);
  });

  it('with no order id in the view: links to the order list and says why', async () => {
    const { container, getByRole } = renderScreen(
      ok({ ...ORDER_TX, sourceType: null, sourceReference: null }),
    );
    expect(getByRole('link', { name: 'رفتن به فهرست سفارش‌ها' })).toHaveAttribute(
      'href',
      '/orders',
    );
    expect(container.textContent).toContain('شناسهٔ سفارش در اطلاعات این تراکنش نیامده است');
    await expectAccessible(container);
  });

  it('a remembered dispute submission is not offered for it either', () => {
    window.sessionStorage.setItem(
      'rasta.unresolved-dispute.TXN_1',
      JSON.stringify({
        v: 1,
        command: 'DISPUTE',
        submissionId: SUBMISSION,
        text: REASON,
        correlationId: null,
        savedAt: Date.now(),
        owner: BINDING.owner,
        session: BINDING.session,
      }),
    );
    const { queryByRole } = renderScreen(ok(ORDER_TX));
    expect(queryByRole('form')).toBeNull();
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
      binding={BINDING}
      sessionMaxAgeSeconds={SESSION_MAX_AGE}
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
    expect(queryByRole('link', { name: /کنار بگذار/ })).toBeNull();
    await expectAccessible(container);
  });

  it('unconfirmed, not yet tried again: no way to put it aside', () => {
    const { queryByRole } = renderForm(UNCONFIRMED);
    expect(queryByRole('link', { name: /کنار بگذار/ })).toBeNull();
  });

  it('unconfirmed, retry refused: may be put aside after seeing the record', async () => {
    const { container, getByRole } = renderForm({ ...UNCONFIRMED, retryRefused: true });
    expect(getByRole('link', { name: /کنار بگذار/ })).toHaveAttribute(
      'href',
      '/transactions/TXN_1',
    );
    expect(getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeEnabled();
    await expectAccessible(container);
  });

  it('unconfirmed, view only: shown, not re-sent, may be put aside', async () => {
    const { container, getByRole, queryByRole } = renderForm({ ...UNCONFIRMED, viewOnly: true });
    expect(container.textContent).toContain('نشست پیشین یا بیش از یک ساعت پیش');
    expect(queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeNull();
    expect(getByRole('link', { name: /کنار بگذار/ })).toBeInTheDocument();
    await expectAccessible(container);
  });

  it('storage unavailable: says nothing was sent, and why', async () => {
    const { container } = renderForm({ kind: 'STORAGE_UNAVAILABLE' });
    expect(container.textContent).toContain('درخواست ارسال نشد');
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
