import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';

import {
  BID_CODE_TEXT,
  BID_COMMAND_DONE,
  BID_COMMAND_LABELS,
  BID_REFUSAL_TEXT,
  type BidCommand,
} from '@/lib/bid-fields';
import { SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';
import type { ReadResult } from '@/server/assets';
import type { BidNote, BidReceipt } from '@/server/tender-bids';
import type { OpenTenderDetail } from '@/server/tenders';
import { OPEN_TENDER, RECEIPT, TENDER_ID, WITHDRAWN } from '@/test/bid-fixtures';

import { BidCommandForm, UNREPEATABLE_BID_TEXT } from './[id]/BidCommandForm';
import { BidCommands, type OfferedBidCommand } from './[id]/BidCommands';
import type { BidFormState } from './[id]/bid-form-state';
import { OpenTenderDetailScreen, OwnBidSection } from './[id]/TenderDetailScreen';

// Each test renders a whole tender screen and runs jest-axe over it; on a loaded runner one can
// take longer than jest's 5 s default (#341). One test per state, each with room to finish.
jest.setTimeout(20_000);

/**
 * What the bidder sees of its own bid on `/tenders/[id]`: the receipt and
 * status (never content), why no form is drawn when none is, the forms the
 * page offers, and each form in every state its action can put it in — the
 * deadline and the qualification refusals in fixed words. One jest-axe check
 * per state.
 *
 * `useActionState` is stubbed so a form state can be rendered directly;
 * `bid-retry.spec.tsx` drives the real hook.
 */

let formState: BidFormState = { kind: 'IDLE' };

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useActionState: () => [formState, '/tenders/TND#action', false] as const,
  };
});

jest.mock('./[id]/bid-actions', () => ({ submitBidCommand: jest.fn() }));

afterEach(() => {
  formState = { kind: 'IDLE' };
  window.sessionStorage.clear();
});

const CSRF = 'csrf-token-for-this-session';
const OWNER = 'owner-tag';
const STAMP = { token: 'signed-replay-stamp', until: Date.now() + 50 * 60 * 1000 };
const PAGE = `/tenders/${TENDER_ID}?view=open`;
const CRITERIA = OPEN_TENDER.criteria.map(({ code, label }) => ({ code, label }));

const offer = (command: BidCommand, id = `sub_${command}AAAAAAAAAAAAAAAA`): OfferedBidCommand => ({
  command,
  submission: { id, replay: STAMP },
});

function page(
  options: {
    tender?: ReadResult<OpenTenderDetail>;
    bid?: ReadResult<BidReceipt>;
    note?: BidNote;
    offered?: readonly OfferedBidCommand[];
    done?: BidCommand;
  } = {},
) {
  return render(
    <OpenTenderDetailScreen
      result={options.tender ?? { kind: 'OK', data: OPEN_TENDER }}
      ownBid={
        <OwnBidSection
          bid={options.bid ?? { kind: 'NOT_FOUND' }}
          note={options.note ?? null}
          done={options.done}
          commands={
            <BidCommands
              tenderId={TENDER_ID}
              offered={options.offered ?? []}
              criteria={CRITERIA}
              csrfToken={CSRF}
              owner={OWNER}
              pageHref={PAGE}
            />
          }
        />
      }
    />,
  );
}

function form(command: BidCommand, heldBy: string | null = null) {
  return render(
    <BidCommandForm
      tenderId={TENDER_ID}
      command={command}
      criteria={CRITERIA}
      csrfToken={CSRF}
      submissionId="sub_AAAAAAAAAAAAAAAAAAAA"
      replay={STAMP}
      owner={OWNER}
      pageHref={PAGE}
      heldBy={heldBy}
    />,
  );
}

const ownBid = () => screen.getByRole('region', { name: 'پیشنهاد سازمان شما' });

