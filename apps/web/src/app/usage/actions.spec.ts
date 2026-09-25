/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, newSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import { IDLE_USAGE_FORM } from './form-state';

/**
 * The write path, from a posted form to a call on the gateway.
 *
 * The order is the assertion: session, then CSRF, then the submission id,
 * then the form, then the service. Each of the first three has a test that
 * proves **nothing was called** when it fails — a refusal that still reaches
 * the gateway is not a refusal.
 *
 * `currentSession` and `recordUsage` are stubbed because this is about the
 * handler's own logic; the gateway call itself is covered against a real
 * `fetch` in `server/write.spec.ts`, and against the running service in the
 * browser suite.
 */

const currentSession = jest.fn();
const recordUsage = jest.fn();
const redirect = jest.fn((url: string) => {
  // Next's `redirect` throws to unwind; the real one is indistinguishable
  // from an exception to the code under test, so the stub throws too.
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({ currentSession: () => currentSession() }));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/usage', () => {
  const actual = jest.requireActual('@/server/usage');
  return { ...actual, recordUsage: (...args: unknown[]) => recordUsage(...args) };
});

// Imported after the mocks so the module under test picks them up.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { submitUsage } = require('./actions') as typeof import('./actions');

const SESSION = {
  subject: 'user-1',
  username: 'operator',
  organizationId: 'ORG-DEH-0001',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const VALID = {
  assetId: 'AST_01JASSET000000000000000000',
  periodStart: '2026-09-21T08:00',
  periodEnd: '2026-09-21T16:30',
  hours: '8.5',
};

function formData(
  fields: Record<string, string>,
  options: { csrf?: string | null; submission?: string | null } = {},
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
  if (csrf !== null) form.set(CSRF_FIELD, csrf);
  const submission = options.submission === undefined ? newSubmissionId() : options.submission;
  if (submission !== null) form.set(SUBMISSION_FIELD, submission);
  return form;
}

beforeEach(() => {
  currentSession.mockResolvedValue(SESSION);
  recordUsage.mockResolvedValue({
    kind: 'CREATED',
    data: { id: 'USG_1' },
    correlationId: 'corr-sample',
  });
  redirect.mockClear();
});

describe('what is refused before anything is called', () => {
  it('refuses a post with no session', async () => {
    currentSession.mockResolvedValue(null);
    const state = await submitUsage(IDLE_USAGE_FORM, formData(VALID));

    expect(state).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('refuses a post with no CSRF token, and calls nothing', async () => {
    const state = await submitUsage(IDLE_USAGE_FORM, formData(VALID, { csrf: null }));

    expect(state).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('refuses a token from another session — the cross-site case', async () => {
    const state = await submitUsage(IDLE_USAGE_FORM, formData(VALID, { csrf: 'someone-elses' }));

    expect(state).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('refuses a stale token after the session was replaced', async () => {
    // A person who logs in again gets a new session and a new token; a form
    // left open in another tab still carries the old one.
    currentSession.mockResolvedValue({ ...SESSION, csrfToken: 'a-newer-token' });
    const state = await submitUsage(IDLE_USAGE_FORM, formData(VALID));

    expect(state).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('refuses a submission id this server did not mint', async () => {
    const state = await submitUsage(
      IDLE_USAGE_FORM,
      formData(VALID, { submission: 'chosen-by-the-client' }),
    );

    expect(state).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('refuses a form with no submission id at all', async () => {
    const state = await submitUsage(IDLE_USAGE_FORM, formData(VALID, { submission: null }));

    expect(state).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('checks CSRF before the submission id, so a forged post learns nothing else', async () => {
    const state = await submitUsage(
      IDLE_USAGE_FORM,
      formData(VALID, { csrf: 'wrong', submission: 'also-wrong' }),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
  });
});

describe('what the form itself catches', () => {
  it('does not call the service for a form it can already see is incomplete', async () => {
    const state = await submitUsage(
      IDLE_USAGE_FORM,
      formData({ ...VALID, hours: '', kilometres: '' }),
    );

    expect(state).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { hours: 'دست‌کم یکی از ساعت کارکرد یا کیلومتر را وارد کنید' },
    });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('keeps the values and the submission id so the retry is the same submission', async () => {
    const submission = newSubmissionId();
    const state = await submitUsage(
      IDLE_USAGE_FORM,
      formData({ ...VALID, hours: 'abc' }, { submission }),
    );

    expect(state).toMatchObject({
      kind: 'INVALID',
      submissionId: submission,
      values: { assetId: VALID.assetId, hours: 'abc' },
    });
  });
});

describe('what reaches the service', () => {
  it('sends the parsed request with the submission id as the client reference', async () => {
    const submission = newSubmissionId();
    await expect(submitUsage(IDLE_USAGE_FORM, formData(VALID, { submission }))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );

    expect(recordUsage).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({
        assetId: VALID.assetId,
        periodStart: '2026-09-21T04:30:00.000Z',
        source: 'MANUAL',
        clientReference: submission,
      }),
    );
  });

  it('redirects after a successful write, so a refresh cannot resubmit it', async () => {
    await expect(submitUsage(IDLE_USAGE_FORM, formData(VALID))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirect).toHaveBeenCalledWith('/usage?created=USG_1');
  });

  it('sends one submission twice under one reference — the double-submit case', async () => {
    // A double click posts the same form twice. Both carry the id minted for
    // that render, so fleet-service's `clientReference` dedupe returns the
    // original record for the second — and the portal's part of that promise
    // is exactly this: the same reference, never a fresh one.
    const submission = newSubmissionId();
    const form = () => formData(VALID, { submission });

    await expect(submitUsage(IDLE_USAGE_FORM, form())).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(submitUsage(IDLE_USAGE_FORM, form())).rejects.toThrow(/NEXT_REDIRECT/);

    const references = recordUsage.mock.calls.map(
      (args) => (args[1] as { clientReference: string }).clientReference,
    );
    expect(references).toEqual([submission, submission]);
  });

  it('gives a different reference to a different render, so two real records stay two', async () => {
    await expect(submitUsage(IDLE_USAGE_FORM, formData(VALID))).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(submitUsage(IDLE_USAGE_FORM, formData(VALID))).rejects.toThrow(/NEXT_REDIRECT/);

    const [first, second] = recordUsage.mock.calls.map(
      (args) => (args[1] as { clientReference: string }).clientReference,
    );
    expect(first).not.toBe(second);
  });
});

describe('what the service refuses', () => {
  it('returns the service field errors with the values still in hand', async () => {
    recordUsage.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: { periodEnd: 'پایان بازه باید پس از شروع آن باشد' },
      message: null,
      correlationId: 'corr-sample',
    });

    const state = await submitUsage(IDLE_USAGE_FORM, formData(VALID));
    expect(state).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { periodEnd: 'پایان بازه باید پس از شروع آن باشد' },
      values: { assetId: VALID.assetId },
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('keeps a refusal and an absence apart', async () => {
    recordUsage.mockResolvedValue({ kind: 'FORBIDDEN', correlationId: 'corr-sample' });
    expect(await submitUsage(IDLE_USAGE_FORM, formData(VALID))).toMatchObject({
      kind: 'FORBIDDEN',
    });

    recordUsage.mockResolvedValue({ kind: 'NOT_FOUND', correlationId: 'corr-sample' });
    expect(await submitUsage(IDLE_USAGE_FORM, formData(VALID))).toMatchObject({
      kind: 'NOT_FOUND',
    });
  });

  it('reports an outage with its status and correlation id', async () => {
    recordUsage.mockResolvedValue({
      kind: 'UNAVAILABLE',
      status: 503,
      correlationId: 'corr-sample',
    });

    expect(await submitUsage(IDLE_USAGE_FORM, formData(VALID))).toEqual({
      kind: 'FAILED',
      status: 503,
      correlationId: 'corr-sample',
    });
  });

  it('never puts anything token-shaped in the state it returns', async () => {
    // The state is rendered into the page and readable by any script on it.
    recordUsage.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'no',
      correlationId: 'corr-sample',
    });

    const state = await submitUsage(IDLE_USAGE_FORM, formData(VALID));
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain(SESSION.accessToken);
    expect(serialized).not.toContain(SESSION.refreshToken);
    expect(serialized).not.toContain(SESSION.csrfToken);
  });
});
