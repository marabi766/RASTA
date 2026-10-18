import { act, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import {
  REASON_FIELD,
  UNREPEATABLE_OWNER_COMMANDS,
  type OwnerCommand,
} from '@/lib/tender-owner-fields';
import {
  clearUnresolvedOwnerCommand,
  markOwnerCommandsOpen,
  purgeAllUnresolvedOwnerCommands,
  purgeForeignUnresolvedOwnerCommands,
  saveUnresolvedOwnerCommand,
  type ReplayStamp,
} from '@/lib/unresolved-tender-command';
import { REASON_CODE_FIELD, REASON_TEXT_FIELD, scoreField } from '@/lib/tender-evaluation-fields';
import { TENDER_ID } from '@/test/owner-fixtures';

import { OwnerCommandForm } from './[id]/OwnerCommandForm';
import { OwnerCommands } from './[id]/OwnerCommands';
import { OwnTenderDetailScreen } from './[id]/TenderDetailScreen';
import type { OwnerFormState } from './[id]/owner-form-state';

jest.setTimeout(20_000);

/**
 * The owner's unconfirmed path with the real `useActionState`: recorded before
 * sending (a marker — never a rejection's reason), the retry with the same key
 * and body, a reload view-only instead of any fresh form, one slot per tender,
 * a held form unsent, logout and another person's page.
 */

const action = jest.fn<Promise<OwnerFormState>, [string, OwnerFormState, FormData]>();
jest.mock('./[id]/owner-actions', () => ({
  submitOwnerCommand: (t: string, p: OwnerFormState, f: FormData) => action(t, p, f),
}));

const sessionProbe = jest.fn<Promise<{ status: number }>, [string]>();
const KEY = 'sub_FIRSTKEYFIRSTKEYFIRS';
const OTHER = 'sub_OTHERKEYOTHERKEYOTH';
const FRESH = 'sub_FRESHKEYFRESHKEYFRE';
const OWNER = 'owner-tag-A';
const STORE_KEY = `rasta.unresolved-tender-command.${TENDER_ID}`;
const STAMP: ReplayStamp = { token: 'signed-replay-stamp', until: Date.now() + 50 * 60 * 1000 };
const PAGE = `/tenders/${TENDER_ID}?view=own`;
const REASON = 'معیارها کامل نیست';

const SCORE_ROWS = [
  {
    cell: { criterionCode: 'technical', maxScore: 10, passFail: false, expectedRevision: 2 },
    label: 'روش اجرا',
    current: null,
  },
];
const BINDING = '{"scoring":[{"criterionCode":"technical"}],"award":null}';

function renderForm(command: OwnerCommand = 'REJECT') {
  return render(
    <OwnerCommandForm
      tenderId={TENDER_ID}
      command={command}
      csrfToken="csrf"
      submissionId={KEY}
      replay={STAMP}
      owner={OWNER}
      pageHref={PAGE}
      {...(command === 'SCORE' ? { scoreRows: SCORE_ROWS, binding: BINDING } : {})}
      {...(command === 'AWARD'
        ? { award: { justificationRequired: false, execution: null }, binding: BINDING }
        : {})}
    />,
  );
}

async function submit(container: HTMLElement) {
  await act(async () => {
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
  });
}

function stored(): Record<string, unknown> | null {
  const raw = window.sessionStorage.getItem(STORE_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

beforeEach(() => {
  action.mockReset();
  sessionProbe.mockReset();
  sessionProbe.mockResolvedValue({ status: 204 });
  global.fetch = ((url: string) => sessionProbe(url)) as unknown as typeof fetch;
  window.sessionStorage.clear();
});

afterEach(() => markOwnerCommandsOpen());

it('a score is remembered before it leaves — that it was sent, never what it said — and retried as sent', async () => {
  let seen: Record<string, unknown> | null = null;
  action.mockImplementation(async (_t, _p, form) => {
    seen ??= stored();
    return {
      kind: 'UNCONFIRMED',
      command: 'SCORE',
      correlationId: 'COR_ORIGINAL',
      submissionId: KEY,
      values: {
        [scoreField('technical')]: String(form.get(scoreField('technical'))),
        binding: BINDING,
      },
      replay: STAMP,
    };
  });
  const { container } = renderForm('SCORE');
  fireEvent.change(container.querySelector(`[name="${scoreField('technical')}"]`)!, {
    target: { value: '۷٫۵' },
  });
  await submit(container);
  expect(seen).toMatchObject({ command: 'SCORE', submissionId: KEY, correlationId: null });
  expect(JSON.stringify(window.sessionStorage)).not.toContain('۷٫۵');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }));
  });
  const [first, second] = action.mock.calls.map(([, , form]) => form);
  expect(second!.get('submission')).toBe(KEY);
  expect(second!.get(scoreField('technical'))).toBe(first!.get(scoreField('technical')));
  expect(second!.get('binding')).toBe(BINDING);
  expect(await axe(container)).toHaveNoViolations();
});

