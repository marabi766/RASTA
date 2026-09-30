/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import { IDLE_REGISTER_ASSET_FORM } from './form-state';

/**
 * The `/assets` registration form's write path, from a posted form to a call
 * on the gateway. Mirrors `drivers/actions.spec.ts`: the order is the
 * assertion, each refusal proves nothing was called, and a retry of one
 * rendered form is shown to carry the same reference.
 *
 * It does **not** claim a retry is one machine: asset-service does not store
 * the reference, so a duplicate is stopped only by its serial-number and
 * asset-tag uniqueness, which a registration with neither does not have.
 */

const currentSession = jest.fn();
const registerAsset = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({ currentSession: () => currentSession() }));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/asset-commands', () => {
  const actual = jest.requireActual('@/server/asset-commands');
  return { ...actual, registerAsset: (...args: unknown[]) => registerAsset(...args) };
});

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { submitRegisterAsset } = require('./actions') as typeof import('./actions');

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

/** The right length and alphabet, but not issued by `mintSubmissionId`. */
const UNMINTED_ID = `sub_${'A'.repeat(38)}`;

const VALID = { name: 'لودر کوماتسو', type: 'LOADER' };

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
  registerAsset.mockResolvedValue({
    kind: 'CREATED',
    data: { id: 'AST_1' },
    correlationId: 'corr-sample',
  });
  redirect.mockClear();
  registerAsset.mockClear();
});

describe('what is refused before anything is called', () => {
  it('refuses a post with no session', async () => {
    currentSession.mockResolvedValue(null);
    const state = await submitRegisterAsset(IDLE_REGISTER_ASSET_FORM, formData(VALID));
    expect(state).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
    expect(registerAsset).not.toHaveBeenCalled();
  });

  it('refuses a post with no CSRF token, and calls nothing', async () => {
    const state = await submitRegisterAsset(
      IDLE_REGISTER_ASSET_FORM,
      formData(VALID, { csrf: null }),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
    expect(registerAsset).not.toHaveBeenCalled();
  });

  it('refuses a token from another session', async () => {
    const state = await submitRegisterAsset(
      IDLE_REGISTER_ASSET_FORM,
      formData(VALID, { csrf: 'someone-elses' }),
    );
    expect(state).toEqual({ kind: 'REFUSED', reason: 'CSRF' });
    expect(registerAsset).not.toHaveBeenCalled();
  });

  it('refuses a submission id the client chose in the original, unbound format', async () => {
    expect(
      await submitRegisterAsset(
        IDLE_REGISTER_ASSET_FORM,
        formData(VALID, { submission: 'chosen-by-the-client' }),
      ),
    ).toEqual({
      kind: 'REFUSED',
      reason: 'SUBMISSION',
    });
    expect(registerAsset).not.toHaveBeenCalled();
  });

  it('refuses a well-formed id this server never minted', async () => {
    expect(
      await submitRegisterAsset(
        IDLE_REGISTER_ASSET_FORM,
        formData(VALID, { submission: UNMINTED_ID }),
      ),
    ).toEqual({
      kind: 'REFUSED',
      reason: 'SUBMISSION',
    });
    expect(registerAsset).not.toHaveBeenCalled();
  });

  it('refuses a well-formed id this server never issued, and calls nothing', async () => {
    // Right prefix, right length, right alphabet — and nobody's MAC. This is
    // the case a shape check alone waves through.
    for (const submission of [`sub_${'A'.repeat(38)}`, `sub_${'Zz9_-'.repeat(8)}ab`]) {
      expect(
        await submitRegisterAsset(IDLE_REGISTER_ASSET_FORM, formData(VALID, { submission })),
      ).toEqual({
        kind: 'REFUSED',
        reason: 'SUBMISSION',
      });
    }
    expect(registerAsset).not.toHaveBeenCalled();
  });

  it('refuses an id minted for somebody else, and one from an earlier login', async () => {
    const theirs = mintSubmissionId({ ...SESSION, subject: 'someone-else' });
    const earlier = mintSubmissionId({ ...SESSION, csrfToken: 'the-token-before-re-login' });
    for (const submission of [theirs, earlier]) {
      expect(
        await submitRegisterAsset(IDLE_REGISTER_ASSET_FORM, formData(VALID, { submission })),
      ).toEqual({
        kind: 'REFUSED',
        reason: 'SUBMISSION',
      });
    }
    expect(registerAsset).not.toHaveBeenCalled();
  });

  it('accepts an id this server minted for this session', async () => {
    await expect(submitRegisterAsset(IDLE_REGISTER_ASSET_FORM, formData(VALID))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(registerAsset).toHaveBeenCalledTimes(1);
  });
});

describe('what the form itself catches', () => {
  it('does not call the service for a form missing required fields', async () => {
    const state = await submitRegisterAsset(IDLE_REGISTER_ASSET_FORM, formData({ name: '' }));
    expect(state).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { name: expect.any(String), type: 'نوع ماشین را انتخاب کنید' },
    });
    expect(registerAsset).not.toHaveBeenCalled();
  });

  it('keeps what the person typed, and the submission id it came with', async () => {
    const submission = mintSubmissionId(SESSION);
    const state = await submitRegisterAsset(
      IDLE_REGISTER_ASSET_FORM,
      formData({ ...VALID, name: '', model: 'WA320', manufactureYear: '۱۴۰۲' }, { submission }),
    );
    expect(state).toMatchObject({
      kind: 'INVALID',
      submissionId: submission,
      values: { type: 'LOADER', model: 'WA320', manufactureYear: '۱۴۰۲' },
    });
  });
});

