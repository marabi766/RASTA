import { render, screen, within } from '@testing-library/react';
import type { DemoMode } from '@/lib/demo-mode';
import { axe } from 'jest-axe';

import { SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';
import {
  STATEMENT_CODE_TEXT,
  STATEMENT_COMMAND_LABELS,
  STATEMENT_REFUSAL_TEXT,
  type StatementCommand,
} from '@/lib/statement-fields';
import type { ReadResult } from '@/server/assets';
import type { Statement, StatementPage } from '@/server/contract-statements';
import type { ContractDetail } from '@/server/contracts';
import {
  CONTRACT_ID,
  CONTRACTOR,
  DRAFTED,
  EMPLOYER,
  STATEMENT_ID,
  SUBMITTED,
  TECHNICALLY_APPROVED,
} from '@/test/statement-fixtures';

import { ContractDetailScreen } from './[id]/ContractDetailScreen';
import { StatementCommandForm } from './[id]/StatementCommandForm';
import type { StatementFormState } from './[id]/statement-form-state';
import { StatementDetailScreen } from './[id]/statements/[statementId]/StatementDetailScreen';
import { bindingOf } from '@/test/unresolved-binding';
import { TEST_CONTEXT } from '@/test/page-context';
import { withContext } from '@/lib/page-context';

// Each test renders a whole statement screen and runs jest-axe over it. On a loaded CI runner
// one such test took longer than jest's 5 s default (main 59785c26); the axe run it left behind
// then failed every later test with "Axe is already running". One test per state is already
// the rule here (#297); this gives each of them room instead of failing the file.
jest.setTimeout(20_000);

/**
 * What the statement screens render: the list on `/contracts/[id]` and one
 * statement on its own page — every outcome a read can hand back, money as
 * the service's decimal strings in Persian digits, both chains with each
 * step's authority, decision and time, and each form in every state its action
 * can put it in. One jest-axe check per state.
 *
 * `useActionState` is stubbed so a form state can be rendered directly, as in
 * `transactions.spec.tsx`; `statement-retry.spec.tsx` drives the real hook.
 */

let formState: StatementFormState = { kind: 'IDLE' };
let pending = false;

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useActionState: () => [formState, '/contracts/CTR#action', pending] as const,
  };
});

jest.mock('./[id]/statement-actions', () => ({
  submitStatementDraft: jest.fn(),
  submitStatementCommand: jest.fn(),
}));

afterEach(() => {
  formState = { kind: 'IDLE' };
  pending = false;
  window.sessionStorage.clear();
});

const CSRF = 'csrf-token-for-this-session';
const BINDING = bindingOf('owner-tag', 'session-tag');
const SESSION_MAX_AGE = 12 * 60 * 60;
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';
const STAMP = { token: 'signed-replay-stamp', until: Date.now() + 50 * 60 * 1000 };
const PAGE = `/contracts/${CONTRACT_ID}/statements/${STATEMENT_ID}`;

const CONTRACT: ContractDetail = {
  id: CONTRACT_ID,
  organizationId: EMPLOYER,
  contractorOrganizationId: CONTRACTOR,
  tenderId: 'TND_1',
  projectId: 'PRJ_1',
  status: 'SIGNED',
  amountMinor: '5000000000',
  currentAmountMinor: '5000000000',
  awardedAt: '2026-10-01T08:00:00.000Z',
  statusChangedAt: '2026-10-02T08:00:00.000Z',
  winningBidId: 'BID_1',
  amendmentsTotalMinor: '0',
  employerSignedAt: '2026-10-02T08:00:00.000Z',
  contractorSignedAt: '2026-10-02T07:00:00.000Z',
  authorityReviewRequired: false,
  authorityReviewReason: null,
  cancelReasonCode: null,
  cancelNote: null,
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-02T08:00:00.000Z',
  version: 3,
};

const EMPTY_PAGE: ReadResult<StatementPage> = {
  kind: 'OK',
  data: { items: [], nextCursor: null, hasMore: false },
};

