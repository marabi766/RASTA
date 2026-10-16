/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';
import { DISPUTE_COMMANDS, EMPTY_DISPUTE_FORM } from '@/lib/transaction-dispute-fields';
import { readFlash } from '@/server/flash';

import { IDLE_DISPUTE_FORM, type UnconfirmedDispute } from './form-state';

/**
 * The dispute commands' one write path — the order of checks of
 * `place-order-actions.spec.ts`, then what each answer becomes, then the
 * unconfirmed path: a retry under the same key whose refusal or doubt never
 * settles the first request.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const currentSession = jest.fn();
const issueDisputeCommand = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({ currentSession: () => currentSession() }));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/transactions', () => {
  const actual = jest.requireActual('@/server/transactions');
  return {
    ...actual,
    issueDisputeCommand: (...args: unknown[]) => issueDisputeCommand(...args),
  };
});

const { submitDisputeCommand } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./actions') as typeof import('./actions');

const SESSION = {
  subject: 'user-1',
  username: 'payer',
  organizationId: 'ORG-DEH-0001',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const TXN = 'TXN_1';
const REASON = 'کالا تحویل نشده و پاسخی هم نیامده است';
const GOOD = { command: 'DISPUTE', reason: REASON };

function formData(
  fields: Record<string, string>,
  options: { csrf?: string | null; submission?: string | null } = {},
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
  if (csrf !== null) form.set(CSRF_FIELD, csrf);
  const submission =
    options.submission === undefined ? mintSubmissionId(SESSION) : options.submission;
  if (submission !== null) form.set(SUBMISSION_FIELD, submission);
  return form;
}

beforeEach(() => {
  currentSession.mockResolvedValue(SESSION);
  issueDisputeCommand.mockReset();
  issueDisputeCommand.mockResolvedValue({
    kind: 'CREATED',
    data: { id: TXN, status: 'DISPUTED' },
    correlationId: 'corr-ok',
  });
  redirect.mockClear();
});

describe('the order of checks', () => {
  it('refuses a post with no session, and calls nothing', async () => {
    currentSession.mockResolvedValue(null);
    expect(await submitDisputeCommand(TXN, IDLE_DISPUTE_FORM, formData(GOOD))).toEqual({
      kind: 'REFUSED',
      reason: 'NO_SESSION',
    });
    expect(issueDisputeCommand).not.toHaveBeenCalled();
  });

  it('refuses a post with no CSRF token, and calls nothing', async () => {
    expect(
      await submitDisputeCommand(TXN, IDLE_DISPUTE_FORM, formData(GOOD, { csrf: null })),
    ).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
    expect(issueDisputeCommand).not.toHaveBeenCalled();
  });

  it('refuses a submission id this server did not mint, and calls nothing', async () => {
    for (const submission of [
      'chosen-by-the-client',
      mintSubmissionId({ ...SESSION, subject: 'someone-else' }),
    ]) {
      expect(
        await submitDisputeCommand(TXN, IDLE_DISPUTE_FORM, formData(GOOD, { submission })),
      ).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
    }
    expect(issueDisputeCommand).not.toHaveBeenCalled();
  });

  it('refuses a command that is not one of the two, and calls nothing', async () => {
    for (const command of ['REFUND', 'SETTLE', '']) {
      expect(
        await submitDisputeCommand(TXN, IDLE_DISPUTE_FORM, formData({ ...GOOD, command })),
      ).toEqual({ kind: 'REFUSED', reason: 'COMMAND' });
    }
    expect(issueDisputeCommand).not.toHaveBeenCalled();
  });

  it('keeps a reason that is too short on the form, and calls nothing', async () => {
    const submission = mintSubmissionId(SESSION);
    const state = await submitDisputeCommand(
      TXN,
      IDLE_DISPUTE_FORM,
      formData({ command: 'DISPUTE', reason: 'کوتاه' }, { submission }),
    );
    expect(state).toMatchObject({
      kind: 'INVALID',
      command: 'DISPUTE',
      submissionId: submission,
      values: { reason: 'کوتاه' },
      fieldErrors: { reason: expect.stringContaining('۱۰') },
    });
    expect(issueDisputeCommand).not.toHaveBeenCalled();
  });
});

describe('what the answer becomes', () => {
  it('sends the bound transaction, the one-field body and the submission id; then redirects', async () => {
    const submission = mintSubmissionId(SESSION);
    await expect(
      submitDisputeCommand(TXN, IDLE_DISPUTE_FORM, formData(GOOD, { submission })),
    ).rejects.toThrow(`NEXT_REDIRECT:/transactions/${TXN}?flash=`);
    // The confirmation is a token this session earned for this transaction and
    // command — not a flag anybody could type (review 1, finding 3).
    const url = new URL(redirect.mock.calls[0]![0], 'http://portal.test');
    expect(url.searchParams.has('done')).toBe(false);
    const token = url.searchParams.get('flash');
    expect(readFlash(SESSION, token, TXN, DISPUTE_COMMANDS)).toBe('DISPUTE');
    expect(readFlash(SESSION, token, 'TXN_OTHER', DISPUTE_COMMANDS)).toBeUndefined();
    expect(
      readFlash({ ...SESSION, csrfToken: 'another-login' }, token, TXN, DISPUTE_COMMANDS),
    ).toBeUndefined();
    expect(readFlash(SESSION, 'DISPUTE', TXN, DISPUTE_COMMANDS)).toBeUndefined();
    expect(issueDisputeCommand).toHaveBeenCalledWith(
      SESSION,
      TXN,
      { command: 'DISPUTE', body: { reason: REASON } },
      submission,
    );
  });

  it('ignores a transaction id posted in the form — the page binds it', async () => {
    await expect(
      submitDisputeCommand(TXN, IDLE_DISPUTE_FORM, formData({ ...GOOD, transactionId: 'TXN_X' })),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(issueDisputeCommand.mock.calls[0]![1]).toBe(TXN);
  });

  it('keeps the person’s text and key on a refusal, with the fixed message', async () => {
    issueDisputeCommand.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'پیام ثابت',
      correlationId: 'c',
    });
    const submission = mintSubmissionId(SESSION);
    expect(
      await submitDisputeCommand(TXN, IDLE_DISPUTE_FORM, formData(GOOD, { submission })),
    ).toEqual({
      kind: 'INVALID',
      command: 'DISPUTE',
      submissionId: submission,
      values: { ...EMPTY_DISPUTE_FORM, reason: REASON },
      fieldErrors: {},
      message: 'پیام ثابت',
    });
  });

  it.each([
    [
      { kind: 'FORBIDDEN', correlationId: 'c-403' },
      { kind: 'FORBIDDEN', correlationId: 'c-403' },
    ],
    [{ kind: 'NOT_FOUND', correlationId: 'c-404' }, { kind: 'NOT_FOUND' }],
  ])('maps %j', async (answer, state) => {
    issueDisputeCommand.mockResolvedValue(answer);
    expect(await submitDisputeCommand(TXN, IDLE_DISPUTE_FORM, formData(GOOD))).toEqual(state);
  });

  it.each(['UNKNOWN_OUTCOME', 'IN_PROGRESS'])(
    'reads %s as unconfirmed, keeping what was sent and under which key',
    async (kind) => {
      issueDisputeCommand.mockResolvedValue({
        kind,
        correlationId: 'corr-1',
        retryAfterSeconds: 1,
      });
      const submission = mintSubmissionId(SESSION);
      expect(
        await submitDisputeCommand(
          TXN,
          IDLE_DISPUTE_FORM,
          formData({ command: 'DISPUTE', reason: `  ${REASON}  ` }, { submission }),
        ),
      ).toEqual({
        kind: 'UNCONFIRMED',
        command: 'DISPUTE',
        correlationId: 'corr-1',
        submissionId: submission,
        values: { ...EMPTY_DISPUTE_FORM, reason: REASON },
      });
    },
  );
});

describe('a retry of an unconfirmed command', () => {
  const submission = mintSubmissionId(SESSION);
  const UNCONFIRMED: UnconfirmedDispute = {
    kind: 'UNCONFIRMED',
    command: 'DISPUTE',
    correlationId: 'corr-original',
    submissionId: submission,
    values: { ...EMPTY_DISPUTE_FORM, reason: REASON },
  };
  const retry = (options: { csrf?: string } = {}) => formData(GOOD, { submission, ...options });

  it('sends the same body under the same key', async () => {
    await expect(submitDisputeCommand(TXN, UNCONFIRMED, retry())).rejects.toThrow('NEXT_REDIRECT');
    expect(issueDisputeCommand).toHaveBeenCalledWith(
      SESSION,
      TXN,
      { command: 'DISPUTE', body: { reason: REASON } },
      submission,
    );
  });

  it.each([
    { kind: 'INVALID', fieldErrors: {}, message: 'x', correlationId: 'corr-retry' },
    { kind: 'FORBIDDEN', correlationId: 'corr-retry' },
    { kind: 'NOT_FOUND', correlationId: 'corr-retry' },
  ])('stays unconfirmed when the retry is refused (%j), with the original ids', async (answer) => {
    issueDisputeCommand.mockResolvedValue(answer);
    expect(await submitDisputeCommand(TXN, UNCONFIRMED, retry())).toEqual({
      ...UNCONFIRMED,
      retryRefused: true,
    });
  });

  it('says the session ended — authoritatively — when the action finds none on a retry', async () => {
    currentSession.mockResolvedValue(null);
    expect(await submitDisputeCommand(TXN, UNCONFIRMED, retry())).toEqual({
      ...UNCONFIRMED,
      sessionEnded: true,
    });
  });

  it('a CSRF refusal of a retry is a refusal, not an ended session', async () => {
    expect(await submitDisputeCommand(TXN, UNCONFIRMED, retry({ csrf: 'wrong' }))).toEqual({
      ...UNCONFIRMED,
      retryRefused: true,
    });
  });

  it('keeps the original correlation id when the retry is unconfirmed too', async () => {
    issueDisputeCommand.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'corr-retry' });
    expect(await submitDisputeCommand(TXN, UNCONFIRMED, retry())).toEqual({
      ...UNCONFIRMED,
      retryUnknown: true,
    });
  });

  it('replaces an earlier note rather than piling notes up', async () => {
    issueDisputeCommand.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'corr-retry' });
    expect(
      await submitDisputeCommand(TXN, { ...UNCONFIRMED, retryRefused: true }, retry()),
    ).toEqual({ ...UNCONFIRMED, retryUnknown: true });
  });
});
