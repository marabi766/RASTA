/**
 * @jest-environment node
 */
import { currentSession, readSession, readStoredSessionForLogout } from './current-session';
import { SESSION_COOKIE, sealSession, type WebSession } from './session';
import { actingAccessToken } from '@/test/session-token';

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
    accessToken: actingAccessToken('ORG_1'),
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
    expect(await currentSession(at(T0 + 99))).toMatchObject({ subject: 'USR_1' });
  });

  it('returns null with no cookie, and for one that does not open', async () => {
    expect(await readSession(at(T0))).toBeNull();
    cookieValue = 'not-a-sealed-session';
    expect(await readSession(at(T0))).toBeNull();
  });
});

describe('every reader fails closed when the organization cannot be told (task 100)', () => {
  beforeEach(() => {
    cookieValue = undefined;
  });

  const UNTOLD: [string, Partial<WebSession>][] = [
    // Sealed before task 100: refreshed into B while the copy still said A.
    ['the stored copy says A, the token B', { accessToken: actingAccessToken('ORG_2') }],
    ['a token that does not open', { accessToken: 'opaque' }],
    [
      'a token naming an organization it does not list as a membership',
      { accessToken: actingAccessToken('ORG_1', ['OPERATOR'], { org_ids: ['ORG_9'] }) },
    ],
    [
      'a token granting no role in its organization',
      { accessToken: actingAccessToken('ORG_1', []) },
    ],
    ['a token with no organization, a copy naming one', { accessToken: actingAccessToken(null) }],
  ];

  it.each(UNTOLD)('%s: readSession() and currentSession() return none', async (_name, change) => {
    cookieValue = sealSession(session(change), SECRET);
    expect(await readSession(at(T0 + 60))).toBeNull();
    expect(await currentSession(at(T0 + 60))).toBeNull();
  });

  it.each(UNTOLD)('%s: logging out still reads it (the CSRF token only)', async (_name, change) => {
    cookieValue = sealSession(session(change), SECRET);
    expect(await readStoredSessionForLogout(at(T0 + 60))).toMatchObject({ csrfToken: 'csrf' });
  });

  it('a token with no organization and a copy saying none is a session, acting for none', async () => {
    cookieValue = sealSession(
      session({ organizationId: null, accessToken: actingAccessToken(null) }),
      SECRET,
    );
    expect(await readSession(at(T0 + 60))).toMatchObject({ organizationId: null });
  });

  it('the logout reader keeps the absolute lifetime too', async () => {
    cookieValue = sealSession(session(), SECRET);
    expect(await readStoredSessionForLogout(at(T0 + MAX_AGE))).toBeNull();
  });
});
