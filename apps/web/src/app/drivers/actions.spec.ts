/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, newSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import { IDLE_CREATE_DRIVER_FORM } from './form-state';

/**
 * The `/drivers` registration form's write path, from a posted form to a
 * call on the gateway. Mirrors `usage/actions.spec.ts` (PR #75): the order
 * is the assertion, each refusal proves nothing was called, and the
 * double-submit case proves a retry is one record, not two.
 */

const currentSession = jest.fn();
const createDriver = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({ currentSession: () => currentSession() }));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/drivers', () => {
  const actual = jest.requireActual('@/server/drivers');
  return { ...actual, createDriver: (...args: unknown[]) => createDriver(...args) };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { submitCreateDriver } = require('./actions') as typeof import('./actions');

const SESSION = {
  subject: 'user-1',
  username: 'manager',
  organizationId: 'ORG-DEH-0001',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const VALID = { userId: 'USR_01J00000000000000000000000' };

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
  createDriver.mockResolvedValue({
    kind: 'CREATED',
    data: { id: 'DRV_1' },
    correlationId: 'corr-sample',
  });
  redirect.mockClear();
});

describe('what is refused before anything is called', () => {
  it('refuses a post with no session', async () => {
    currentSession.mockResolvedValue(null);
    const state = await submitCreateDriver(IDLE_CREATE_DRIVER_FORM, formData(VALID));
    expect(state).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
    expect(createDriver).not.toHaveBeenCalled();
  });

  it('refuses a post with no CSRF token, and calls nothing', async () => {
    const state = await submitCreateDriver(
      IDLE_CREATE_DRIVER_FORM,
      formData(VALID, { csrf: null }),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
    expect(createDriver).not.toHaveBeenCalled();
  });

  it('refuses a token from another session', async () => {
    const state = await submitCreateDriver(
      IDLE_CREATE_DRIVER_FORM,
      formData(VALID, { csrf: 'someone-elses' }),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
    expect(createDriver).not.toHaveBeenCalled();
  });

  it('refuses a submission id this server did not mint', async () => {
    const state = await submitCreateDriver(
      IDLE_CREATE_DRIVER_FORM,
      formData(VALID, { submission: 'chosen-by-the-client' }),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
    expect(createDriver).not.toHaveBeenCalled();
  });
});

describe('what the form itself catches', () => {
  it('does not call the service for a form missing a required field', async () => {
    const state = await submitCreateDriver(IDLE_CREATE_DRIVER_FORM, formData({ userId: '' }));
    expect(state).toMatchObject({ kind: 'INVALID' });
    expect(createDriver).not.toHaveBeenCalled();
  });
});

describe('what reaches the service', () => {
  it('redirects to the new driver after a successful write', async () => {
    await expect(submitCreateDriver(IDLE_CREATE_DRIVER_FORM, formData(VALID))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(redirect).toHaveBeenCalledWith('/drivers/DRV_1?created=1');
  });

  it('sends one submission twice under one reference — the double-submit case', async () => {
    const submission = newSubmissionId();
    const form = () => formData(VALID, { submission });

    await expect(submitCreateDriver(IDLE_CREATE_DRIVER_FORM, form())).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    await expect(submitCreateDriver(IDLE_CREATE_DRIVER_FORM, form())).rejects.toThrow(
      /NEXT_REDIRECT/,
    );

    const ids = createDriver.mock.calls.map((args) => args[2]);
    expect(ids).toEqual([submission, submission]);
  });
});

describe('what the service refuses', () => {
  it('returns the service field errors with the values still in hand', async () => {
    createDriver.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: { userId: 'این کاربر پیش‌تر در این سازمان به‌عنوان راننده ثبت شده است' },
      message: null,
      correlationId: 'corr-sample',
    });

    const state = await submitCreateDriver(IDLE_CREATE_DRIVER_FORM, formData(VALID));
    expect(state).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { userId: 'این کاربر پیش‌تر در این سازمان به‌عنوان راننده ثبت شده است' },
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('reports an outage with its status and correlation id', async () => {
    createDriver.mockResolvedValue({
      kind: 'UNAVAILABLE',
      status: 503,
      correlationId: 'corr-sample',
    });
    expect(await submitCreateDriver(IDLE_CREATE_DRIVER_FORM, formData(VALID))).toEqual({
      kind: 'FAILED',
      status: 503,
      correlationId: 'corr-sample',
    });
  });
});