function contractPage(
  statements: ReadResult<StatementPage>,
  draft: Parameters<typeof ContractDetailScreen>[0]['draft'] = null,
) {
  return render(
    <ContractDetailScreen
      context={TEST_CONTEXT}
      demoMode="REAL"
      result={{ kind: 'OK', data: CONTRACT }}
      amendments={{ kind: 'OK', data: { items: [], nextCursor: null, hasMore: false } }}
      milestones={{ kind: 'OK', data: { items: [], nextCursor: null, hasMore: false } }}
      statements={statements}
      draft={draft}
    />,
  );
}

function statementPage(
  result: ReadResult<Statement>,
  offered: StatementCommand[] = [],
  extra: { contractUnavailable?: boolean; notice?: StatementCommand; demoMode?: DemoMode } = {},
) {
  return render(
    <StatementDetailScreen
      result={result}
      contractUnavailable={extra.contractUnavailable ?? false}
      offered={offered.map((command) => ({
        command,
        submission: { id: SUBMISSION, replay: STAMP },
      }))}
      csrfToken={CSRF}
      binding={BINDING}
      sessionMaxAgeSeconds={SESSION_MAX_AGE}
      notice={extra.notice}
      pageHref={PAGE}
      demoMode={extra.demoMode ?? 'REAL'}
    />,
  );
}

