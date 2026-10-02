/**
 * @jest-environment node
 */
import { BASELINE_FIELD } from '@/lib/form-fields';
import { sealAssetBaseline, ASSET_EDIT_CONFLICT_MESSAGE } from '@/server/asset-commands';
import { CSRF_FIELD } from '@/server/csrf';
import { readFlash } from '@/server/flash';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
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

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
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
/** The right length and alphabet, but not issued by `mintSubmissionId`. */
const UNMINTED_ID = `sub_${'A'.repeat(38)}`;

/** What the form was drawn from: the machine's record at version 5. */
const BASELINE = {
  name: 'لودر کوماتسو',
  assetTag: 'AB-12',
  manufacturer: '',
  model: '',
  manufactureYear: '2019',
};
const VERSION = 5;

/** The form as posted after the person changed the tag and nothing else. */
const VALID = { ...BASELINE, assetTag: 'AB-13' };

/** What the page does: bind the id the form does not collect. */
const submit = (form: FormData, id = ASSET_ID) =>
  submitUpdateAsset.bind(null, id)(IDLE_UPDATE_ASSET_FORM, form);

function formData(
  fields: Record<string, string>,
  options: {
    csrf?: string | null;
    submission?: string | null;
    /** `undefined`: the one this server signed for this machine. */
    baseline?: string | null;
  } = {},
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
  if (csrf !== null) form.set(CSRF_FIELD, csrf);
  const submission =
    options.submission === undefined ? mintSubmissionId(SESSION) : options.submission;
  if (submission !== null) form.set(SUBMISSION_FIELD, submission);
  const baseline =
    options.baseline === undefined
      ? sealAssetBaseline(SESSION, ASSET_ID, VERSION, BASELINE)
      : options.baseline;
  if (baseline !== null) form.set(BASELINE_FIELD, baseline);
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

  it('refuses a submission id the client chose in the original, unbound format', async () => {
    expect(await submit(formData(VALID, { submission: 'chosen-by-the-client' }))).toEqual({
      kind: 'REFUSED',
      reason: 'SUBMISSION',
    });
    expect(updateAsset).not.toHaveBeenCalled();
  });

  it('refuses a well-formed id this server never minted', async () => {
    expect(await submit(formData(VALID, { submission: UNMINTED_ID }))).toEqual({
      kind: 'REFUSED',
      reason: 'SUBMISSION',
    });
    expect(updateAsset).not.toHaveBeenCalled();
  });

  it('refuses a well-formed id this server never issued, and calls nothing', async () => {
    // Right prefix, right length, right alphabet — and nobody's MAC. This is
    // the case a shape check alone waves through.
    for (const submission of [`sub_${'A'.repeat(38)}`, `sub_${'Zz9_-'.repeat(8)}ab`]) {
      expect(await submit(formData(VALID, { submission }))).toEqual({
        kind: 'REFUSED',
        reason: 'SUBMISSION',
      });
    }
    expect(updateAsset).not.toHaveBeenCalled();
  });

  it('refuses an id minted for somebody else, and one from an earlier login', async () => {
    const theirs = mintSubmissionId({ ...SESSION, subject: 'someone-else' });
    const earlier = mintSubmissionId({ ...SESSION, csrfToken: 'the-token-before-re-login' });
    for (const submission of [theirs, earlier]) {
      expect(await submit(formData(VALID, { submission }))).toEqual({
        kind: 'REFUSED',
        reason: 'SUBMISSION',
      });
    }
    expect(updateAsset).not.toHaveBeenCalled();
  });

  it('accepts an id this server minted for this session', async () => {
    await expect(submit(formData(VALID))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(updateAsset).toHaveBeenCalledTimes(1);
  });
});

describe('the baseline: what the form was drawn from', () => {
  it('refuses a post with no baseline, and calls nothing', async () => {
    expect(await submit(formData(VALID, { baseline: null }))).toEqual({
      kind: 'REFUSED',
      reason: 'BASELINE',
    });
    expect(updateAsset).not.toHaveBeenCalled();
  });

  it('refuses a baseline the client wrote itself, even a well-shaped one', async () => {
    const forged = Buffer.from(
      JSON.stringify({ assetId: ASSET_ID, version: 1, values: BASELINE, exp: 4_000_000_000 }),
    ).toString('base64url');
    expect(await submit(formData(VALID, { baseline: `${forged}.${'A'.repeat(43)}` }))).toEqual({
      kind: 'REFUSED',
      reason: 'BASELINE',
    });
    expect(updateAsset).not.toHaveBeenCalled();
  });

  it('refuses a baseline signed for another machine', async () => {
    const other = sealAssetBaseline(SESSION, 'AST_OTHER', VERSION, BASELINE);
    expect(await submit(formData(VALID, { baseline: other }))).toEqual({
      kind: 'REFUSED',
      reason: 'BASELINE',
    });
    expect(updateAsset).not.toHaveBeenCalled();
  });

  it('refuses a baseline signed for somebody else, or from an earlier login', async () => {
    for (const session of [
      { ...SESSION, subject: 'someone-else' },
      { ...SESSION, csrfToken: 'the-token-before-re-login' },
    ]) {
      const token = sealAssetBaseline(session, ASSET_ID, VERSION, BASELINE);
      expect(await submit(formData(VALID, { baseline: token }))).toEqual({
        kind: 'REFUSED',
        reason: 'BASELINE',
      });
    }
    expect(updateAsset).not.toHaveBeenCalled();
  });
});

