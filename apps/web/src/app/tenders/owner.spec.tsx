import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';

import { SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';
import {
  OPENING_REFUSAL_TEXT,
  OWNER_COMMAND_DONE,
  OWNER_FORBIDDEN_TEXT,
  PUBLICATION_REFUSAL_TEXT,
  type OwnerCommand,
} from '@/lib/tender-owner-fields';
import type { ReadResult } from '@/server/assets';
import type { ApprovalRequest, OwnerBids, OwnerNote } from '@/server/tender-owner';
import {
  APPROVED_REQUEST,
  CLOSED_TENDER,
  DRAFT_TENDER,
  OPENED_BIDS,
  PENDING_REQUEST,
  TENDER_ID,
  UNOPENED_BIDS,
} from '@/test/owner-fixtures';

import { OwnerCommandForm } from './[id]/OwnerCommandForm';
import { OwnerCommands, type OfferedOwnerCommand } from './[id]/OwnerCommands';
import type { OwnerFormState } from './[id]/owner-form-state';
import {
  OpeningSection,
  OwnerBidsSection,
  OwnerFlash,
  PublicationSection,
} from './[id]/OwnerSections';
import { OwnTenderDetailScreen } from './[id]/TenderDetailScreen';

// Each test renders the owner's tender screen and runs jest-axe over it (#341): room to finish.
jest.setTimeout(20_000);

/**
 * What the owner sees on `/tenders/[id]`: the publication and its approval
 * steps, the two-person opening, the bids as the service shows them to an
 * opener (a count before the opening, the content after), and each form in
 * every state its action can put it in — separation of duties, the approval's
 * and the opening's refusals in fixed words. One jest-axe check per state.
 */

let formState: OwnerFormState = { kind: 'IDLE' };

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return { ...actual, useActionState: () => [formState, '/tenders/TND#action', false] as const };
});

jest.mock('./[id]/owner-actions', () => ({ submitOwnerCommand: jest.fn() }));

afterEach(() => {
  formState = { kind: 'IDLE' };
  window.sessionStorage.clear();
});

const CSRF = 'csrf-token-for-this-session';
const OWNER_TAG = 'owner-tag';
const STAMP = { token: 'signed-replay-stamp', until: Date.now() + 50 * 60 * 1000 };
const PAGE = `/tenders/${TENDER_ID}?view=own`;
const CRITERIA = new Map([['technical', 'روش اجرا']]);

const offer = (command: OwnerCommand, execute?: boolean): OfferedOwnerCommand => ({
  command,
  execute,
  submission: { id: `sub_${command}AAAAAAAAAAAAAAAA`, replay: STAMP },
});

const group = (offered: OfferedOwnerCommand[]) => (
  <OwnerCommands
    tenderId={TENDER_ID}
    offered={offered}
    csrfToken={CSRF}
    owner={OWNER_TAG}
    pageHref={PAGE}
    showsRestored
  />
);

function draftPage(
  request: ReadResult<ApprovalRequest | null>,
  notes: OwnerNote[],
  offered: OfferedOwnerCommand[],
) {
  return render(
    <OwnTenderDetailScreen
      result={{ kind: 'OK', data: DRAFT_TENDER }}
      criteria={null}
      owner={<PublicationSection request={request} notes={notes} commands={group(offered)} />}
    />,
  );
}

function closedPage(
  bids: ReadResult<OwnerBids>,
  offered: OfferedOwnerCommand[],
  status = 'CLOSED',
) {
  return render(
    <OwnTenderDetailScreen
      result={{ kind: 'OK', data: { ...CLOSED_TENDER, status } }}
      criteria={null}
      owner={
        <>
          <OpeningSection status={status} notes={[]} commands={group(offered)} />
          <OwnerBidsSection bids={bids} criteria={CRITERIA} />
        </>
      }
    />,
  );
}

const region = (name: string) => screen.getByRole('region', { name });

