import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';

import { lineField } from '@/lib/statement-fields';
import {
  markStatementsOpen,
  purgeAllUnresolvedStatements,
  purgeForeignUnresolvedStatements,
  restoreUnresolvedStatement,
  saveUnresolvedStatement,
  type ReplayStamp,
} from '@/lib/unresolved-statement';
import { CONTRACT_ID, STATEMENT_ID } from '@/test/statement-fixtures';

import { StatementCommandForm } from './[id]/StatementCommandForm';
import { StatementCommands } from './[id]/StatementCommands';
import type { StatementFormState } from './[id]/statement-form-state';

/**
 * The unconfirmed path with the real `useActionState`, `dispute-retry.spec.tsx`
 * for the statement commands — only the actions and `/auth/session` are
 * scripted:
 *
 * - a draft is remembered **before** it is sent, with the lines it sends, and
 *   a reload finds it and offers no fresh draft form (a draft under a fresh key
 *   is a second statement);
 * - the retry posts the same key and the same lines;
 * - a call that itself fails is "session ended" only when `/auth/session`
 *   answers `401`; a `503` (refresh unavailable for now) is not;
 * - at logout, and past the session's lifetime, the entry becomes a marker,
 *   never fresh controls; another person's page removes it.
 */

const draft = jest.fn<Promise<StatementFormState>, [string, StatementFormState, FormData]>();
const command = jest.fn<
  Promise<StatementFormState>,
  [string, string, StatementFormState, FormData]
>();
jest.mock('./[id]/statement-actions', () => ({
  submitStatementDraft: (c: string, p: StatementFormState, f: FormData) => draft(c, p, f),
  submitStatementCommand: (c: string, s: string, p: StatementFormState, f: FormData) =>
    command(c, s, p, f),
}));

const sessionProbe = jest.fn<Promise<{ status: number }>, [string]>();

const KEY = 'sub_FIRSTKEYFIRSTKEYFIRS';
const FRESH = 'sub_FRESHKEYFRESHKEYFRE';
const BINDING = { owner: 'owner-tag-A', session: 'session-tag-1' };
const SESSION_MAX_AGE = 12 * 60 * 60;
const DRAFT_SCOPE = { contractId: CONTRACT_ID, statementId: null };
const STATEMENT_SCOPE = { contractId: CONTRACT_ID, statementId: STATEMENT_ID };
const STORE_KEY = `rasta.unresolved-statement.${CONTRACT_ID}.draft`;
const STAMP: ReplayStamp = { token: 'signed-replay-stamp', until: Date.now() + 50 * 60 * 1000 };
const LINES = [{ description: 'آسفالت', amountMinor: '1100000000' }];

const lostResponse = () => new Error('An unexpected response was received from the server.');

function renderDraftForm() {
  return render(
    <StatementCommandForm
      scope={DRAFT_SCOPE}
      command="DRAFT"
      csrfToken="csrf"
      submissionId={KEY}
      replay={STAMP}
      binding={BINDING}
      sessionMaxAgeSeconds={SESSION_MAX_AGE}
      pageHref={`/contracts/${CONTRACT_ID}`}
    />,
  );
}

/** What the contract page draws: what a reload brings back. */
function renderDraftCommands(binding = BINDING) {
  return render(
    <StatementCommands
      contractId={CONTRACT_ID}
      statementId={null}
      offered={[{ command: 'DRAFT', submission: { id: FRESH, replay: STAMP } }]}
      csrfToken="csrf"
      binding={binding}
      sessionMaxAgeSeconds={SESSION_MAX_AGE}
      pageHref={`/contracts/${CONTRACT_ID}`}
    />,
  );
}

function fillFirstRow(container: HTMLElement) {
  fireEvent.change(container.querySelector(`[name="${lineField(0, 'description')}"]`)!, {
    target: { value: 'آسفالت' },
  });
  fireEvent.change(container.querySelector(`[name="${lineField(0, 'amount')}"]`)!, {
    target: { value: '۱٬۱۰۰٬۰۰۰٬۰۰۰' },
  });
}

async function submitForm(container: HTMLElement) {
  await act(async () => {
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
  });
}

const unconfirmed = (correlationId: string | null = 'COR_ORIGINAL'): StatementFormState => ({
  kind: 'UNCONFIRMED',
  command: 'DRAFT',
  correlationId,
  submissionId: KEY,
  lines: LINES,
  replay: STAMP,
});