/** What a command's form needs typed before it is sent at all. */
function fillFor(command: OwnerCommand, container: HTMLElement): void {
  const set = (name: string, value: string) =>
    fireEvent.change(container.querySelector(`[name="${name}"]`)!, { target: { value } });
  if (command === 'REJECT' || command === 'REJECT_AWARD') set(REASON_FIELD, REASON);
  if (command === 'DISQUALIFY') {
    set(REASON_CODE_FIELD, 'NON_RESPONSIVE');
    set(REASON_TEXT_FIELD, 'مدارک ناقص');
  }
}

it('every command the service keeps no result for, its call lost, is remembered, view-only, never sent again', async () => {
  for (const command of UNREPEATABLE_OWNER_COMMANDS) {
    action.mockReset();
    window.sessionStorage.clear();
    action.mockRejectedValueOnce(new Error('An unexpected response was received from the server.'));
    sessionProbe.mockResolvedValue({ status: 503 });
    const { container, unmount } = renderForm(command);
    fillFor(command, container);
    await submit(container);
    expect(stored()).toMatchObject({ command, submissionId: KEY });
    expect(screen.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeNull();
    expect(screen.getByRole('link', { name: /کنار بگذار/ })).toBeInTheDocument();
    await submit(container);
    expect(action).toHaveBeenCalledTimes(1);
    unmount();
  }
});

it('a reason the action would refuse unsent is not remembered', async () => {
  action.mockResolvedValue({
    kind: 'INVALID',
    command: 'REJECT',
    submissionId: KEY,
    values: { reason: 'کوتاه' },
    fieldErrors: { reason: 'x' },
    message: null,
  });
  const { container } = renderForm();
  fireEvent.change(container.querySelector(`[name="${REASON_FIELD}"]`)!, {
    target: { value: 'کوتاه' },
  });
  await submit(container);
  expect(stored()).toBeNull();
});

it('a definite answer drops the record; a lost call is "session ended" only on a 401', async () => {
  action.mockRejectedValueOnce(new Error('An unexpected response was received from the server.'));
  sessionProbe.mockResolvedValue({ status: 503 });
  const { container } = renderForm('SCORE');
  fireEvent.change(container.querySelector(`[name="${scoreField('technical')}"]`)!, {
    target: { value: '7' },
  });
  await submit(container);
  expect(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeInTheDocument();
  expect(screen.queryByText(/نشست شما پایان یافته است/)).toBeNull();
  expect(stored()).toMatchObject({ command: 'SCORE' });
});

it('a publication whose answer was lost — then rejected — offers no retry, and the page no fresh form until set aside', async () => {
  action.mockResolvedValueOnce({
    kind: 'UNCONFIRMED',
    command: 'PUBLISH',
    correlationId: 'COR_LOST',
    submissionId: KEY,
    values: null,
    replay: null,
    viewOnly: true,
    unrepeatable: true,
  });
  const { container, unmount } = renderForm('PUBLISH');
  await submit(container);
  expect(screen.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeNull();
  await submit(container);
  expect(action).toHaveBeenCalledTimes(1);
  unmount();
  // The request was rejected meanwhile; the page is drawn again with a fresh request form.
  const page = render(
    <OwnerCommands
      tenderId={TENDER_ID}
      offered={[{ command: 'PUBLISH', submission: { id: FRESH, replay: STAMP } }]}
      csrfToken="csrf"
      owner={OWNER}
      pageHref={PAGE}
      showsRestored
    />,
  );
  // The lost send holds the slot: no fresh publication is offered beside it, nothing is re-sent.
  expect(page.container.querySelector(`input[name="submission"][value="${FRESH}"]`)).toBeNull();
  expect(page.queryByRole('button', { name: 'درخواست انتشار' })).toBeNull();
  expect(page.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeNull();
  expect(page.getByRole('link', { name: /کنار بگذار/ })).toBeInTheDocument();
  expect(action).toHaveBeenCalledTimes(1);
});

it('after a reload the record is view-only instead of any fresh form, until set aside', async () => {
  saveUnresolvedOwnerCommand(
    TENDER_ID,
    { command: 'PUBLISH', submissionId: KEY, correlationId: 'COR_ORIGINAL' },
    OWNER,
  );
  const { container } = render(
    <OwnerCommands
      tenderId={TENDER_ID}
      offered={[{ command: 'PUBLISH', submission: { id: FRESH, replay: STAMP } }]}
      csrfToken="csrf"
      owner={OWNER}
      pageHref={PAGE}
      showsRestored
      pageSubmissionIds={[FRESH]}
    />,
  );
  expect(container.querySelector(`input[value="${FRESH}"]`)).toBeNull();
  expect(screen.getByText(/COR_ORIGINAL/)).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
  const aside = screen.getByRole('link', { name: /این درخواست را کنار بگذار/ });
  expect(await axe(container)).toHaveNoViolations();
  aside.addEventListener('click', (event) => event.preventDefault());
  fireEvent.click(aside);
  expect(stored()).toBeNull();
});

it('an authority’s decision on its last step, its answer lost: after the reload the absence and, beside it, the record and its set-aside (PR 346 review 4)', async () => {
  saveUnresolvedOwnerCommand(
    TENDER_ID,
    { command: 'GRANT_AWARD', submissionId: KEY, correlationId: null },
    OWNER,
  );
  // The page as `page.tsx` draws it once the inbox holds no pending step: the absence, and the
  // session's recovery next to it.
  const absence = (owner: string) => (
    <>
      <OwnTenderDetailScreen result={{ kind: 'NOT_FOUND' }} criteria={null} />
      <OwnerCommands
        tenderId={TENDER_ID}
        offered={[]}
        csrfToken="csrf"
        owner={owner}
        pageHref={PAGE}
        showsRestored
        pageSubmissionIds={[]}
      />
    </>
  );
  const { container, unmount } = render(absence(OWNER));
  expect(screen.getByText('این مناقصه پیدا نشد')).toBeInTheDocument();
  expect(screen.getByText(/این درخواست پیش از تازه‌شدن صفحه فرستاده شد/)).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /موافقت با واگذاری/ })).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
  const aside = screen.getByRole('link', { name: /این درخواست را کنار بگذار/ });
  expect(aside).toHaveAttribute('href', PAGE);
  expect(await axe(container)).toHaveNoViolations();
  // jsdom does not navigate; the set-aside's own handler runs all the same.
  aside.addEventListener('click', (event) => event.preventDefault());
  fireEvent.click(aside);
  expect(stored()).toBeNull();
  unmount();

  // Another session's page shows no record of this one, and nothing beside the absence.
  saveUnresolvedOwnerCommand(
    TENDER_ID,
    { command: 'GRANT_AWARD', submissionId: KEY, correlationId: null },
    OWNER,
  );
  render(absence('owner-tag-B'));
  expect(screen.getByText('این مناقصه پیدا نشد')).toBeInTheDocument();
  expect(screen.queryByText(/این درخواست پیش از تازه‌شدن صفحه فرستاده شد/)).toBeNull();
  expect(screen.queryByRole('link', { name: /این درخواست را کنار بگذار/ })).toBeNull();
});

it('one slot per tender: another submission’s record is never replaced, the form not sent', async () => {
  saveUnresolvedOwnerCommand(
    TENDER_ID,
    { command: 'GRANT', submissionId: OTHER, correlationId: null },
    OWNER,
  );
  const { container } = renderForm('OPEN_BIDS');
  await submit(container);
  expect(action).not.toHaveBeenCalled();
  expect(stored()).toMatchObject({ submissionId: OTHER, command: 'GRANT' });
  expect(
    saveUnresolvedOwnerCommand(
      TENDER_ID,
      { command: 'OPEN_BIDS', submissionId: KEY, correlationId: null },
      OWNER,
    ),
  ).toBe('HELD');
});

it('a record is cleared only by its own submission id', () => {
  saveUnresolvedOwnerCommand(
    TENDER_ID,
    { command: 'GRANT', submissionId: OTHER, correlationId: null },
    OWNER,
  );
  clearUnresolvedOwnerCommand(TENDER_ID, KEY);
  expect(stored()).toMatchObject({ submissionId: OTHER });
  clearUnresolvedOwnerCommand(TENDER_ID, OTHER);
  expect(stored()).toBeNull();
});

it('the other group of the page does not show a record a form of the page holds', () => {
  saveUnresolvedOwnerCommand(
    TENDER_ID,
    { command: 'OPEN_BIDS', submissionId: KEY, correlationId: null },
    OWNER,
  );
  const { container } = render(
    <OwnerCommands
      tenderId={TENDER_ID}
      offered={[]}
      csrfToken="csrf"
      owner={OWNER}
      pageHref={PAGE}
      showsRestored
      pageSubmissionIds={[KEY]}
    />,
  );
  expect(container).toBeEmptyDOMElement();
});

it('logout writes nothing more; another person’s page removes the record', () => {
  saveUnresolvedOwnerCommand(
    TENDER_ID,
    { command: 'PUBLISH', submissionId: KEY, correlationId: null },
    OWNER,
  );
  purgeAllUnresolvedOwnerCommands();
  expect(stored()).toMatchObject({ submissionId: KEY });
  expect(
    saveUnresolvedOwnerCommand(
      'TND_OTHER',
      { command: 'PUBLISH', submissionId: OTHER, correlationId: null },
      OWNER,
    ),
  ).toBe('UNAVAILABLE');
  purgeForeignUnresolvedOwnerCommands('owner-tag-B');
  expect(stored()).toBeNull();
});
