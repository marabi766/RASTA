/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, isBoundSubmissionId, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import { EDIT_AS_NEW_INTENT, IDLE_REPORT_REQUEST_FORM, REPORT_INTENT_FIELD } from './form-state';

/**
 * The `/maintenance` report form's write path, from a posted form to a call on
 * the gateway. Mirrors `drivers/actions.spec.ts`: the order is the assertion,
 * each refusal proves nothing was called, and a retry of one rendered form is
 * shown to carry the same reference.
 *
 * It does **not** claim a retry is one request: that maintenance-service's
 * create path answers a repeated key with the original 201 (issue 157) is a
 * property of the service, proven in its own integration tests, not of this
 * action.
 */

const currentSession = jest.fn();
const reportMaintenanceRequest = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({ currentSession: () => currentSession() }));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/maintenance-commands', () => {
  const actual = jest.requireActual('@/server/maintenance-commands');
  return {
    ...actual,
    reportMaintenanceRequest: (...args: unknown[]) => reportMaintenanceRequest(...args),
  };
});

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { submitReportRequest } = require('./actions') as typeof import('./actions');

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
  assetId: 'AST_01J00000000000000000000000',
  type: 'CORRECTIVE',
  title: 'نشتی روغن هیدرولیک',
  severity: 'HIGH',
};

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
  reportMaintenanceRequest.mockResolvedValue({
    kind: 'CREATED',
    data: { id: 'MRQ_1' },
    correlationId: 'corr-sample',
  });
  redirect.mockClear();
  reportMaintenanceRequest.mockClear();
});

