import { render, screen, waitFor, within } from '@testing-library/react';
import type { DemoMode } from '@/lib/demo-mode';
import { axe } from 'jest-axe';

import {
  CONTRACT_CODE_TEXT,
  CONTRACT_COMMAND_DONE,
  CONTRACT_REFUSAL_TEXT,
  type ContractCommand,
} from '@/lib/contract-command-fields';
import { SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';
import type { ContractScope } from '@/lib/unresolved-contract-command';
import type { ContractDetail } from '@/server/contracts';
import {
  AMENDMENT_ID,
  CANCELLED,
  CONTRACT_ID,
  DRAFT,
  MILESTONE,
  MILESTONE_ID,
  PROPOSED,
  SIGNED,
} from '@/test/contract-command-fixtures';

import { ContractCommandForm } from './[id]/ContractCommandForm';
import type { OfferedContractCommand } from './[id]/ContractCommands';
import { ContractDetailScreen } from './[id]/ContractDetailScreen';
import type { ContractCommandOffers, SigningNote } from './[id]/contract-offers';
import type { ContractFormState } from './[id]/contract-form-state';
import { bindingOf } from '@/test/unresolved-binding';

// Each test renders a whole contract screen and runs jest-axe over it; give each room on a
// loaded runner, as `statements.spec.tsx` does (main 59785c26).
jest.setTimeout(20_000);

/**
 * What the contract command forms render on `/contracts/[id]`: which forms
 * are drawn where, with what fields; the notes for an employer nobody may sign
 * for yet; the confirmation a command earned; and each form in every state
 * its action can put it in — separation of duties and the signing policy said
 * in fixed Persian words. One jest-axe check per test.
 *
 * `useActionState` is stubbed so a form state can be rendered directly, as in
 * `statements.spec.tsx`; `contract-command-retry.spec.tsx` drives the real hook.
 */

let formState: ContractFormState = { kind: 'IDLE' };

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useActionState: () => [formState, '/contracts/CTR#action', false] as const,
  };
});

jest.mock('./[id]/contract-actions', () => ({ submitContractCommand: jest.fn() }));
jest.mock('./[id]/statement-actions', () => ({
  submitStatementDraft: jest.fn(),
  submitStatementCommand: jest.fn(),
}));

afterEach(() => {
  formState = { kind: 'IDLE' };
  window.sessionStorage.clear();
});

const STAMP = { token: 'signed-replay-stamp', until: Date.now() + 50 * 60 * 1000 };
let next = 0;
const submission = () => ({ id: `sub_OFFERED${String(next++).padStart(12, '0')}`, replay: STAMP });

const offer = (
  command: ContractCommand,
  extra: Omit<OfferedContractCommand, 'command' | 'submission'> = {},
): OfferedContractCommand => ({ command, submission: submission(), ...extra });

const CONTEXT = {
  csrfToken: 'csrf',
  binding: bindingOf('owner-tag', 'session-tag'),
  sessionMaxAgeSeconds: 12 * 60 * 60,
  pageHref: `/contracts/${CONTRACT_ID}`,
};

const NONE: ContractCommandOffers = {
  context: CONTEXT,
  contract: [],
  newAmendment: [],
  amendments: {},
  newMilestone: [],
  milestones: {},
  signingNote: null,
};

const CANCEL_REASONS = [
  { code: 'TERMS_NOT_AGREED', label: 'توافق نشدن بر شرایط' },
  { code: 'OTHER', label: 'سایر' },
];

function contractPage(
  contract: ContractDetail,
  commands: Partial<ContractCommandOffers> = {},
  extra: { notice?: ContractCommand; amendments?: boolean; demoMode?: DemoMode } = {},
) {
  return render(
    <ContractDetailScreen
      result={{ kind: 'OK', data: contract }}
      amendments={{
        kind: 'OK',
        data: { items: extra.amendments ? [PROPOSED] : [], nextCursor: null, hasMore: false },
      }}
      milestones={{
        kind: 'OK',
        data: { items: extra.amendments ? [MILESTONE] : [], nextCursor: null, hasMore: false },
      }}
      statements={null}
      commands={{ ...NONE, ...commands }}
      notice={extra.notice ?? null}
      demoMode={extra.demoMode ?? 'REAL'}
    />,
  );
}

