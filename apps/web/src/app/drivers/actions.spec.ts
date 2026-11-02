/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';

import { IDLE_CREATE_DRIVER_FORM } from './form-state';
import { actingAccessToken } from '@/test/session-token';

/**
 * The `/drivers` registration form's write path, from a posted form to a
 * call on the gateway. Mirrors `usage/actions.spec.ts` (PR #75): the order
 * is the assertion, each refusal proves nothing was called, and the
 * double-submit case proves a retry is one record, not two.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const currentSession = jest.fn();
const createDriver = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({
  currentSession: () => currentSession(),
  missingSessionReason: async () => 'NO_SESSION',
}));
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
  accessToken: actingAccessToken('ORG-DEH-0001'),
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
  const submission =
    options.submission === undefined ? mintSubmissionId(SESSION) : options.submission;
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

  it('refuses every id that is not one this server minted for this session, and calls nothing', async () => {
    const notMinted = [
      // Right prefix, right length, right alphabet — and nobody's MAC: what a
      // shape check alone waves through.
      `sub_${'A'.repeat(38)}`,
      `sub_${'Zz9_-'.repeat(8)}ab`,
      // The original, unbound format.
      `sub_${'B'.repeat(20)}`,
      // Somebody else's, and one from an earlier login.
      mintSubmissionId({ ...SESSION, subject: 'someone-else' }),
      mintSubmissionId({ ...SESSION, csrfToken: 'the-token-before-re-login' }),
    ];
    for (const submission of notMinted) {
      expect(
        await submitCreateDriver(IDLE_CREATE_DRIVER_FORM, formData(VALID, { submission })),
      ).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
    }
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
    // No flag the page never read (PR 405 review 2, F2): the driver's own page.
    expect(redirect).toHaveBeenCalledWith('/drivers/DRV_1');
  });

  it('sends one submission twice under one reference — the double-submit case', async () => {
    const submission = mintSubmissionId(SESSION);
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

  it('reports a sent-but-unconfirmed write as UNCONFIRMED, never as a failure (Codex #106)', async () => {
    // The service may have created the driver; "nothing was saved" would
    // invite a retry that reports a duplicate.
    createDriver.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'corr-sample' });
    expect(await submitCreateDriver(IDLE_CREATE_DRIVER_FORM, formData(VALID))).toEqual({
      kind: 'UNCONFIRMED',
      correlationId: 'corr-sample',
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

describe('who may be registered: fleet-service decides on every POST (task 095)', () => {
  const actual = jest.requireActual('@/server/drivers') as typeof import('@/server/drivers');

  /** The gateway, answering the registration as fleet-service would. */
  function gatewayAnswering(status: number, body: unknown) {
    const calls: { url: string; body: unknown }[] = [];
    const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? 'null')) });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr-095' },
      });
    }) as typeof fetch;
    return { impl, calls };
  }

  async function send(impl: typeof fetch, form: FormData) {
    createDriver.mockImplementation((...args: unknown[]) =>
      (actual.createDriver as (...a: unknown[]) => unknown)(...args),
    );
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      return await submitCreateDriver(IDLE_CREATE_DRIVER_FORM, form);
    } finally {
      globalThis.fetch = original;
    }
  }

  const NOT_A_MEMBER = {
    code: 'BUSINESS_RULE_VIOLATION',
    message: 'The user is not a member of this organization',
    details: [
      {
        path: 'userId',
        message: 'The user is not a member of this organization',
        code: 'USER_NOT_A_MEMBER',
      },
    ],
  };

  it('shows the not-a-member refusal in Persian under the user field, the value kept', async () => {
    const { impl, calls } = gatewayAnswering(422, NOT_A_MEMBER);
    const state = await send(impl, formData(VALID));
    expect(state).toMatchObject({
      kind: 'INVALID',
      values: { userId: VALID.userId },
      fieldErrors: { userId: actual.NOT_A_MEMBER_TEXT },
      message: null,
    });
    expect(JSON.stringify(state)).not.toContain('not a member');
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/drivers');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('says the same for a user who does not exist and for a member of another organization', async () => {
    // fleet-service answers both with the one refusal; so does the portal.
    const nobody = await send(gatewayAnswering(422, NOT_A_MEMBER).impl, formData(VALID));
    const elsewhere = await send(
      gatewayAnswering(422, NOT_A_MEMBER).impl,
      formData({ userId: 'USR_01J00000000000000000000009' }),
    );
    expect(nobody).toMatchObject({ fieldErrors: { userId: actual.NOT_A_MEMBER_TEXT } });
    expect(elsewhere).toMatchObject({ fieldErrors: { userId: actual.NOT_A_MEMBER_TEXT } });
  });

  it('says "nothing was saved" when fleet-service could not ask identity-service (503)', async () => {
    const state = await send(
      gatewayAnswering(503, {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'A required service is temporarily unavailable',
      }).impl,
      formData(VALID),
    );
    expect(state).toMatchObject({ kind: 'FAILED', status: 503 });
  });

  it('keeps a 504 unconfirmed — the gateway gave up, the write may have happened', async () => {
    const state = await send(
      gatewayAnswering(504, { code: 'UPSTREAM_TIMEOUT', message: 'x' }).impl,
      formData(VALID),
    );
    expect(state).toMatchObject({ kind: 'UNCONFIRMED' });
  });

  describe('a form drawn for one organization, sent after the token moved to another', () => {
    const inA = {
      ...SESSION,
      organizationId: 'ORG-DEH-0001',
      accessToken: actingAccessToken('ORG-DEH-0001'),
    };
    const inB = {
      ...SESSION,
      organizationId: 'ORG-DEH-0002',
      accessToken: actingAccessToken('ORG-DEH-0002'),
    };

    it('is refused as stale and sent nowhere — a member picked from A’s list is never registered in B', async () => {
      const { impl, calls } = gatewayAnswering(201, { id: 'DRV_NEVER' });
      // Drawn while the token acted for A…
      const form = formData(VALID, { submission: mintSubmissionId(inA) });
      // …sent after a refresh brought a token for B (and, since task 100, the
      // session's stored organization with it).
      currentSession.mockResolvedValue(inB);
      const state = await send(impl, form);
      expect(state).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
      expect(calls).toHaveLength(0);
      expect(createDriver).not.toHaveBeenCalled();
    });

    it('a form drawn after the switch goes through, and fleet-service decides for B', async () => {
      const { impl, calls } = gatewayAnswering(422, NOT_A_MEMBER);
      currentSession.mockResolvedValue(inB);
      const state = await send(impl, formData(VALID, { submission: mintSubmissionId(inB) }));
      expect(calls).toHaveLength(1);
      expect(state).toMatchObject({ fieldErrors: { userId: actual.NOT_A_MEMBER_TEXT } });
    });
  });
});
