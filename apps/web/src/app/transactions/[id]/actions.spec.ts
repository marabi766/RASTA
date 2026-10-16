/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';
import { DISPUTE_COMMANDS, EMPTY_DISPUTE_FORM } from '@/lib/transaction-dispute-fields';
import { readFlash } from '@/server/flash';
import { mintReplayStamp, replayWindowSeconds } from '@/server/dispute-replay';
import { REPLAY_FIELD } from '@/lib/form-fields';

import { IDLE_DISPUTE_FORM, type UnconfirmedDispute } from './form-state';

/**
 * The dispute commands' one write path — the order of checks of
 * `place-order-actions.spec.ts`, then what each answer becomes, then the
 * unconfirmed path: a retry under the same key whose refusal or doubt never
 * settles the first request — and, PR 319 review 2, the server's replay
 * deadline (finding 2) and a session that is only unavailable (finding 3).
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const currentSession = jest.fn();
const sessionTemporarilyUnavailable = jest.fn();
const issueDisputeCommand = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({
  currentSession: () => currentSession(),
  sessionTemporarilyUnavailable: () => sessionTemporarilyUnavailable(),
}));
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
  options: { csrf?: string | null; submission?: string | null; replay?: string | null } = {},
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
  if (csrf !== null) form.set(CSRF_FIELD, csrf);
  const submission =
    options.submission === undefined ? mintSubmissionId(SESSION) : options.submission;
  if (submission !== null) form.set(SUBMISSION_FIELD, submission);
  // The stamp the page signed for this transaction and key, unless told otherwise.
  const replay =
    options.replay === undefined
      ? submission === null
        ? null
        : mintReplayStamp(SESSION, TXN, submission).token
      : options.replay;
  if (replay !== null) form.set(REPLAY_FIELD, replay);
  return form;
}

beforeEach(() => {
  currentSession.mockResolvedValue(SESSION);
  sessionTemporarilyUnavailable.mockResolvedValue(false);
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
      const form = formData({ command: 'DISPUTE', reason: `  ${REASON}  ` }, { submission });
      const sentStamp = form.get(REPLAY_FIELD);
      expect(await submitDisputeCommand(TXN, IDLE_DISPUTE_FORM, form)).toEqual({
        kind: 'UNCONFIRMED',
        command: 'DISPUTE',
        correlationId: 'corr-1',
        submissionId: submission,
        values: { ...EMPTY_DISPUTE_FORM, reason: REASON },
        replay: { token: sentStamp, until: expect.any(Number) },
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
    replay: mintReplayStamp(SESSION, TXN, submission),
  };
  const retry = (options: { csrf?: string; replay?: string } = {}) =>
    formData(GOOD, { submission, replay: UNCONFIRMED.replay!.token, ...options });

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

describe('a session that is only unavailable, not ended (PR 319 review 2, finding 3)', () => {
  // Valid login cookie, expired access token, refresh temporarily failing:
  // middleware hid the session and marked the request (`session-state.ts`).
  beforeEach(() => {
    currentSession.mockResolvedValue(null);
    sessionTemporarilyUnavailable.mockResolvedValue(true);
  });

  it('a first send is refused as unavailable — not "ended" — and nothing is sent', async () => {
    expect(await submitDisputeCommand(TXN, IDLE_DISPUTE_FORM, formData(GOOD))).toEqual({
      kind: 'REFUSED',
      reason: 'SESSION_UNAVAILABLE',
    });
    expect(issueDisputeCommand).not.toHaveBeenCalled();
  });

  it('a retry stays unknown, with its retry: the session may come back', async () => {
    const submission = mintSubmissionId(SESSION);
    const previous: UnconfirmedDispute = {
      kind: 'UNCONFIRMED',
      command: 'DISPUTE',
      correlationId: 'corr-original',
      submissionId: submission,
      values: { ...EMPTY_DISPUTE_FORM, reason: REASON },
      replay: mintReplayStamp(SESSION, TXN, submission),
    };
    const state = await submitDisputeCommand(TXN, previous, formData(GOOD, { submission }));
    expect(state).toEqual({ ...previous, retryUnknown: true });
    expect(state).not.toHaveProperty('sessionEnded');
    expect(issueDisputeCommand).not.toHaveBeenCalled();
  });
});

describe('the replay deadline, decided here (PR 319 review 2, finding 2)', () => {
  const window = replayWindowSeconds();
  const submission = mintSubmissionId(SESSION);

  it('is economic-service’s retention less the margin, by default inside its one-hour floor', () => {
    // Defaults: WEB_ECONOMIC_IDEMPOTENCY_TTL_HOURS=1 (the service's floor),
    // WEB_DISPUTE_REPLAY_MARGIN_SECONDS=600.
    expect(window).toBe(60 * 60 - 600);
    expect(
      replayWindowSeconds({
        WEB_ECONOMIC_IDEMPOTENCY_TTL_HOURS: 24,
        WEB_DISPUTE_REPLAY_MARGIN_SECONDS: 900,
      }),
    ).toBe(24 * 60 * 60 - 900);
  });

  it('a retry delayed past the deadline is refused here, never sent, and stays view-only', async () => {
    // The page was drawn (and the stamp signed) just over the window ago: a
    // retry let through now could reach economic after its record expired and
    // run as a new command.
    const stamp = mintReplayStamp(SESSION, TXN, submission, Date.now() - (window + 1) * 1000);
    const previous: UnconfirmedDispute = {
      kind: 'UNCONFIRMED',
      command: 'RESOLVE_DISPUTE',
      correlationId: 'corr-original',
      submissionId: submission,
      values: { ...EMPTY_DISPUTE_FORM, resolution: REASON },
      replay: stamp,
    };
    const state = await submitDisputeCommand(
      TXN,
      previous,
      formData(
        { command: 'RESOLVE_DISPUTE', resolution: REASON },
        { submission, replay: stamp.token },
      ),
    );
    expect(issueDisputeCommand).not.toHaveBeenCalled();
    expect(state).toEqual({
      ...previous,
      replay: null,
      viewOnly: true,
      replayExpired: true,
    });
  });

  it('a stamp issued under a longer retention is refused once the retention is shortened (review 3, finding 1)', async () => {
    // Drawn two hours ago while both retentions were 24 h, so its own signed
    // expiry is still far off; the portal now runs with the 1 h default.
    const issuedUnderLongRetention = mintReplayStamp(
      SESSION,
      TXN,
      submission,
      Date.now() - 2 * 60 * 60 * 1000,
      { WEB_ECONOMIC_IDEMPOTENCY_TTL_HOURS: 24, WEB_DISPUTE_REPLAY_MARGIN_SECONDS: 600 },
    );
    expect(issuedUnderLongRetention.until).toBeGreaterThan(Date.now());
    const previous: UnconfirmedDispute = {
      kind: 'UNCONFIRMED',
      command: 'RESOLVE_DISPUTE',
      correlationId: 'corr-original',
      submissionId: submission,
      values: { ...EMPTY_DISPUTE_FORM, resolution: REASON },
      replay: issuedUnderLongRetention,
    };
    const state = await submitDisputeCommand(
      TXN,
      previous,
      formData(
        { command: 'RESOLVE_DISPUTE', resolution: REASON },
        { submission, replay: issuedUnderLongRetention.token },
      ),
    );
    expect(issueDisputeCommand).not.toHaveBeenCalled();
    expect(state).toEqual({ ...previous, replay: null, viewOnly: true, replayExpired: true });
  });

  it('a retry just inside the deadline is sent, under the same key', async () => {
    const stamp = mintReplayStamp(SESSION, TXN, submission, Date.now() - (window - 5) * 1000);
    const previous: UnconfirmedDispute = {
      kind: 'UNCONFIRMED',
      command: 'DISPUTE',
      correlationId: 'corr-original',
      submissionId: submission,
      values: { ...EMPTY_DISPUTE_FORM, reason: REASON },
      replay: stamp,
    };
    await expect(
      submitDisputeCommand(TXN, previous, formData(GOOD, { submission, replay: stamp.token })),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(issueDisputeCommand.mock.calls[0]![3]).toBe(submission);
  });

  it('a first send past the deadline is refused as an outdated form, and nothing is sent', async () => {
    const stamp = mintReplayStamp(SESSION, TXN, submission, Date.now() - (window + 1) * 1000);
    expect(
      await submitDisputeCommand(
        TXN,
        IDLE_DISPUTE_FORM,
        formData(GOOD, { submission, replay: stamp.token }),
      ),
    ).toEqual({ kind: 'REFUSED', reason: 'REPLAY' });
    expect(issueDisputeCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['typed by the client', 'a-deadline-i-chose'],
    ['for another key', mintReplayStamp(SESSION, TXN, mintSubmissionId(SESSION)).token],
    ['for another transaction', mintReplayStamp(SESSION, 'TXN_OTHER', submission).token],
    [
      'from another login',
      mintReplayStamp({ ...SESSION, csrfToken: 'another-login' }, TXN, submission).token,
    ],
  ])('refuses a stamp that is %s, and sends nothing', async (_label, replay) => {
    expect(
      await submitDisputeCommand(TXN, IDLE_DISPUTE_FORM, formData(GOOD, { submission, replay })),
    ).toEqual({ kind: 'REFUSED', reason: 'REPLAY' });
    expect(issueDisputeCommand).not.toHaveBeenCalled();
  });

  it('cannot be extended from the browser: its own copy of the deadline is not read', async () => {
    const stamp = mintReplayStamp(SESSION, TXN, submission, Date.now() - (window + 1) * 1000);
    const form = formData(GOOD, { submission, replay: stamp.token });
    form.set('until', String(Date.now() + 60 * 60 * 1000));
    expect(await submitDisputeCommand(TXN, IDLE_DISPUTE_FORM, form)).toEqual({
      kind: 'REFUSED',
      reason: 'REPLAY',
    });
  });
});
