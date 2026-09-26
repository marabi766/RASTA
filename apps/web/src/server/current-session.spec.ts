/**
 * @jest-environment node
 */
import { currentSession, readSession } from './current-session';
import { SESSION_COOKIE, sealSession, type WebSession } from './session';

/**
 * The server-side half of the absolute session lifetime: every read of the
 * session refuses one past `WEB_SESSION_MAX_AGE_SECONDS`, whatever the
 * browser did with the cookie's own `Max-Age`.
 */

const SECRET = 'a-secret-that-is-long-enough-to-be-a-key';
const MAX_AGE = 8 * 60 * 60;
const T0 = 1_900_000_000;

let cookieValue: string | undefined;
jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === SESSION_COOKIE && cookieValue !== undefined ? { value: cookieValue } : undefined,
  }),
}));
jest.mock('./env', () => ({
  webServerEnv: () => ({
    WEB_SESSION_SECRET: SECRET,
    WEB_SESSION_MAX_AGE_SECONDS: MAX_AGE,
  }),
}));

function session(overrides: Partial<WebSession> = {}): WebSession {
  return {
    subject: 'USR_1',
    username: 'reader',
    organizationId: 'ORG_1',
    accessToken: 'access',
    accessTokenExpiresAt: T0 + 900,
    refreshToken: 'refresh',
    csrfToken: 'csrf',
    issuedAt: T0,
    ...overrides,
  };
}

const at = (seconds: number) => seconds * 1000;

describe('reading the session enforces its absolute lifetime', () => {
  beforeEach(() => {
    cookieValue = undefined;
  });

  it('returns a session inside its lifetime', async () => {
    cookieValue = sealSession(session(), SECRET);
    expect(await readSession(at(T0 + 60))).toMatchObject({ subject: 'USR_1' });
  });

  it('refuses a session past WEB_SESSION_MAX_AGE_SECONDS, even with a fresh access token', async () => {
    cookieValue = sealSession(session({ accessTokenExpiresAt: T0 + MAX_AGE + 900 }), SECRET);
    expect(await readSession(at(T0 + MAX_AGE))).toBeNull();
    expect(await currentSession(at(T0 + MAX_AGE + 1))).toBeNull();
  });

  it('does not act with an access token that has already expired', async () => {
    cookieValue = sealSession(session({ accessTokenExpiresAt: T0 + 100 }), SECRET);
    expect(await currentSession(at(T0 + 100))).toBeNull();
    expect(await currentSession(at(T0 + 99))).toMatchObject({ accessToken: 'access' });
  });

  it('returns null with no cookie, and for one that does not open', async () => {
    expect(await readSession(at(T0))).toBeNull();
    cookieValue = 'not-a-sealed-session';
    expect(await readSession(at(T0))).toBeNull();
  });
});