describe('the publication', () => {
  it('a draft never asked for: the request form, and what it does', async () => {
    const { container } = draftPage({ kind: 'OK', data: null }, [], [offer('PUBLISH', false)]);
    expect(
      within(region('انتشار و موافقت')).getByText(
        'هنوز درخواست انتشاری برای این مناقصه ثبت نشده است.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'درخواست انتشار' })).toHaveTextContent(
      /نه کسی که درخواست داده است/,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('pending, to its authority: the steps, and grant and reject — rejection with a reason', async () => {
    const { container } = draftPage(
      { kind: 'OK', data: PENDING_REQUEST },
      ['PUBLICATION_PENDING'],
      [offer('GRANT'), offer('REJECT')],
    );
    const steps = screen.getByRole('list', { name: 'مراحل موافقت' });
    expect(steps).toHaveTextContent('مدیر سازمان (نمونه)');
    expect(steps).toHaveTextContent('در انتظار تصمیم');
    expect(screen.getByRole('form', { name: 'موافقت با انتشار' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('form', { name: 'رد درخواست انتشار' })).getByRole('textbox', {
        name: /دلیل رد/,
      }),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('pending, to the person who asked: told it waits on someone else — separation of duties', async () => {
    const { container } = draftPage({ kind: 'OK', data: PENDING_REQUEST }, ['OWN_REQUEST'], []);
    expect(region('انتشار و موافقت')).toHaveTextContent(
      /تفکیک وظایف: کسی که درخواست داده خودش آن را تأیید نمی‌کند/,
    );
    expect(screen.queryByRole('form')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('approved on this version: the same command executes', async () => {
    const { container } = draftPage(
      { kind: 'OK', data: APPROVED_REQUEST },
      [],
      [offer('PUBLISH', true)],
    );
    expect(region('انتشار و موافقت')).toHaveTextContent('موافقت‌شده، آمادهٔ اجرا');
    expect(
      screen.getByRole('button', { name: 'اجرای انتشار (موافقت گرفته شده)' }),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('requests that could not be read: unknown, never absent, and no form', async () => {
    const { container } = draftPage(
      { kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-req' },
      ['REQUESTS_UNREAD'],
      [],
    );
    expect(region('انتشار و موافقت')).toHaveTextContent('corr-req');
    expect(region('انتشار و موافقت')).not.toHaveTextContent('هنوز درخواست انتشاری');
    expect(screen.queryByRole('form')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a confirmed command is announced from the signed flash', async () => {
    const { container } = render(<OwnerFlash done="REQUESTED" />);
    expect(screen.getByText(OWNER_COMMAND_DONE.REQUESTED)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the opening and the bids', () => {
  it('closed, before the opening: the three forms, and only a count and times of the bids', async () => {
    const { container } = closedPage({ kind: 'OK', data: UNOPENED_BIDS }, [
      offer('PROPOSE_OPENING'),
      offer('OPEN_BIDS'),
      offer('WITHDRAW_PROPOSAL'),
    ]);
    expect(region('گشایش پیشنهادها')).toHaveTextContent(/گشایش دو نفره است/);
    for (const name of [
      'پیشنهاد گشایش پیشنهادها',
      'گشایش پیشنهادها (نفر دوم)',
      'پس‌گرفتن پیشنهاد گشایش',
    ]) {
      expect(screen.getByRole('form', { name })).toBeInTheDocument();
    }
    const bids = region('پیشنهادهای رسیده');
    expect(bids).toHaveTextContent('۲ پیشنهاد رسیده است');
    expect(bids).not.toHaveTextContent('ORG-CON-0001');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('opened: each bid with its bidder, its price in rials and its answers', async () => {
    const { container } = closedPage({ kind: 'OK', data: OPENED_BIDS }, [], 'EVALUATING');
    const bids = region('پیشنهادهای رسیده');
    expect(bids).toHaveTextContent('ORG-CON-0001');
    expect(bids).toHaveTextContent('۴٬۲۰۰٬۰۰۰٬۰۰۰ ریال');
    expect(bids).toHaveTextContent('روش اجرا');
    expect(bids).toHaveTextContent('روش اجرا با ماشین‌آلات خودی');
    expect(region('گشایش پیشنهادها')).toHaveTextContent('پیشنهادهای این مناقصه گشوده شده‌اند.');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('bids that may not be read, or could not be: said so, nothing shown', async () => {
    const { container } = closedPage({ kind: 'FORBIDDEN' }, []);
    expect(region('پیشنهادهای رسیده')).toHaveTextContent(/عضو سازمانی هستید که پیشنهاد داده است/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('no bid received', async () => {
    const { container } = closedPage(
      { kind: 'OK', data: { ...UNOPENED_BIDS, bidCount: 0, receivedAt: [] } },
      [],
    );
    expect(screen.getByText('پیشنهادی نرسیده')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('published past the deadline: the system closes it', async () => {
    const { container } = render(<OpeningSection status="PUBLISHED" notes={['AWAITING_CLOSE']} />);
    expect(screen.getByText(/مناقصه را سامانه خودش در پایان مهلت می‌بندد/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('an owner form, in every state its action can put it in', () => {
  const formOf = (command: OwnerCommand) =>
    render(
      <OwnerCommandForm
        tenderId={TENDER_ID}
        command={command}
        csrfToken={CSRF}
        submissionId="sub_AAAAAAAAAAAAAAAAAAAA"
        replay={STAMP}
        owner={OWNER_TAG}
        pageHref={PAGE}
      />,
    );

  it.each([
    ['the second person required', 'OPEN_BIDS', OPENING_REFUSAL_TEXT.SECOND_PERSON_REQUIRED],
    ['no proposal yet', 'OPEN_BIDS', OPENING_REFUSAL_TEXT.PROPOSAL_REQUIRED],
    ['not closed', 'PROPOSE_OPENING', OPENING_REFUSAL_TEXT.NOT_CLOSED],
    [
      'a publication that cannot be',
      'PUBLISH',
      `${PUBLICATION_REFUSAL_TEXT.CRITERIA_REQUIRED} ${PUBLICATION_REFUSAL_TEXT.APPROVAL_POLICY_REQUIRED}`,
    ],
  ] as const)('%s: fixed words', async (_what, command, message) => {
    formState = {
      kind: 'INVALID',
      command,
      submissionId: 'sub_AAAAAAAAAAAAAAAAAAAA',
      reason: null,
      fieldErrors: {},
      message: message!,
    };
    const { container } = formOf(command);
    expect(screen.getByRole('alert')).toHaveTextContent(message!);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a rejection’s reason too short: on the field, the text kept', async () => {
    formState = {
      kind: 'INVALID',
      command: 'REJECT',
      submissionId: 'sub_AAAAAAAAAAAAAAAAAAAA',
      reason: 'کوتاه',
      fieldErrors: { reason: 'دلیل رد لازم است' },
      message: null,
    };
    const { container } = formOf('REJECT');
    expect(screen.getByRole('textbox', { name: /دلیل رد/ })).toHaveValue('کوتاه');
    expect(screen.getByRole('textbox', { name: /دلیل رد/ })).toHaveAccessibleDescription(
      /دلیل رد لازم است/,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each([
    ['the requester granting — separation of duties', 'GRANT', [], OWNER_FORBIDDEN_TEXT.GRANT],
    [
      'a conflict of interest',
      'OPEN_BIDS',
      ['CONFLICT_OF_INTEREST'],
      OPENING_REFUSAL_TEXT.CONFLICT_OF_INTEREST,
    ],
    ['someone else’s proposal', 'WITHDRAW_PROPOSAL', [], OWNER_FORBIDDEN_TEXT.WITHDRAW_PROPOSAL],
  ] as const)('403, %s', async (_what, command, reasons, text) => {
    formState = { kind: 'FORBIDDEN', command, correlationId: 'corr-403', reasons };
    const { container } = formOf(command);
    expect(screen.getByRole('alert')).toHaveTextContent(text!);
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each(['NO_SESSION', 'SESSION_UNAVAILABLE'] as const)(
    'no session (%s): said apart',
    async (reason) => {
      formState = { kind: 'REFUSED', reason };
      const { container } = formOf('PUBLISH');
      expect(screen.getByRole('alert')).toHaveTextContent(SESSION_REFUSAL_MESSAGES[reason]);
      expect(await axe(container)).toHaveNoViolations();
    },
  );

  it.each([
    ['NOT_FOUND', { kind: 'NOT_FOUND' }, /دیگر برای شما در دسترس نیست/],
    ['HELD', { kind: 'HELD' }, /نتیجه‌اش هنوز معلوم نیست/],
    ['STORAGE_UNAVAILABLE', { kind: 'STORAGE_UNAVAILABLE' }, /نمی‌تواند ارسال آن را/],
  ] as const)('%s', async (_kind, state, text) => {
    formState = state as OwnerFormState;
    const { container } = formOf('OPEN_BIDS');
    expect(screen.getByRole('alert')).toHaveTextContent(text);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('unconfirmed in this page: the same request again, a rejection’s reason carried hidden', async () => {
    formState = {
      kind: 'UNCONFIRMED',
      command: 'REJECT',
      correlationId: 'corr-504',
      submissionId: 'sub_AAAAAAAAAAAAAAAAAAAA',
      reason: 'معیارها کامل نیست',
      replay: STAMP,
    };
    const { container } = formOf('REJECT');
    expect(
      screen.getByText(/نتوانستیم تأیید کنیم که «رد درخواست انتشار» انجام شد/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeInTheDocument();
    expect(container.querySelector('input[name="reason"]')).toHaveValue('معیارها کامل نیست');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a held form draws no button', async () => {
    const { container } = render(
      <OwnerCommandForm
        tenderId={TENDER_ID}
        command="OPEN_BIDS"
        csrfToken={CSRF}
        submissionId="sub_AAAAAAAAAAAAAAAAAAAA"
        replay={STAMP}
        owner={OWNER_TAG}
        pageHref={PAGE}
        heldBy="sub_OTHERAAAAAAAAAAAAAAAA"
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