describe('what the form itself catches', () => {
  it('says so, and calls nothing, when nothing changed', async () => {
    const state = await submit(formData(BASELINE));
    expect(state).toMatchObject({
      kind: 'INVALID',
      fieldErrors: {},
      message: expect.stringContaining('چیزی تغییر نکرده'),
    });
    expect(updateAsset).not.toHaveBeenCalled();
  });

  it('does not call the service when the name was cleared', async () => {
    const state = await submit(formData({ ...BASELINE, name: '' }));
    expect(state).toMatchObject({ kind: 'INVALID', fieldErrors: { name: expect.any(String) } });
    expect(updateAsset).not.toHaveBeenCalled();
  });

  it('keeps what the person typed, and the submission id it came with', async () => {
    const submission = mintSubmissionId(SESSION);
    const state = await submit(
      formData({ ...BASELINE, manufactureYear: '99', model: 'WA320' }, { submission }),
    );
    expect(state).toMatchObject({
      kind: 'INVALID',
      submissionId: submission,
      values: { name: 'لودر کوماتسو', model: 'WA320', manufactureYear: '99' },
    });
  });

  it('does not let a field the person did not touch block the save', async () => {
    // The stored manufacturer breaks a rule this portal now applies; the person
    // is changing the tag, and the manufacturer is neither sent nor validated.
    const stored = { ...BASELINE, manufacturer: 'a<b' };
    const token = sealAssetBaseline(SESSION, ASSET_ID, VERSION, stored);
    await expect(
      submit(formData({ ...stored, assetTag: 'AB-13' }, { baseline: token })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(updateAsset.mock.calls[0][2]).toEqual({ assetTag: 'AB-13' });
  });
});

describe('what reaches the service', () => {
  it('redirects back to the dossier with a flash the server signed for this machine', async () => {
    await expect(submit(formData(VALID))).rejects.toThrow(/NEXT_REDIRECT/);

    const url = redirect.mock.calls[0][0] as string;
    const [path, query] = url.split('?');
    expect(path).toBe(`/assets/${ASSET_ID}`);
    const flash = new URLSearchParams(query).get('flash');
    expect(readFlash(SESSION, flash, ASSET_ID, ['updated'])).toBe('updated');
    // A bare `?updated=1` is no longer what a write produces.
    expect(url).not.toContain('updated=1');
  });

  it('redirects to the id it was bound to, percent-encoded, not to anything the service returned', async () => {
    updateAsset.mockResolvedValue({
      kind: 'CREATED',
      data: { id: 'SOMETHING_ELSE' },
      correlationId: 'corr-sample',
    });
    const token = sealAssetBaseline(SESSION, 'a/b?c', VERSION, BASELINE);
    await expect(submit(formData(VALID, { baseline: token }), 'a/b?c')).rejects.toThrow();
    expect(redirect.mock.calls[0][0]).toMatch(/^\/assets\/a%2Fb%3Fc\?flash=/);
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

  it('sends only the fields that changed, and the version the form was drawn from', async () => {
    const submission = mintSubmissionId(SESSION);
    await expect(
      submit(
        formData({ ...BASELINE, manufactureYear: '۱۴۰۲', manufacturer: 'کوماتسو' }, { submission }),
      ),
    ).rejects.toThrow();

    const [, , request, expectedVersion, submissionId] = updateAsset.mock.calls[0];
    // `name` and `assetTag` came back as they were drawn, so they are not here.
    expect(request).toEqual({ manufacturer: 'کوماتسو', manufactureYear: 1402 });
    expect(expectedVersion).toBe(VERSION);
    expect(submissionId).toBe(submission);
  });

  it('sends a blanked field as null', async () => {
    await expect(submit(formData({ ...BASELINE, assetTag: '' }))).rejects.toThrow();
    expect(updateAsset.mock.calls[0][2]).toEqual({ assetTag: null });
  });

  it('takes the version from the signed baseline, never from a posted field', async () => {
    await expect(
      submit(formData({ ...VALID, version: '1', expectedVersion: '1' })),
    ).rejects.toThrow();
    expect(updateAsset.mock.calls[0][3]).toBe(VERSION);
  });

  it('carries the same reference when one rendered form is posted twice', async () => {
    // A statement about what this action sends, not about what the service
    // does with it (see `server/submission.ts`).
    const submission = mintSubmissionId(SESSION);
    const form = () => formData(VALID, { submission });

    await expect(submit(form())).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(submit(form())).rejects.toThrow(/NEXT_REDIRECT/);

    expect(updateAsset.mock.calls.map((args) => args[4])).toEqual([submission, submission]);
  });
});

describe('what the service refuses', () => {
  it('sends the person to a fresh read, with a signed notice, when the machine changed after the form was drawn', async () => {
    updateAsset.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: ASSET_EDIT_CONFLICT_MESSAGE,
      correlationId: 'corr-sample',
    });

    await expect(submit(formData(VALID))).rejects.toThrow(/NEXT_REDIRECT/);

    const url = redirect.mock.calls[0][0] as string;
    expect(url.startsWith(`/assets/${ASSET_ID}?flash=`)).toBe(true);
    const flash = new URLSearchParams(url.split('?')[1]).get('flash');
    // Not offered back for another try against the same stale baseline: that
    // would only conflict again.
    expect(readFlash(SESSION, flash, ASSET_ID, ['conflict'])).toBe('conflict');
  });

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
      values: { assetTag: 'AB-13' },
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

  it('treats another request still holding this submission id as the same unknown', async () => {
    updateAsset.mockResolvedValue({
      kind: 'IN_PROGRESS',
      retryAfterSeconds: 1,
      correlationId: 'corr-sample',
    });
    expect(await submit(formData(VALID))).toEqual({
      kind: 'UNCONFIRMED',
      correlationId: 'corr-sample',
    });
    expect(redirect).not.toHaveBeenCalled();
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