const formNamed = (name: string) => screen.findByRole('form', { name });

describe('which forms are drawn', () => {
  it('the contractor, on a draft: its signature, and no cancellation', async () => {
    const { container } = contractPage(DRAFT, {
      contract: [offer('SIGN', { side: 'CONTRACTOR' })],
    });
    const sign = await formNamed('امضای قرارداد — از سوی پیمانکار');
    expect(within(sign).getByRole('button', { name: 'امضای قرارداد' })).toBeEnabled();
    expect(within(sign).getByText(/این پذیرشِ ثبت‌شده است، نه امضای حقوقی/)).toBeVisible();
    expect(screen.queryByRole('form', { name: /لغو پیش‌نویس/ })).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the employer, on an unsigned draft: its signature and the cancellation, with the reasons offered', async () => {
    const { container } = contractPage(DRAFT, {
      contract: [offer('SIGN', { side: 'EMPLOYER' }), offer('CANCEL', { reasons: CANCEL_REASONS })],
    });
    await formNamed('امضای قرارداد — از سوی کارفرما');
    const cancel = await formNamed('لغو پیش‌نویس قرارداد');
    const reason = within(cancel).getByLabelText(/دلیل/);
    expect(
      within(reason)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['انتخاب کنید', 'توافق نشدن بر شرایط', 'سایر']);
    expect(within(cancel).getByLabelText('یادداشت (اختیاری)')).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each<[Exclude<SigningNote, null>, RegExp]>([
    ['NO_POLICY', /هیچ‌کس از سوی کارفرما امضا نمی‌کند/],
    ['UNREAD', /سیاست امضای کارفرما خوانده نشد/],
    ['INCOMPLETE', /فهرست سیاست‌های امضای این سازمان کامل خوانده نشد/],
  ])(
    'an employer nobody may sign for yet is told why, and offered no signature (%s)',
    async (note, text) => {
      const { container } = contractPage(DRAFT, { signingNote: note });
      expect(await screen.findByText(text)).toBeVisible();
      expect(screen.queryByRole('form', { name: /امضای قرارداد/ })).toBeNull();
      expect(await axe(container)).toHaveNoViolations();
    },
  );

  it('a signed contract: proposing and signing an amendment, planning and changing a milestone', async () => {
    const { container } = contractPage(
      SIGNED,
      {
        newAmendment: [
          offer('PROPOSE_AMENDMENT', {
            reasons: [{ code: 'SCOPE_CHANGE', label: 'تغییر دامنهٔ کار' }],
          }),
        ],
        amendments: { [AMENDMENT_ID]: [offer('SIGN_AMENDMENT', { side: 'EMPLOYER' })] },
        newMilestone: [offer('PLAN_MILESTONE')],
        milestones: {
          [MILESTONE_ID]: [
            offer('CHANGE_MILESTONE', {
              defaults: {
                title: MILESTONE.title,
                plannedDate: '2026-12-20',
                plannedShareBp: '25.5',
              },
            }),
          ],
        },
      },
      { amendments: true },
    );
    const propose = await formNamed('پیشنهاد الحاقیه');
    expect(within(propose).getByLabelText(/مبلغ الحاقیه \(ریال\)/)).toHaveAttribute('dir', 'ltr');
    await formNamed('امضای الحاقیه — الحاقیهٔ ۱ — از سوی کارفرما');
    expect(screen.getByText('دلیل: تغییر دامنهٔ کار')).toBeVisible();
    const plan = await formNamed('برنامه‌ریزی Milestone');
    expect(within(plan).getByLabelText(/روز برنامه‌ریزی‌شده/)).toHaveAttribute('type', 'date');
    // A row's change form is folded until asked for, and starts from the milestone as it is.
    expect(screen.getByText(`ویرایش «${MILESTONE.title}»`).closest('details')).not.toHaveAttribute(
      'open',
    );
    const change = screen.getByRole('form', {
      name: `ویرایش Milestone — ${MILESTONE.title}`,
      hidden: true,
    });
    expect(within(change).getByDisplayValue('25.5')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('nothing to act with when nothing is offered', async () => {
    const { container } = contractPage(SIGNED, {}, { amendments: true });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'امضاها' })).toBeVisible());
    expect(screen.queryAllByRole('form')).toEqual([]);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the confirmation a command earned, and a cancellation’s reason in words', async () => {
    const { container } = contractPage(CANCELLED, {}, { notice: 'CANCEL' });
    expect(await screen.findByText(CONTRACT_COMMAND_DONE.CANCEL)).toBeVisible();
    expect(screen.getByText(/دلیل لغو: توافق نشدن بر شرایط/)).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });
});

const CONTRACT_SCOPE: ContractScope = {
  contractId: CONTRACT_ID,
  slot: 'CONTRACT',
  subjectId: null,
};

function commandForm(
  command: ContractCommand = 'SIGN',
  extra: Partial<Parameters<typeof ContractCommandForm>[0]> = {},
) {
  return render(
    <main>
      <ContractCommandForm
        scope={CONTRACT_SCOPE}
        command={command}
        side={command === 'SIGN' ? 'EMPLOYER' : null}
        csrfToken="csrf"
        submissionId="sub_THISFORMTHISFORMTHIS"
        replay={STAMP}
        binding={CONTEXT.binding}
        sessionMaxAgeSeconds={CONTEXT.sessionMaxAgeSeconds}
        reasons={CANCEL_REASONS}
        pageHref={CONTEXT.pageHref}
        {...extra}
      />
    </main>,
  );
}

describe('each form state', () => {
  it('separation of duties: a member of both parties', async () => {
    formState = { kind: 'FORBIDDEN', correlationId: 'COR_1', reasons: ['MEMBER_OF_BOTH_PARTIES'] };
    const { container } = commandForm();
    expect(
      screen.getByText(new RegExp(CONTRACT_REFUSAL_TEXT.MEMBER_OF_BOTH_PARTIES!)),
    ).toBeVisible();
    expect(screen.getByText(/COR_1/)).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('separation of duties: the same person on both sides', async () => {
    formState = { kind: 'FORBIDDEN', correlationId: 'COR_2', reasons: ['SAME_PERSON_BOTH_SIDES'] };
    const { container } = commandForm();
    expect(
      screen.getByText(new RegExp(CONTRACT_REFUSAL_TEXT.SAME_PERSON_BOTH_SIDES!)),
    ).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a 403 with no reason this portal knows', async () => {
    formState = { kind: 'FORBIDDEN', correlationId: 'COR_3', reasons: [] };
    const { container } = commandForm();
    expect(screen.getByText(/این اقدام در اختیار شما نیست/)).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the signing policy', async () => {
    formState = {
      kind: 'INVALID',
      command: 'SIGN',
      submissionId: 'sub_THISFORMTHISFORMTHIS',
      values: {},
      fieldErrors: {},
      message: CONTRACT_REFUSAL_TEXT.SIGNATURE_POLICY_REQUIRED!,
    };
    const { container } = commandForm();
    expect(screen.getByText(CONTRACT_REFUSAL_TEXT.SIGNATURE_POLICY_REQUIRED!)).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a stale form (conflict)', async () => {
    formState = {
      kind: 'INVALID',
      command: 'SIGN',
      submissionId: 'sub_THISFORMTHISFORMTHIS',
      values: {},
      fieldErrors: {},
      message: CONTRACT_CODE_TEXT.OPTIMISTIC_LOCK_FAILED!,
    };
    const { container } = commandForm();
    expect(screen.getByText(CONTRACT_CODE_TEXT.OPTIMISTIC_LOCK_FAILED!)).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a field refused, with what was typed drawn again', async () => {
    formState = {
      kind: 'INVALID',
      command: 'CANCEL',
      submissionId: 'sub_THISFORMTHISFORMTHIS',
      values: { reasonCode: '', note: 'یادداشت من' },
      fieldErrors: { reasonCode: 'یکی از دلیل‌ها را انتخاب کنید.' },
      message: null,
    };
    const { container } = commandForm('CANCEL');
    expect(screen.getByRole('alert')).toHaveTextContent('یکی از دلیل‌ها را انتخاب کنید.');
    expect(screen.getByDisplayValue('یادداشت من')).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the session unavailable for now', async () => {
    formState = { kind: 'REFUSED', reason: 'SESSION_UNAVAILABLE' };
    const { container } = commandForm();
    expect(screen.getByText(SESSION_REFUSAL_MESSAGES.SESSION_UNAVAILABLE)).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('past the form’s deadline', async () => {
    formState = { kind: 'REFUSED', reason: 'REPLAY' };
    const { container } = commandForm();
    expect(screen.getByText(/مهلت این فرم گذشته است/)).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('gone', async () => {
    formState = { kind: 'NOT_FOUND' };
    const { container } = commandForm();
    expect(screen.getByText(/دیگر در دسترس نیست/)).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('nowhere to remember it', async () => {
    formState = { kind: 'STORAGE_UNAVAILABLE' };
    const { container } = commandForm('PROPOSE_AMENDMENT');
    expect(screen.getByText(/ممکن است یک الحاقیه یا Milestone دو بار ثبت شود/)).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('another command on this contract in doubt: no button', async () => {
    const { container } = commandForm('CANCEL', { heldBy: 'sub_SOMEONEELSESOMEONEE' });
    expect(screen.getByText(/درخواست دیگری روی همین مورد فرستاده شده/)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('sent, not confirmed — the same request offered again, never a fresh form', async () => {
    formState = {
      kind: 'UNCONFIRMED',
      command: 'CANCEL',
      correlationId: 'COR_LOST',
      submissionId: 'sub_THISFORMTHISFORMTHIS',
      input: { reasonCode: 'OTHER', note: 'یادداشت' },
      replay: STAMP,
    };
    const { container } = commandForm('CANCEL');
    expect(
      screen.getByText(/نتوانستیم تأیید کنیم که «لغو پیش‌نویس قرارداد» انجام شد/),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeEnabled();
    expect(container.querySelector('input[name="reasonCode"]')).toHaveValue('OTHER');
    expect(container.querySelector('select')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a refused retry, and the way to set it aside', async () => {
    formState = {
      kind: 'UNCONFIRMED',
      command: 'SIGN',
      correlationId: 'COR_LOST',
      submissionId: 'sub_THISFORMTHISFORMTHIS',
      input: null,
      replay: STAMP,
      retryRefused: true,
    };
    const { container } = commandForm();
    expect(screen.getByText(/ارسال دوباره رد شد/)).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'وضعیت را دیدم؛ این درخواست را کنار بگذار' }),
    ).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a retry with the session ended', async () => {
    formState = {
      kind: 'UNCONFIRMED',
      command: 'SIGN_AMENDMENT',
      correlationId: null,
      submissionId: 'sub_THISFORMTHISFORMTHIS',
      input: null,
      replay: STAMP,
      sessionEnded: true,
    };
    const { container } = commandForm('SIGN_AMENDMENT');
    expect(screen.getByText(/نشست شما پایان یافته است/)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the outcome-unknown marker', async () => {
    formState = {
      kind: 'UNCONFIRMED',
      command: 'PLAN_MILESTONE',
      correlationId: null,
      submissionId: 'sub_THISFORMTHISFORMTHIS',
      input: null,
      replay: null,
      viewOnly: true,
      marker: true,
    };
    const { container } = commandForm('PLAN_MILESTONE');
    expect(screen.getByText(/محتوای آن دیگر نگه داشته نمی‌شود/)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the contract page: «حالت نمایشی» (Q-14)', () => {
  it('is drawn when the provider is simulated', () => {
    contractPage(DRAFT, {}, { demoMode: 'SIMULATED' });
    expect(screen.getByText('حالت نمایشی')).toBeInTheDocument();
  });

  it('is absent when it is not', () => {
    contractPage(DRAFT, {}, { demoMode: 'REAL' });
    expect(screen.queryByText('حالت نمایشی')).toBeNull();
    expect(screen.queryByText('وضعیت درگاه پرداخت معلوم نیست')).toBeNull();
  });

  it('says the provider is unknown in its place; signing moves no money, so nothing is withheld', () => {
    contractPage(DRAFT, {}, { demoMode: 'UNKNOWN' });
    expect(screen.getByText('وضعیت درگاه پرداخت معلوم نیست')).toBeInTheDocument();
    expect(screen.queryByText('حالت نمایشی')).toBeNull();
    expect(screen.queryByText(/اکنون در دسترس نیست/)).toBeNull();
  });
});