describe('what is refused before anything is called', () => {
  it('refuses a post with no session', async () => {
    currentSession.mockResolvedValue(null);
    const state = await submitReportRequest(IDLE_REPORT_REQUEST_FORM, formData(VALID));
    expect(state).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
    expect(reportMaintenanceRequest).not.toHaveBeenCalled();
  });

  it('refuses a post with no CSRF token, and calls nothing', async () => {
    const state = await submitReportRequest(
      IDLE_REPORT_REQUEST_FORM,
      formData(VALID, { csrf: null }),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
    expect(reportMaintenanceRequest).not.toHaveBeenCalled();
  });

  it('refuses a token from another session', async () => {
    const state = await submitReportRequest(
      IDLE_REPORT_REQUEST_FORM,
      formData(VALID, { csrf: 'someone-elses' }),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
    expect(reportMaintenanceRequest).not.toHaveBeenCalled();
  });

  it('refuses a submission id the client chose in the original, unbound format', async () => {
    const state = await submitReportRequest(
      IDLE_REPORT_REQUEST_FORM,
      formData(VALID, { submission: 'chosen-by-the-client' }),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
    expect(reportMaintenanceRequest).not.toHaveBeenCalled();
  });

  it('refuses an id in the old random format, which only ever proved its own shape', async () => {
    const state = await submitReportRequest(
      IDLE_REPORT_REQUEST_FORM,
      formData(VALID, { submission: `sub_${'B'.repeat(20)}` }),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
    expect(reportMaintenanceRequest).not.toHaveBeenCalled();
  });

  it('refuses a well-formed id this server never issued, and calls nothing', async () => {
    // Right prefix, right length, right alphabet — and nobody's MAC. This is
    // the case a shape check alone waves through.
    for (const submission of [`sub_${'A'.repeat(38)}`, `sub_${'Zz9_-'.repeat(8)}ab`]) {
      const state = await submitReportRequest(
        IDLE_REPORT_REQUEST_FORM,
        formData(VALID, { submission }),
      );
      expect(state).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
    }
    expect(reportMaintenanceRequest).not.toHaveBeenCalled();
  });

  it('refuses an id minted for somebody else, and one from an earlier login', async () => {
    const theirs = mintSubmissionId({ ...SESSION, subject: 'someone-else' });
    const earlier = mintSubmissionId({ ...SESSION, csrfToken: 'the-token-before-re-login' });
    for (const submission of [theirs, earlier]) {
      const state = await submitReportRequest(
        IDLE_REPORT_REQUEST_FORM,
        formData(VALID, { submission }),
      );
      expect(state).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
    }
    expect(reportMaintenanceRequest).not.toHaveBeenCalled();
  });

  it('accepts an id this server minted for this session', async () => {
    await expect(submitReportRequest(IDLE_REPORT_REQUEST_FORM, formData(VALID))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(reportMaintenanceRequest).toHaveBeenCalledTimes(1);
  });
});

describe('what the form itself catches', () => {
  it('does not call the service for a form missing required fields', async () => {
    const state = await submitReportRequest(
      IDLE_REPORT_REQUEST_FORM,
      formData({ assetId: '', type: 'CORRECTIVE', title: '' }),
    );
    expect(state).toMatchObject({
      kind: 'INVALID',
      fieldErrors: {
        assetId: expect.any(String),
        title: expect.any(String),
        severity: 'برای خرابی، شدت را مشخص کنید',
      },
    });
    expect(reportMaintenanceRequest).not.toHaveBeenCalled();
  });

  it('keeps what the person typed, and the submission id it came with', async () => {
    const submission = mintSubmissionId(SESSION);
    const state = await submitReportRequest(
      IDLE_REPORT_REQUEST_FORM,
      formData({ ...VALID, title: '', description: 'شرح من' }, { submission }),
    );
    expect(state).toMatchObject({
      kind: 'INVALID',
      submissionId: submission,
      values: { assetId: VALID.assetId, description: 'شرح من' },
    });
  });
});

describe('what reaches the service', () => {
  it('redirects to the new request after a successful write', async () => {
    await expect(submitReportRequest(IDLE_REPORT_REQUEST_FORM, formData(VALID))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(redirect).toHaveBeenCalledWith('/maintenance/MRQ_1?created=1');
  });

  it('percent-encodes the id it redirects to', async () => {
    reportMaintenanceRequest.mockResolvedValue({
      kind: 'CREATED',
      data: { id: 'a/b?c' },
      correlationId: 'corr-sample',
    });
    await expect(submitReportRequest(IDLE_REPORT_REQUEST_FORM, formData(VALID))).rejects.toThrow();
    expect(redirect).toHaveBeenCalledWith('/maintenance/a%2Fb%3Fc?created=1');
  });

  it('sends the parsed request under the session, not the raw form', async () => {
    const submission = mintSubmissionId(SESSION);
    await expect(
      submitReportRequest(IDLE_REPORT_REQUEST_FORM, formData(VALID, { submission })),
    ).rejects.toThrow();

    const [session, request, submissionId] = reportMaintenanceRequest.mock.calls[0];
    expect(session).toBe(SESSION);
    expect(request).toEqual({
      assetId: VALID.assetId,
      type: 'CORRECTIVE',
      title: VALID.title,
      severity: 'HIGH',
    });
    expect(submissionId).toBe(submission);
  });

  it('carries the same reference when one rendered form is posted twice', async () => {
    // A statement about what this action sends, not about what the service
    // does with it (see the header).
    const submission = mintSubmissionId(SESSION);
    const form = () => formData(VALID, { submission });

    await expect(submitReportRequest(IDLE_REPORT_REQUEST_FORM, form())).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    await expect(submitReportRequest(IDLE_REPORT_REQUEST_FORM, form())).rejects.toThrow(
      /NEXT_REDIRECT/,
    );

    const ids = reportMaintenanceRequest.mock.calls.map((args) => args[2]);
    expect(ids).toEqual([submission, submission]);
  });
});

describe('what the service refuses', () => {
  it('returns the service field errors with the values still in hand', async () => {
    reportMaintenanceRequest.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: { title: 'عنوان را کوتاه‌تر کنید' },
      message: null,
      correlationId: 'corr-sample',
    });

    const state = await submitReportRequest(IDLE_REPORT_REQUEST_FORM, formData(VALID));
    expect(state).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { title: 'عنوان را کوتاه‌تر کنید' },
      values: { assetId: VALID.assetId },
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('returns a business-rule sentence as the form message', async () => {
    reportMaintenanceRequest.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'این ماشین همین حالا یک درخواست باز از همین نوع دارد.',
      correlationId: 'corr-sample',
    });

    const state = await submitReportRequest(IDLE_REPORT_REQUEST_FORM, formData(VALID));
    expect(state).toMatchObject({
      kind: 'INVALID',
      message: 'این ماشین همین حالا یک درخواست باز از همین نوع دارد.',
    });
  });

  it('answers a machine that is not visible with its own state, keeping what was typed', async () => {
    reportMaintenanceRequest.mockResolvedValue({ kind: 'NOT_FOUND', correlationId: 'corr-sample' });

    const submission = mintSubmissionId(SESSION);
    const state = await submitReportRequest(
      IDLE_REPORT_REQUEST_FORM,
      formData(VALID, { submission }),
    );
    expect(state).toMatchObject({
      kind: 'NOT_FOUND',
      submissionId: submission,
      correlationId: 'corr-sample',
      values: { assetId: VALID.assetId },
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('reports a forbidden write with its correlation id', async () => {
    reportMaintenanceRequest.mockResolvedValue({ kind: 'FORBIDDEN', correlationId: 'corr-sample' });
    expect(await submitReportRequest(IDLE_REPORT_REQUEST_FORM, formData(VALID))).toEqual({
      kind: 'FORBIDDEN',
      correlationId: 'corr-sample',
    });
  });

  it('reports a sent-but-unconfirmed write as UNCONFIRMED, never as a failure', async () => {
    // The service may have created the request; "nothing was saved" would
    // invite a retry that reports a duplicate.
    reportMaintenanceRequest.mockResolvedValue({
      kind: 'UNKNOWN_OUTCOME',
      correlationId: 'corr-sample',
    });
    expect(await submitReportRequest(IDLE_REPORT_REQUEST_FORM, formData(VALID))).toEqual({
      kind: 'UNCONFIRMED',
      correlationId: 'corr-sample',
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('keeps a submission still in flight retryable: same values, same submission id, the wait', async () => {
    // Round 1 on PR 171: a 409 CONFLICT with Retry-After is the first submission
    // still being processed — not an invalid form. Sent again with the same
    // id after the wait, it is answered with that first request's result.
    reportMaintenanceRequest.mockResolvedValue({
      kind: 'IN_PROGRESS',
      retryAfterSeconds: 1,
      correlationId: 'corr-sample',
    });
    const submission = mintSubmissionId(SESSION);
    const state = await submitReportRequest(
      IDLE_REPORT_REQUEST_FORM,
      formData(VALID, { submission }),
    );
    expect(state).toEqual({
      kind: 'IN_PROGRESS',
      submissionId: submission,
      values: expect.objectContaining({ assetId: VALID.assetId, title: VALID.title }),
      retryAfterSeconds: 1,
      correlationId: 'corr-sample',
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('answers "edit and send as new" with the values under a NEW bound submission id, sending nothing', async () => {
    // Round 2 on PR 171: the edited form is a new request, never a changed body
    // under the first submission's id.
    const first = mintSubmissionId(SESSION);
    const form = formData({ ...VALID, title: 'عنوانی دیگر' }, { submission: first });
    form.set(REPORT_INTENT_FIELD, EDIT_AS_NEW_INTENT);

    const state = await submitReportRequest(IDLE_REPORT_REQUEST_FORM, form);

    expect(reportMaintenanceRequest).not.toHaveBeenCalled();
    expect(state).toEqual({
      kind: 'EDITING',
      submissionId: expect.any(String),
      values: expect.objectContaining({ title: 'عنوانی دیگر', assetId: VALID.assetId }),
    });
    const fresh = (state as { submissionId: string }).submissionId;
    expect(fresh).not.toBe(first);
    expect(isBoundSubmissionId(fresh, SESSION)).toBe(true);
  });

  it('still checks the session, CSRF and the submission id before "edit and send as new"', async () => {
    const form = formData(VALID, { csrf: 'not-this-session' });
    form.set(REPORT_INTENT_FIELD, EDIT_AS_NEW_INTENT);
    expect(await submitReportRequest(IDLE_REPORT_REQUEST_FORM, form)).toEqual({
      kind: 'REFUSED',
      reason: 'CSRF',
    });
  });

  it('reports an outage with its status and correlation id', async () => {
    reportMaintenanceRequest.mockResolvedValue({
      kind: 'UNAVAILABLE',
      status: 503,
      correlationId: 'corr-sample',
    });
    expect(await submitReportRequest(IDLE_REPORT_REQUEST_FORM, formData(VALID))).toEqual({
      kind: 'FAILED',
      status: 503,
      correlationId: 'corr-sample',
    });
  });
});

describe('nothing token-shaped leaves in the state', () => {
  it('never puts a token in what the page renders', async () => {
    reportMaintenanceRequest.mockResolvedValue({
      kind: 'UNAVAILABLE',
      status: 503,
      correlationId: 'corr-sample',
    });
    const state = await submitReportRequest(IDLE_REPORT_REQUEST_FORM, formData(VALID));
    const text = JSON.stringify(state);
    expect(text).not.toContain(SESSION.accessToken);
    expect(text).not.toContain(SESSION.refreshToken);
    expect(text).not.toContain(SESSION.csrfToken);
  });
});