describe('the statements of a contract', () => {
  it('lists each with its status and the service’s gross, deductions and net', async () => {
    const { container } = contractPage({
      kind: 'OK',
      data: { items: [SUBMITTED], nextCursor: null, hasMore: false },
    });
    const section = within(screen.getByRole('region', { name: 'صورت‌وضعیت‌ها' }));
    expect(section.getByRole('link', { name: 'صورت‌وضعیت شمارهٔ ۱' })).toHaveAttribute(
      'href',
      PAGE,
    );
    expect(section.getByText('۱٬۵۰۰٬۰۰۰٬۰۰۰ ریال')).toBeInTheDocument();
    expect(section.getByText('۷۵٬۰۰۰٬۰۰۰ ریال')).toBeInTheDocument();
    expect(section.getByText('۱٬۴۲۵٬۰۰۰٬۰۰۰ ریال')).toBeInTheDocument();
    expect(section.getByText('ارسال‌شده، در انتظار تأیید فنی')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('empty', async () => {
    const { container } = contractPage(EMPTY_PAGE);
    expect(screen.getByText('صورت‌وضعیتی نیست')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('degraded on its own, with the contract above it still shown', async () => {
    const { container } = contractPage({
      kind: 'UNAVAILABLE',
      status: 503,
      correlationId: 'corr-9',
    });
    expect(
      screen.getByText('صورت‌وضعیت‌ها خوانده نشد. کمی بعد دوباره تلاش کنید.'),
    ).toBeInTheDocument();
    expect(screen.getByText('corr-9')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'قرارداد' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('refused on its own', async () => {
    const { container } = contractPage({ kind: 'FORBIDDEN' });
    expect(screen.getByText('صورت‌وضعیت‌های این قرارداد در اختیار شما نیست.')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('pages by the service’s cursor', () => {
    contractPage({ kind: 'OK', data: { items: [SUBMITTED], nextCursor: '1', hasMore: true } });
    expect(screen.getByRole('link', { name: 'صفحهٔ بعدِ صورت‌وضعیت‌ها' })).toHaveAttribute(
      'href',
      withContext(TEST_CONTEXT, `/contracts/${CONTRACT_ID}?statementCursor=1`),
    );
  });

  it('draws the draft form only when offered', async () => {
    contractPage(EMPTY_PAGE);
    expect(screen.queryByRole('form')).not.toBeInTheDocument();

    const { container } = contractPage(EMPTY_PAGE, {
      offered: [{ command: 'DRAFT', submission: { id: SUBMISSION, replay: STAMP } }],
      csrfToken: CSRF,
      binding: BINDING,
      sessionMaxAgeSeconds: SESSION_MAX_AGE,
      milestones: [{ id: 'MST_1', title: 'بخش نخست' }],
    });
    const draft = await screen.findByRole('form', { name: STATEMENT_COMMAND_LABELS.DRAFT });
    expect(within(draft).getByLabelText('مبلغ (ریال) — ردیف ۱')).toHaveAttribute('dir', 'ltr');
    expect(within(draft).getAllByRole('option', { name: 'بخش نخست' }).length).toBeGreaterThan(0);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('one statement', () => {
  it('its lines, deductions, net and both chains — authority, decision and time, never a person', async () => {
    const { container } = statementPage({ kind: 'OK', data: TECHNICALLY_APPROVED });
    expect(screen.getByRole('heading', { name: 'صورت‌وضعیت شمارهٔ ۱' })).toBeInTheDocument();
    expect(screen.getByText('آسفالت')).toBeInTheDocument();
    expect(screen.getByText('حسن انجام کار')).toBeInTheDocument();
    expect(screen.getByText('۵٪')).toBeInTheDocument();
    expect(screen.getAllByText('۱٬۴۲۵٬۰۰۰٬۰۰۰ ریال').length).toBeGreaterThan(0);

    const technical = within(screen.getByRole('region', { name: 'زنجیرهٔ تأیید فنی' }));
    expect(technical.getByText('تأیید شد')).toBeInTheDocument();
    expect(technical.getByText(/زمان تصمیم:/)).toBeInTheDocument();
    expect(technical.getByText(/مدیر سازمان/)).toBeInTheDocument();
    const financial = within(screen.getByRole('region', { name: 'زنجیرهٔ تأیید مالی' }));
    expect(financial.getByText('در انتظار تصمیم')).toBeInTheDocument();
    expect(financial.getByText(/مدیر ناوگان/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/USR-/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a draft has no chains yet', async () => {
    const { container } = statementPage({ kind: 'OK', data: DRAFTED });
    expect(screen.getByText(/زنجیره‌های تأیید هنگام ارسال صورت‌وضعیت/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a stranger’s statement and a missing one read the same', async () => {
    const { container } = statementPage({ kind: 'NOT_FOUND' });
    expect(screen.getByText('این صورت‌وضعیت پیدا نشد')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('degraded', async () => {
    const { container } = statementPage({ kind: 'MALFORMED', correlationId: 'corr-3' });
    expect(
      screen.getByText('صورت‌وضعیت خوانده نشد. کمی بعد دوباره تلاش کنید.'),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('says why no submit form is offered when the contract could not be read', async () => {
    const { container } = statementPage({ kind: 'OK', data: DRAFTED }, [], {
      contractUnavailable: true,
    });
    expect(screen.getByText(/فرم ارسال صورت‌وضعیت عرضه/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the confirmation a command earned', async () => {
    const { container } = statementPage({ kind: 'OK', data: SUBMITTED }, [], { notice: 'SUBMIT' });
    expect(screen.getByRole('status')).toHaveTextContent('صورت‌وضعیت برای تأیید ارسال شد');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('draws the approve and reject forms offered, each its own', async () => {
    const { container } = statementPage({ kind: 'OK', data: SUBMITTED }, ['APPROVE', 'REJECT']);
    expect(
      await screen.findByRole('form', { name: STATEMENT_COMMAND_LABELS.APPROVE }),
    ).toBeInTheDocument();
    expect(screen.getByRole('form', { name: STATEMENT_COMMAND_LABELS.REJECT })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('draws nothing to act with when nothing is offered', () => {
    statementPage({ kind: 'OK', data: SUBMITTED });
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
  });
});

describe('each form state', () => {
  function form(command: StatementCommand) {
    return render(
      <StatementCommandForm
        scope={{ contractId: CONTRACT_ID, statementId: command === 'DRAFT' ? null : STATEMENT_ID }}
        command={command}
        csrfToken={CSRF}
        submissionId={SUBMISSION}
        replay={STAMP}
        binding={BINDING}
        sessionMaxAgeSeconds={SESSION_MAX_AGE}
        pageHref={PAGE}
      />,
    );
  }

  const UNCONFIRMED: StatementFormState = {
    kind: 'UNCONFIRMED',
    command: 'DRAFT',
    correlationId: 'corr-7',
    submissionId: SUBMISSION,
    lines: [{ description: 'آسفالت', amountMinor: '1100000000' }],
    replay: STAMP,
  };

  const STATES: [string, StatementCommand, StatementFormState, RegExp | string][] = [
    ['idle', 'APPROVE', { kind: 'IDLE' }, STATEMENT_COMMAND_LABELS.APPROVE],
    [
      'a refused row',
      'DRAFT',
      {
        kind: 'INVALID',
        command: 'DRAFT',
        submissionId: SUBMISSION,
        rows: [{ description: 'آسفالت', amount: '12.5', milestoneId: '' }],
        fieldErrors: { 'line.0.amount': 'مبلغ را به ریال و به‌صورت عدد صحیح مثبت بنویسید.' },
        message: null,
      },
      'مبلغ را به ریال و به‌صورت عدد صحیح مثبت بنویسید.',
    ],
    [
      'separation of duties (the same person on two steps)',
      'APPROVE',
      {
        kind: 'INVALID',
        command: 'APPROVE',
        submissionId: SUBMISSION,
        rows: [],
        fieldErrors: {},
        message: STATEMENT_REFUSAL_TEXT.ALREADY_DECIDED_STATEMENT!,
      },
      STATEMENT_REFUSAL_TEXT.ALREADY_DECIDED_STATEMENT!,
    ],
    [
      'a stale form (conflict)',
      'REJECT',
      {
        kind: 'INVALID',
        command: 'REJECT',
        submissionId: SUBMISSION,
        rows: [],
        fieldErrors: {},
        message: STATEMENT_CODE_TEXT.OPTIMISTIC_LOCK_FAILED!,
      },
      STATEMENT_CODE_TEXT.OPTIMISTIC_LOCK_FAILED!,
    ],
    [
      'separation of duties (a member of the contractor)',
      'APPROVE',
      { kind: 'FORBIDDEN', correlationId: 'corr-4', reasons: ['MEMBER_OF_CONTRACTOR'] },
      /^تفکیک وظایف: عضو سازمان پیمانکار، صورت‌وضعیت همان پیمانکار را بررسی نمی‌کند؛ چیزی ثبت نشد\. کد پیگیری: corr-4$/,
    ],
    [
      'a refusal with no reason this portal knows',
      'SUBMIT',
      { kind: 'FORBIDDEN', correlationId: 'corr-5', reasons: [] },
      /^این اقدام در اختیار شما نیست\. کد پیگیری: corr-5$/,
    ],
    [
      'the session ended',
      'SUBMIT',
      { kind: 'REFUSED', reason: 'NO_SESSION' },
      SESSION_REFUSAL_MESSAGES.NO_SESSION,
    ],
    [
      'the session unavailable for now',
      'APPROVE',
      { kind: 'REFUSED', reason: 'SESSION_UNAVAILABLE' },
      SESSION_REFUSAL_MESSAGES.SESSION_UNAVAILABLE,
    ],
    [
      'past the form’s deadline',
      'DRAFT',
      { kind: 'REFUSED', reason: 'REPLAY' },
      /مهلت این فرم گذشته است/,
    ],
    ['gone', 'APPROVE', { kind: 'NOT_FOUND' }, /دیگر در دسترس نیست/],
    ['nowhere to remember it', 'DRAFT', { kind: 'STORAGE_UNAVAILABLE' }, /دو بار ثبت شود/],
    [
      'another command of this statement in doubt',
      'REJECT',
      { kind: 'HELD' },
      /نتیجه‌اش هنوز معلوم نیست/,
    ],
    ['sent, not confirmed', 'DRAFT', UNCONFIRMED, 'ارسال دوبارهٔ همین درخواست'],
    [
      'a refused retry',
      'DRAFT',
      { ...UNCONFIRMED, retryRefused: true } as StatementFormState,
      /ارسال دوباره رد شد/,
    ],
    [
      'a retry with the session ended',
      'DRAFT',
      { ...UNCONFIRMED, sessionEnded: true } as StatementFormState,
      /نشست شما پایان یافته است/,
    ],
    [
      'past the replay deadline',
      'DRAFT',
      { ...UNCONFIRMED, replay: null, viewOnly: true, replayExpired: true } as StatementFormState,
      /مهلت ارسال دوبارهٔ همین درخواست گذشته است/,
    ],
    [
      'the outcome-unknown marker',
      'SUBMIT',
      {
        kind: 'UNCONFIRMED',
        command: 'SUBMIT',
        correlationId: null,
        submissionId: SUBMISSION,
        lines: [],
        replay: null,
        viewOnly: true,
        marker: true,
      },
      /دیگر نگه داشته نمی‌شود/,
    ],
  ];

  it.each(STATES)('%s', async (_name, command, state, text) => {
    formState = state;
    const { container } = form(command);
    expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain('English');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the session unavailable for now never says it has ended', () => {
    formState = { kind: 'REFUSED', reason: 'SESSION_UNAVAILABLE' };
    const { container } = form('SUBMIT');
    expect(container.textContent).not.toContain('پایان یافته');
  });

  it('a retry re-sends the lines as they were sent, under the same key', () => {
    formState = UNCONFIRMED;
    const { container } = form('DRAFT');
    const hidden = (name: string) =>
      (container.querySelector(`input[name="${name}"]`) as HTMLInputElement | null)?.value;
    expect(hidden('submission')).toBe(SUBMISSION);
    expect(hidden('replay')).toBe(STAMP.token);
    expect(hidden('line.0.description')).toBe('آسفالت');
    expect(hidden('line.0.amount')).toBe('1100000000');
  });

  it('cannot be re-sent past the deadline, and can be put aside', () => {
    formState = {
      ...UNCONFIRMED,
      replay: null,
      viewOnly: true,
      replayExpired: true,
    } as StatementFormState;
    form('DRAFT');
    expect(
      screen.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'وضعیت را دیدم؛ این درخواست را کنار بگذار' }),
    ).toHaveAttribute('href', PAGE);
  });
});

describe('the statement page: «حالت نمایشی» (Q-14)', () => {
  it('is drawn when the provider is simulated', () => {
    statementPage({ kind: 'OK', data: DRAFTED }, [], { demoMode: 'SIMULATED' });
    expect(screen.getByText('حالت نمایشی')).toBeInTheDocument();
  });

  it('is absent when it is not', () => {
    statementPage({ kind: 'OK', data: DRAFTED }, [], { demoMode: 'REAL' });
    expect(screen.queryByText('حالت نمایشی')).toBeNull();
    expect(screen.queryByText('وضعیت درگاه پرداخت معلوم نیست')).toBeNull();
  });

  // An approval records the obligation; a separate settlement pays it, so it moves no money
  // and a disclosure outage must not stop it (Codex PR-361 r2, the same rule as orders).
  it('says the provider is unknown, and still offers the approval and the rejection', async () => {
    statementPage({ kind: 'OK', data: SUBMITTED }, ['APPROVE', 'REJECT'], { demoMode: 'UNKNOWN' });
    expect(screen.getByText('وضعیت درگاه پرداخت معلوم نیست')).toBeInTheDocument();
    expect(screen.queryByText('حالت نمایشی')).toBeNull();
    expect(screen.queryByText(/اکنون در دسترس نیست/)).toBeNull();
    expect(
      await screen.findByRole('form', { name: STATEMENT_COMMAND_LABELS.APPROVE }),
    ).toBeInTheDocument();
    expect(screen.getByRole('form', { name: STATEMENT_COMMAND_LABELS.REJECT })).toBeInTheDocument();
  });
});