describe('the bidder’s own bid', () => {
  it('no bid yet, inside the window: the submission form, a field per criterion, nothing sealed shown', async () => {
    const { container } = page({ offered: [offer('SUBMIT')] });
    expect(
      within(ownBid()).getByText('سازمان شما برای این مناقصه پیشنهادی ثبت نکرده است.'),
    ).toBeInTheDocument();
    const submit = screen.getByRole('form', { name: BID_COMMAND_LABELS.SUBMIT });
    expect(within(submit).getByLabelText(/مبلغ پیشنهاد \(ریال\)/)).toHaveAttribute('dir', 'ltr');
    expect(within(submit).getByLabelText('روش اجرا')).toBeInTheDocument();
    expect(within(submit).getByLabelText('کامل‌بودن مدارک')).toBeInTheDocument();
    expect(within(submit).getByLabelText('یادداشت')).toBeInTheDocument();
    expect(ownBid()).toHaveTextContent(/مهر و موم می‌شود/);
    expect(ownBid()).toHaveTextContent(/سرویس تأمین‌کنندگان/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a submitted bid: its receipt, revision and status, and the replace and withdraw forms', async () => {
    const { container } = page({
      bid: { kind: 'OK', data: { ...RECEIPT, revision: 3 } },
      offered: [offer('REVISE'), offer('WITHDRAW')],
    });
    const section = ownBid();
    expect(within(section).getByText('ثبت‌شده')).toBeInTheDocument();
    expect(within(section).getByText('۳')).toBeInTheDocument();
    expect(within(section).getByText(RECEIPT.receipt)).toBeInTheDocument();
    expect(section).not.toHaveTextContent('4200000000');
    expect(screen.getByRole('form', { name: BID_COMMAND_LABELS.REVISE })).toHaveTextContent(
      /کامل بنویسید/,
    );
    expect(screen.getByRole('form', { name: BID_COMMAND_LABELS.WITHDRAW })).toHaveTextContent(
      /بازگشت ندارد/,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a withdrawn bid: when, and no form', async () => {
    const { container } = page({ bid: { kind: 'OK', data: WITHDRAWN } });
    expect(within(ownBid()).getByText('پس‌گرفته')).toBeInTheDocument();
    expect(within(ownBid()).getByText('پس گرفته در')).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    ['NOT_OPEN', /هنوز آغاز نشده/],
    ['CLOSED', /مهلت پذیرش پیشنهاد گذشته است/],
  ] as const)('the window %s: said, and no form', async (note, text) => {
    const { container } = page({ note });
    expect(within(ownBid()).getByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a bid that could not be read is unknown, never absent — and no form', async () => {
    const { container } = page({
      bid: { kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-mine' },
      note: 'UNREAD',
    });
    expect(ownBid()).toHaveTextContent(/معلوم نیست پیشنهادی ثبت شده یا نه/);
    expect(ownBid()).toHaveTextContent('corr-mine');
    expect(ownBid()).not.toHaveTextContent('پیشنهادی ثبت نکرده است');
    expect(screen.queryByRole('form')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a tender no longer behind the bidder’s door still shows the organization’s own bid', async () => {
    const { container } = page({
      tender: { kind: 'NOT_FOUND' },
      bid: { kind: 'OK', data: RECEIPT },
      note: null,
    });
    expect(screen.getByText('این مناقصه پیدا نشد')).toBeInTheDocument();
    expect(within(ownBid()).getByText('ثبت‌شده')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a confirmed command is announced, from the signed flash', async () => {
    const { container } = page({ bid: { kind: 'OK', data: RECEIPT }, done: 'SUBMIT' });
    expect(within(ownBid()).getByText(BID_COMMAND_DONE.SUBMIT)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('a bid form, in every state its action can put it in', () => {
  const values = {
    priceMinor: '۴٬۲۰۰٬۰۰۰٬۰۰۰',
    note: 'یادداشت',
    answers: [
      { criterionCode: 'technical', response: 'روش اجرا با ماشین‌آلات خودی' },
      { criterionCode: 'compliance', response: '' },
    ],
  };

  it.each([
    ['the deadline', 'BID_WINDOW_CLOSED'],
    ['the qualification', 'BIDDER_NOT_ELIGIBLE'],
    ['a window not yet open', 'BID_WINDOW_NOT_OPEN'],
  ])('%s refused: fixed words, and what was typed drawn again', async (_what, reason) => {
    formState = {
      kind: 'INVALID',
      command: 'SUBMIT',
      submissionId: 'sub_AAAAAAAAAAAAAAAAAAAA',
      values,
      fieldErrors: {},
      message: BID_REFUSAL_TEXT[reason]!,
    };
    const { container } = form('SUBMIT');
    expect(screen.getByRole('alert')).toHaveTextContent(BID_REFUSAL_TEXT[reason]!);
    expect(screen.getByLabelText(/مبلغ پیشنهاد/)).toHaveValue(values.priceMinor);
    expect(screen.getByLabelText('روش اجرا')).toHaveValue(values.answers[0]!.response);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a field error lands under its field', async () => {
    formState = {
      kind: 'INVALID',
      command: 'REVISE',
      submissionId: 'sub_AAAAAAAAAAAAAAAAAAAA',
      values,
      fieldErrors: { 'answer.0': 'هر پاسخ حداکثر ۲۰۰۰ نویسه است.' },
      message: null,
    };
    const { container } = form('REVISE');
    expect(screen.getByLabelText('روش اجرا')).toHaveAccessibleDescription(/حداکثر ۲۰۰۰ نویسه است/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a stale form is told to reload', async () => {
    formState = {
      kind: 'INVALID',
      command: 'WITHDRAW',
      submissionId: 'sub_AAAAAAAAAAAAAAAAAAAA',
      values: null,
      fieldErrors: {},
      message: BID_CODE_TEXT.OPTIMISTIC_LOCK_FAILED!,
    };
    const { container } = form('WITHDRAW');
    expect(screen.getByRole('alert')).toHaveTextContent(/صفحه را تازه کنید/);
    expect(screen.queryByLabelText(/مبلغ پیشنهاد/)).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each(['NO_SESSION', 'SESSION_UNAVAILABLE'] as const)(
    'no session (%s): said apart, nothing sent',
    async (reason) => {
      formState = { kind: 'REFUSED', reason };
      const { container } = form('SUBMIT');
      expect(screen.getByRole('alert')).toHaveTextContent(SESSION_REFUSAL_MESSAGES[reason]);
      expect(await axe(container)).toHaveNoViolations();
    },
  );

  it.each([
    [
      'FORBIDDEN',
      { kind: 'FORBIDDEN', correlationId: 'corr-403', reasons: [] },
      /در اختیار شما نیست/,
    ],
    ['NOT_FOUND', { kind: 'NOT_FOUND' }, /دیگر برای شما در دسترس نیست/],
    ['HELD', { kind: 'HELD' }, /نتیجه‌اش هنوز معلوم نیست/],
    ['STORAGE_UNAVAILABLE', { kind: 'STORAGE_UNAVAILABLE' }, /نمی‌تواند ارسال آن را/],
  ] as const)('%s', async (_kind, state, text) => {
    formState = state as BidFormState;
    const { container } = form('SUBMIT');
    expect(screen.getByRole('alert')).toHaveTextContent(text);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('held by another submission: no button, only why it waits', async () => {
    const { container } = form('WITHDRAW', 'sub_OTHERAAAAAAAAAAAAAAAA');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/درخواست دیگری روی پیشنهاد همین مناقصه/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('unconfirmed in this page: the same request may be sent again, its content carried hidden', async () => {
    formState = {
      kind: 'UNCONFIRMED',
      command: 'SUBMIT',
      correlationId: 'corr-504',
      submissionId: 'sub_AAAAAAAAAAAAAAAAAAAA',
      values,
      replay: STAMP,
    };
    const { container } = form('SUBMIT');
    expect(screen.getByText(/نتوانستیم تأیید کنیم که «ثبت پیشنهاد» انجام شد/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeInTheDocument();
    expect(container.querySelector('input[name="priceMinor"]')).toHaveValue(values.priceMinor);
    expect(container.querySelector('input[name="criterion.0"]')).toHaveValue('technical');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a retry that was refused proves nothing, and may then be set aside', async () => {
    formState = {
      kind: 'UNCONFIRMED',
      command: 'REVISE',
      correlationId: 'corr-504',
      submissionId: 'sub_AAAAAAAAAAAAAAAAAAAA',
      values,
      replay: STAMP,
      retryRefused: true,
    };
    const { container } = form('REVISE');
    expect(screen.getByText(/ارسال دوباره رد شد/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /این درخواست را کنار بگذار/ })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a retry whose session ended: sign in again, nothing offered', async () => {
    formState = {
      kind: 'UNCONFIRMED',
      command: 'WITHDRAW',
      correlationId: null,
      submissionId: 'sub_AAAAAAAAAAAAAAAAAAAA',
      values: null,
      replay: STAMP,
      sessionEnded: true,
    };
    const { container } = form('WITHDRAW');
    expect(screen.getByText(/نشست شما پایان یافته است/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link', { name: /کنار بگذار/ })).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('a replacement or a withdrawal whose outcome is unknown', () => {
  it.each(['REVISE', 'WITHDRAW'] as const)(
    '%s: says why it is not sent again, offers no retry, lets the person set it aside',
    async (command) => {
      formState = {
        kind: 'UNCONFIRMED',
        command,
        correlationId: 'COR_1',
        submissionId: 'sub_AAAAAAAAAAAAAAAAAAAA',
        values: null,
        replay: null,
        viewOnly: true,
        unrepeatable: true,
      };
      const { container } = render(
        <BidCommandForm
          tenderId={TENDER_ID}
          command={command}
          criteria={CRITERIA}
          csrfToken={CSRF}
          submissionId="sub_AAAAAAAAAAAAAAAAAAAA"
          replay={STAMP}
          owner={OWNER}
          pageHref={PAGE}
        />,
      );
      expect(screen.getByText(UNREPEATABLE_BID_TEXT)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeNull();
      expect(screen.getByRole('link', { name: /کنار بگذار/ })).toBeInTheDocument();
      expect(await axe(container)).toHaveNoViolations();
    },
  );
});