function stored(): Record<string, unknown> | null {
  const raw = window.sessionStorage.getItem(STORE_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

beforeEach(() => {
  draft.mockReset();
  command.mockReset();
  sessionProbe.mockReset();
  sessionProbe.mockResolvedValue({ status: 204 });
  global.fetch = ((url: string) => sessionProbe(url)) as unknown as typeof fetch;
  window.sessionStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
  markStatementsOpen();
});

describe('a draft sent and not confirmed', () => {
  it('is remembered before it leaves, with the lines it sends', async () => {
    let seenWhileSending: Record<string, unknown> | null = null;
    draft.mockImplementation(async () => {
      seenWhileSending = stored();
      return unconfirmed();
    });
    const { container } = renderDraftForm();
    fillFirstRow(container);
    await submitForm(container);
    expect(seenWhileSending).toMatchObject({
      submissionId: KEY,
      lines: LINES,
      correlationId: null,
    });
    expect(stored()).toMatchObject({
      submissionId: KEY,
      lines: LINES,
      correlationId: 'COR_ORIGINAL',
    });
    expect(
      await screen.findByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the retry posts the same key and the same lines', async () => {
    draft.mockResolvedValueOnce(unconfirmed());
    const { container } = renderDraftForm();
    fillFirstRow(container);
    await submitForm(container);
    draft.mockResolvedValueOnce({
      ...(unconfirmed() as object),
      retryUnknown: true,
    } as StatementFormState);
    await submitForm(container);
    const retry = draft.mock.calls[1]![2];
    expect(retry.get('submission')).toBe(KEY);
    expect(retry.get('replay')).toBe(STAMP.token);
    expect(retry.get(lineField(0, 'description'))).toBe('آسفالت');
    expect(retry.get(lineField(0, 'amount'))).toBe('1100000000');
  });

  it('a reload finds it, and draws no fresh draft form over it', async () => {
    saveUnresolvedStatement(
      DRAFT_SCOPE,
      {
        command: 'DRAFT',
        submissionId: KEY,
        lines: LINES,
        correlationId: 'COR_ORIGINAL',
        replay: STAMP,
      },
      BINDING,
    );
    const { container } = renderDraftCommands();
    expect(
      await screen.findByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }),
    ).toBeInTheDocument();
    expect(container.querySelector(`input[name="submission"]`)).toHaveValue(KEY);
    expect(container.querySelector(`input[value="${FRESH}"]`)).toBeNull();
  });

  it('a confirmed answer forgets it', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/x;307;',
    });
    draft.mockRejectedValue(redirect);
    const { container } = renderDraftForm();
    fillFirstRow(container);
    await submitForm(container).catch(() => undefined);
    await waitFor(() => expect(stored()).toBeNull());
  });

  it('a lost response is "maybe done", not "session ended", unless /auth/session says 401', async () => {
    draft.mockRejectedValue(lostResponse());
    sessionProbe.mockResolvedValue({ status: 503 });
    const first = renderDraftForm();
    fillFirstRow(first.container);
    await submitForm(first.container);
    expect(
      await screen.findByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }),
    ).toBeInTheDocument();
    expect(first.container.textContent).not.toContain('نشست شما پایان یافته است');
    first.unmount();
    window.sessionStorage.clear();

    sessionProbe.mockResolvedValue({ status: 401 });
    const second = renderDraftForm();
    fillFirstRow(second.container);
    await submitForm(second.container);
    expect(await screen.findByText(/نشست شما پایان یافته است/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' }),
    ).not.toBeInTheDocument();
  });

  it('is not sent when it cannot be remembered', async () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { container } = renderDraftForm();
    fillFirstRow(container);
    await submitForm(container);
    expect(draft).not.toHaveBeenCalled();
    expect(await screen.findByText(/دو بار ثبت شود/)).toBeInTheDocument();
  });
});

describe('never silently gone', () => {
  const entry = {
    command: 'APPROVE' as const,
    submissionId: KEY,
    lines: [],
    correlationId: 'COR',
    replay: STAMP,
  };

  it('at logout an entry becomes a marker: no stamp, no login tag, still blocking', () => {
    saveUnresolvedStatement(STATEMENT_SCOPE, entry, BINDING);
    purgeAllUnresolvedStatements();
    markStatementsOpen();
    expect(restoreUnresolvedStatement(STATEMENT_SCOPE, BINDING, SESSION_MAX_AGE)).toEqual({
      kind: 'VIEW_ONLY',
      entry: expect.objectContaining({ marker: true, replay: null, submissionId: KEY }),
    });
  });

  it('past the session’s lifetime it becomes a marker too', () => {
    saveUnresolvedStatement(
      STATEMENT_SCOPE,
      entry,
      BINDING,
      Date.now() - (SESSION_MAX_AGE + 1) * 1000,
    );
    expect(
      restoreUnresolvedStatement(STATEMENT_SCOPE, BINDING, SESSION_MAX_AGE)?.entry.marker,
    ).toBe(true);
  });

  it('nothing is stored once a logout has started', () => {
    purgeAllUnresolvedStatements();
    expect(saveUnresolvedStatement(STATEMENT_SCOPE, entry, BINDING)).toBe(false);
  });

  it('from another login it is shown, never re-sent; another person’s page removes it', () => {
    saveUnresolvedStatement(STATEMENT_SCOPE, entry, BINDING);
    expect(
      restoreUnresolvedStatement(
        STATEMENT_SCOPE,
        { ...BINDING, session: 'session-tag-2' },
        SESSION_MAX_AGE,
      )?.kind,
    ).toBe('VIEW_ONLY');
    purgeForeignUnresolvedStatements('owner-tag-B');
    expect(restoreUnresolvedStatement(STATEMENT_SCOPE, BINDING, SESSION_MAX_AGE)).toBeNull();
  });

  it('refuses an entry whose lines are not what a draft sends', () => {
    window.sessionStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        v: 1,
        marker: false,
        command: 'DRAFT',
        submissionId: KEY,
        lines: [{ description: 'x', amountMinor: '1.5' }],
        correlationId: null,
        savedAt: Date.now(),
        replay: STAMP,
        owner: BINDING.owner,
        session: BINDING.session,
      }),
    );
    expect(restoreUnresolvedStatement(DRAFT_SCOPE, BINDING, SESSION_MAX_AGE)).toBeNull();
    expect(stored()).toBeNull();
  });
});
