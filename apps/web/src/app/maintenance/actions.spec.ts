/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, newSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import { IDLE_REPORT_REQUEST_FORM } from './form-state';

/**
 * The `/maintenance` report form's write path, from a posted form to a call on
 * the gateway. Mirrors `drivers/actions.spec.ts`: the order is the assertion,
 * each refusal proves nothing was called, and the double-submit case proves a
 * retry is one request, not two.
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
  const submission = options.submission === undefined ? newSubmissionId() : options.submission;
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

  it('refuses a submission id this server did not mint', async () => {
    const state = await submitReportRequest(
      IDLE_REPORT_REQUEST_FORM,
      formData(VALID, { submission: 'chosen-by-the-client' }),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
    expect(reportMaintenanceRequest).not.toHaveBeenCalled();
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
    const submission = newSubmissionId();
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
    const submission = newSubmissionId();
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

  it('sends one submission twice under one reference — the double-submit case', async () => {
    const submission = newSubmissionId();
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

    const submission = newSubmissionId();
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
