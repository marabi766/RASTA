/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, newSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import { IDLE_UPDATE_ASSET_FORM } from './form-state';

/**
 * The `/assets/[id]` edit form's write path. Mirrors `drivers/[id]/actions.spec.ts`:
 * the order is the assertion, each refusal proves nothing was called, and the
 * asset id arrives bound to the action — never as form content.
 */

const currentSession = jest.fn();
const updateAsset = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({ currentSession: () => currentSession() }));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/asset-commands', () => {
  const actual = jest.requireActual('@/server/asset-commands');
  return { ...actual, updateAsset: (...args: unknown[]) => updateAsset(...args) };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { submitUpdateAsset } = require('./actions') as typeof import('./actions');

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

const ASSET_ID = 'AST_01J00000000000000000000000';
const VALID = { name: 'لودر کوماتسو', assetTag: 'AB-12', manufactureYear: '2019' };

/** What the page does: bind the id the form does not collect. */
const submit = (form: FormData, id = ASSET_ID) =>
  submitUpdateAsset.bind(null, id)(IDLE_UPDATE_ASSET_FORM, form);

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
  updateAsset.mockResolvedValue({
    kind: 'CREATED',
    data: { id: ASSET_ID },
    correlationId: 'corr-sample',
  });
  redirect.mockClear();
  updateAsset.mockClear();
});

describe('what is refused before anything is called', () => {
  it('refuses a post with no session', async () => {
    currentSession.mockResolvedValue(null);
    expect(await submit(formData(VALID))).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
    expect(updateAsset).not.toHaveBeenCalled();
  });

  it('refuses a post with no CSRF token, and calls nothing', async () => {
    expect(await submit(formData(VALID, { csrf: null }))).toEqual({
      kind: 'REFUSED',
      reason: 'CSRF',
    });
    expect(updateAsset).not.toHaveBeenCalled();
  });

  it('refuses a token from another session', async () => {
    expect(await submit(formData(VALID, { csrf: 'someone-elses' }))).toEqual({
      kind: 'REFUSED',
      reason: 'CSRF',
    });
    expect(updateAsset).not.toHaveBeenCalled();
  });

  it('refuses a submission id this server did not mint', async () => {
    expect(await submit(formData(VALID, { submission: 'chosen-by-the-client' }))).toEqual({
      kind: 'REFUSED',
      reason: 'SUBMISSION',
    });
    expect(updateAsset).not.toHaveBeenCalled();
  });
});

describe('what the form itself catches', () => {
  it('does not call the service when the name was cleared', async () => {
    const state = await submit(formData({ ...VALID, name: '' }));
    expect(state).toMatchObject({ kind: 'INVALID', fieldErrors: { name: expect.any(String) } });
    expect(updateAsset).not.toHaveBeenCalled();
  });

  it('keeps what the person typed, and the submission id it came with', async () => {
    const submission = newSubmissionId();
    const state = await submit(
      formData({ ...VALID, manufactureYear: '99', model: 'WA320' }, { submission }),
    );
    expect(state).toMatchObject({
      kind: 'INVALID',
      submissionId: submission,
      values: { name: 'لودر کوماتسو', model: 'WA320', manufactureYear: '99' },
    });
  });
});

describe('what reaches the service', () => {
  it('redirects back to the dossier with the update confirmed', async () => {
    await expect(submit(formData(VALID))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirect).toHaveBeenCalledWith(`/assets/${ASSET_ID}?updated=1`);
  });

  it('redirects to the id it was bound to, percent-encoded, not to anything the service returned', async () => {
    updateAsset.mockResolvedValue({
      kind: 'CREATED',
      data: { id: 'SOMETHING_ELSE' },
      correlationId: 'corr-sample',
    });
    await expect(submit(formData(VALID), 'a/b?c')).rejects.toThrow();
    expect(redirect).toHaveBeenCalledWith('/assets/a%2Fb%3Fc?updated=1');
  });

  it('acts on the bound id, and a posted field of the same name cannot change it', async () => {
    await expect(
      submit(formData({ ...VALID, id: 'AST_OTHER', assetId: 'AST_OTHER' })),
    ).rejects.toThrow();

    const [session, assetId, request] = updateAsset.mock.calls[0];
    expect(session).toBe(SESSION);
    expect(assetId).toBe(ASSET_ID);
    expect(request).not.toHaveProperty('id');
    expect(request).not.toHaveProperty('assetId');
  });

  it('sends every field, as a value or null, under the session — not the raw form', async () => {
    const submission = newSubmissionId();
    await expect(
      submit(formData({ ...VALID, manufactureYear: '۱۴۰۲' }, { submission })),
    ).rejects.toThrow();

    const [, , request, submissionId] = updateAsset.mock.calls[0];
    expect(request).toEqual({
      name: 'لودر کوماتسو',
      assetTag: 'AB-12',
      manufacturer: null,
      model: null,
      manufactureYear: 1402,
    });
    expect(submissionId).toBe(submission);
  });

  it('sends one submission twice under one reference — the double-submit case', async () => {
    const submission = newSubmissionId();
    const form = () => formData(VALID, { submission });

    await expect(submit(form())).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(submit(form())).rejects.toThrow(/NEXT_REDIRECT/);

    expect(updateAsset.mock.calls.map((args) => args[3])).toEqual([submission, submission]);
  });
});

describe('what the service refuses', () => {
  it('returns the service field errors with the values still in hand', async () => {
    updateAsset.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: { assetTag: 'شمارهٔ دارایی تکراری است' },
      message: null,
      correlationId: 'corr-sample',
    });

    expect(await submit(formData(VALID))).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { assetTag: 'شمارهٔ دارایی تکراری است' },
      values: { assetTag: 'AB-12' },
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('answers a machine that is no longer visible with its own state, never saying which', async () => {
    updateAsset.mockResolvedValue({ kind: 'NOT_FOUND', correlationId: 'corr-sample' });

    expect(await submit(formData(VALID))).toEqual({
      kind: 'NOT_FOUND',
      correlationId: 'corr-sample',
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('reports a forbidden write with its correlation id', async () => {
    updateAsset.mockResolvedValue({ kind: 'FORBIDDEN', correlationId: 'corr-sample' });
    expect(await submit(formData(VALID))).toEqual({
      kind: 'FORBIDDEN',
      correlationId: 'corr-sample',
    });
  });

  it('reports a sent-but-unconfirmed write as UNCONFIRMED, never as a failure', async () => {
    updateAsset.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'corr-sample' });
    expect(await submit(formData(VALID))).toEqual({
      kind: 'UNCONFIRMED',
      correlationId: 'corr-sample',
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('reports an outage with its status and correlation id', async () => {
    updateAsset.mockResolvedValue({
      kind: 'UNAVAILABLE',
      status: 503,
      correlationId: 'corr-sample',
    });
    expect(await submit(formData(VALID))).toEqual({
      kind: 'FAILED',
      status: 503,
      correlationId: 'corr-sample',
    });
  });

  it('never puts a token in what the page renders', async () => {
    updateAsset.mockResolvedValue({
      kind: 'UNAVAILABLE',
      status: 503,
      correlationId: 'corr-sample',
    });
    const text = JSON.stringify(await submit(formData(VALID)));
    expect(text).not.toContain(SESSION.accessToken);
    expect(text).not.toContain(SESSION.refreshToken);
    expect(text).not.toContain(SESSION.csrfToken);
  });
});