describe('what reaches the service', () => {
  it('redirects to the new machine after a successful write', async () => {
    await expect(submitRegisterAsset(IDLE_REGISTER_ASSET_FORM, formData(VALID))).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    expect(redirect).toHaveBeenCalledWith('/assets/AST_1?created=1');
  });

  it('percent-encodes the id it redirects to', async () => {
    registerAsset.mockResolvedValue({
      kind: 'CREATED',
      data: { id: 'a/b?c' },
      correlationId: 'corr-sample',
    });
    await expect(submitRegisterAsset(IDLE_REGISTER_ASSET_FORM, formData(VALID))).rejects.toThrow();
    expect(redirect).toHaveBeenCalledWith('/assets/a%2Fb%3Fc?created=1');
  });

  it('sends the parsed request under the session, with Latin digits and no calendar change', async () => {
    const submission = mintSubmissionId(SESSION);
    await expect(
      submitRegisterAsset(
        IDLE_REGISTER_ASSET_FORM,
        formData({ ...VALID, manufactureYear: '۱۴۰۲', siteName: 'انبار' }, { submission }),
      ),
    ).rejects.toThrow();

    const [session, request, submissionId] = registerAsset.mock.calls[0];
    expect(session).toBe(SESSION);
    expect(JSON.parse(JSON.stringify(request))).toEqual({
      name: 'لودر کوماتسو',
      type: 'LOADER',
      manufactureYear: 1402,
      location: { siteName: 'انبار' },
    });
    expect(submissionId).toBe(submission);
  });

  it('carries the same reference when one rendered form is posted twice', async () => {
    // A statement about what this action sends, not about what the service
    // does with it (see `server/submission.ts`).
    const submission = mintSubmissionId(SESSION);
    const form = () => formData(VALID, { submission });

    await expect(submitRegisterAsset(IDLE_REGISTER_ASSET_FORM, form())).rejects.toThrow(
      /NEXT_REDIRECT/,
    );
    await expect(submitRegisterAsset(IDLE_REGISTER_ASSET_FORM, form())).rejects.toThrow(
      /NEXT_REDIRECT/,
    );

    expect(registerAsset.mock.calls.map((args) => args[2])).toEqual([submission, submission]);
  });
});

describe('what the service refuses', () => {
  it('returns the service field errors with the values still in hand', async () => {
    registerAsset.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: { name: 'نام را کوتاه‌تر کنید' },
      message: null,
      correlationId: 'corr-sample',
    });

    const state = await submitRegisterAsset(IDLE_REGISTER_ASSET_FORM, formData(VALID));
    expect(state).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { name: 'نام را کوتاه‌تر کنید' },
      values: { type: 'LOADER' },
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('returns the duplicate refusal as the form message', async () => {
    registerAsset.mockResolvedValue({
      kind: 'INVALID',
      fieldErrors: {},
      message: 'ماشینی با این شمارهٔ سریال یا شمارهٔ دارایی پیش‌تر ثبت شده است',
      correlationId: 'corr-sample',
    });

    expect(await submitRegisterAsset(IDLE_REGISTER_ASSET_FORM, formData(VALID))).toMatchObject({
      kind: 'INVALID',
      message: 'ماشینی با این شمارهٔ سریال یا شمارهٔ دارایی پیش‌تر ثبت شده است',
    });
  });

  it('reports a forbidden write with its correlation id', async () => {
    registerAsset.mockResolvedValue({ kind: 'FORBIDDEN', correlationId: 'corr-sample' });
    expect(await submitRegisterAsset(IDLE_REGISTER_ASSET_FORM, formData(VALID))).toEqual({
      kind: 'FORBIDDEN',
      correlationId: 'corr-sample',
    });
  });

  it('reports a sent-but-unconfirmed write as UNCONFIRMED, never as a failure', async () => {
    // The service may have registered the machine; "nothing was saved" would
    // invite a retry that reports a duplicate.
    registerAsset.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'corr-sample' });
    expect(await submitRegisterAsset(IDLE_REGISTER_ASSET_FORM, formData(VALID))).toEqual({
      kind: 'UNCONFIRMED',
      correlationId: 'corr-sample',
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('reports an outage with its status and correlation id', async () => {
    registerAsset.mockResolvedValue({
      kind: 'UNAVAILABLE',
      status: 503,
      correlationId: 'corr-sample',
    });
    expect(await submitRegisterAsset(IDLE_REGISTER_ASSET_FORM, formData(VALID))).toEqual({
      kind: 'FAILED',
      status: 503,
      correlationId: 'corr-sample',
    });
  });

  it('never puts a token in what the page renders', async () => {
    registerAsset.mockResolvedValue({
      kind: 'UNAVAILABLE',
      status: 503,
      correlationId: 'corr-sample',
    });
    const text = JSON.stringify(
      await submitRegisterAsset(IDLE_REGISTER_ASSET_FORM, formData(VALID)),
    );
    expect(text).not.toContain(SESSION.accessToken);
    expect(text).not.toContain(SESSION.refreshToken);
    expect(text).not.toContain(SESSION.csrfToken);
  });
});
