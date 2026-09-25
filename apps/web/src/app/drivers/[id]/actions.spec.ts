/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, newSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import {
  IDLE_ASSIGN_FORM,
  IDLE_CHANGE_STATUS_FORM,
  IDLE_END_ASSIGNMENT_FORM,
  IDLE_UPDATE_DRIVER_FORM,
} from './form-state';

/**
 * The `/drivers/[id]` detail page's four write paths.
 *
 * `submitUpdateDriver` carries the full order-of-checks suite, the same as
 * `usage/actions.spec.ts` and `drivers/actions.spec.ts` before it — session,
 * CSRF, submission id, each proven to call nothing on its own. The other
 * three each get what is genuinely new about them: the id they act on comes
 * bound, not from the form, and each redirects to a different query flag.
 */

const currentSession = jest.fn();
const updateDriver = jest.fn();
const changeDriverStatus = jest.fn();
const createAssignment = jest.fn();
const endAssignment = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({ currentSession: () => currentSession() }));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/drivers', () => {
  const actual = jest.requireActual('@/server/drivers');
  return {
    ...actual,
    updateDriver: (...args: unknown[]) => updateDriver(...args),
    changeDriverStatus: (...args: unknown[]) => changeDriverStatus(...args),
  };
});
jest.mock('@/server/assignments', () => {
  const actual = jest.requireActual('@/server/assignments');
  return {
    ...actual,
    createAssignment: (...args: unknown[]) => createAssignment(...args),
    endAssignment: (...args: unknown[]) => endAssignment(...args),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const actions = require('./actions') as typeof import('./actions');
const { submitUpdateDriver, submitChangeStatus, submitAssign, submitEndAssignment } = actions;

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

const DRIVER_ID = 'DRV_1';

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
  updateDriver.mockResolvedValue({
    kind: 'CREATED',
    data: { id: DRIVER_ID },
    correlationId: 'corr-sample',
  });
  changeDriverStatus.mockResolvedValue({
    kind: 'CREATED',
    data: { id: DRIVER_ID },
    correlationId: 'corr-sample',
  });
  createAssignment.mockResolvedValue({
    kind: 'CREATED',
    data: { id: 'ASG_1' },
    correlationId: 'corr-sample',
  });
  endAssignment.mockResolvedValue({
    kind: 'CREATED',
    data: { id: 'ASG_1' },
    correlationId: 'corr-sample',
  });
  redirect.mockClear();
});

describe('updating a driver — the full order of checks', () => {
  it('refuses a post with no session, and calls nothing', async () => {
    currentSession.mockResolvedValue(null);
    const state = await submitUpdateDriver(DRIVER_ID, IDLE_UPDATE_DRIVER_FORM, formData({}));
    expect(state).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
    expect(updateDriver).not.toHaveBeenCalled();
  });

  it('refuses a post with no CSRF token, and calls nothing', async () => {
    const state = await submitUpdateDriver(
      DRIVER_ID,
      IDLE_UPDATE_DRIVER_FORM,
      formData({}, { csrf: null }),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
    expect(updateDriver).not.toHaveBeenCalled();
  });

  it('refuses a submission id this server did not mint, and calls nothing', async () => {
    const state = await submitUpdateDriver(
      DRIVER_ID,
      IDLE_UPDATE_DRIVER_FORM,
      formData({}, { submission: 'chosen-by-the-client' }),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
    expect(updateDriver).not.toHaveBeenCalled();
  });

  it('checks CSRF before the submission id', async () => {
    const state = await submitUpdateDriver(
      DRIVER_ID,
      IDLE_UPDATE_DRIVER_FORM,
      formData({}, { csrf: 'wrong', submission: 'also-wrong' }),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
  });

  it('sends the bound driver id to the service, not one read from the form', async () => {
    await expect(
      submitUpdateDriver(DRIVER_ID, IDLE_UPDATE_DRIVER_FORM, formData({ employeeNo: 'EMP-9' })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(updateDriver).toHaveBeenCalledWith(
      SESSION,
      DRIVER_ID,
      expect.objectContaining({ employeeNo: 'EMP-9' }),
      expect.any(String),
    );
  });

  it('redirects back to this driver with ?updated=1 after a successful write', async () => {
    await expect(
      submitUpdateDriver(DRIVER_ID, IDLE_UPDATE_DRIVER_FORM, formData({})),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirect).toHaveBeenCalledWith(`/drivers/${DRIVER_ID}?updated=1`);
  });

  it('returns the optimistic-lock refusal as a banner, not a field error', async () => {
    updateDriver.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'این رکورد را درخواستی دیگر تغییر داد؛ صفحه را تازه کنید و دوباره تلاش کنید',
      correlationId: 'corr-sample',
    });
    const state = await submitUpdateDriver(DRIVER_ID, IDLE_UPDATE_DRIVER_FORM, formData({}));
    expect(state).toMatchObject({
      kind: 'INVALID',
      message: 'این رکورد را درخواستی دیگر تغییر داد؛ صفحه را تازه کنید و دوباره تلاش کنید',
    });
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe('changing status', () => {
  const VALID = { status: 'SUSPENDED', reason: 'بازبینی مدارک' };

  it('refuses without a session, and calls nothing', async () => {
    currentSession.mockResolvedValue(null);
    const state = await submitChangeStatus(DRIVER_ID, IDLE_CHANGE_STATUS_FORM, formData(VALID));
    expect(state).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
    expect(changeDriverStatus).not.toHaveBeenCalled();
  });

  it('redirects back to this driver with ?statusChanged=1', async () => {
    await expect(
      submitChangeStatus(DRIVER_ID, IDLE_CHANGE_STATUS_FORM, formData(VALID)),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirect).toHaveBeenCalledWith(`/drivers/${DRIVER_ID}?statusChanged=1`);
  });

  it('does not call the service when the reason is missing', async () => {
    const state = await submitChangeStatus(
      DRIVER_ID,
      IDLE_CHANGE_STATUS_FORM,
      formData({ status: 'SUSPENDED', reason: '' }),
    );
    expect(state).toMatchObject({ kind: 'INVALID' });
    expect(changeDriverStatus).not.toHaveBeenCalled();
  });
});

describe('assigning to a machine', () => {
  const VALID = { assetId: 'AST_01JASSET000000000000000000' };

  it('redirects back to this driver with ?assigned=1', async () => {
    await expect(submitAssign(DRIVER_ID, IDLE_ASSIGN_FORM, formData(VALID))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(redirect).toHaveBeenCalledWith(`/drivers/${DRIVER_ID}?assigned=1`);
  });

  it('reports an absent machine on the asset field, not as a generic failure', async () => {
    createAssignment.mockResolvedValue({ kind: 'NOT_FOUND', correlationId: 'corr-sample' });
    const state = await submitAssign(DRIVER_ID, IDLE_ASSIGN_FORM, formData(VALID));
    expect(state).toMatchObject({ kind: 'NOT_FOUND' });
  });

  it('sends one submission twice under one reference — the double-submit case', async () => {
    const submission = newSubmissionId();
    const form = () => formData(VALID, { submission });

    await expect(submitAssign(DRIVER_ID, IDLE_ASSIGN_FORM, form())).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    await expect(submitAssign(DRIVER_ID, IDLE_ASSIGN_FORM, form())).rejects.toThrow(
      /NEXT_REDIRECT/,
    );

    const ids = createAssignment.mock.calls.map((args) => args[2]);
    expect(ids).toEqual([submission, submission]);
  });

  it('translates the double-assignment refusal as a banner', async () => {
    createAssignment.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'این راننده هم‌اکنون یک تخصیص فعال دارد. پیش از تخصیص تازه، آن را پایان دهید',
      correlationId: 'corr-sample',
    });
    const state = await submitAssign(DRIVER_ID, IDLE_ASSIGN_FORM, formData(VALID));
    expect(state).toMatchObject({ kind: 'INVALID' });
  });
});

describe('ending an assignment', () => {
  const ASSIGNMENT_ID = 'ASG_1';

  it('sends the bound assignment id in the path, and the bound driver id in the redirect', async () => {
    await expect(
      submitEndAssignment(DRIVER_ID, ASSIGNMENT_ID, IDLE_END_ASSIGNMENT_FORM, formData({})),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(endAssignment).toHaveBeenCalledWith(
      SESSION,
      ASSIGNMENT_ID,
      expect.anything(),
      expect.any(String),
    );
    expect(redirect).toHaveBeenCalledWith(`/drivers/${DRIVER_ID}?ended=1`);
  });

  it('refuses without a session, and calls nothing', async () => {
    currentSession.mockResolvedValue(null);
    const state = await submitEndAssignment(
      DRIVER_ID,
      ASSIGNMENT_ID,
      IDLE_END_ASSIGNMENT_FORM,
      formData({}),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
    expect(endAssignment).not.toHaveBeenCalled();
  });

  it('shows the already-ended refusal as a banner', async () => {
    endAssignment.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'این تخصیص پیش‌تر پایان یافته است',
      correlationId: 'corr-sample',
    });
    const state = await submitEndAssignment(
      DRIVER_ID,
      ASSIGNMENT_ID,
      IDLE_END_ASSIGNMENT_FORM,
      formData({}),
    );
    expect(state).toMatchObject({ kind: 'INVALID', message: 'این تخصیص پیش‌تر پایان یافته است' });
  });
});
