/**
 * @jest-environment node
 */
const LOGIN = { csrfToken: 'csrf-token-for-this-session' };
// Logout reads the stored session on its own path, so a session `readSession()` refuses — one
// whose organization cannot be told (PR 405 review 2, F3) — can still sign out.
const stored = { current: LOGIN as unknown };
jest.mock('@/server/current-session', () => ({
  readSession: async () => null,
  readStoredSessionForLogout: async () => stored.current,
}));
const purge = jest.fn<Promise<boolean>, [unknown]>(async () => true);
jest.mock('@/server/unresolved-request', () => ({
  ...jest.requireActual('@/server/unresolved-request'),
  purgeUnresolved: (session: unknown) => purge(session),
}));
jest.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [
      { name: 'rasta_session', value: 'x' },
      { name: 'rasta_ur_0123456789abcdef01234567', value: 'y' },
      { name: 'unrelated', value: 'z' },
    ],
  }),
}));

beforeEach(() => {
  stored.current = LOGIN;
  purge.mockClear();
  Object.assign(process.env, {
    API_GATEWAY_URL: 'http://gateway.test:3000',
    OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
    OIDC_CLIENT_ID: 'rasta-web',
    WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
    WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  });
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { POST } = require('./route') as typeof import('./route');

describe('logout', () => {
  it('deletes what this login holds on the server, and still logs out when the store cannot be reached', async () => {
    const body = new FormData();
    body.set('csrf', LOGIN.csrfToken);
    purge.mockClear();
    purge.mockResolvedValueOnce(false);
    const response = await POST(
      new Request('http://localhost:3200/auth/logout', { method: 'POST', body }),
    );
    expect(purge).toHaveBeenCalledWith(LOGIN);
    expect(response.headers.getSetCookie().join('\n')).toMatch(/rasta_session=;/);
  });

  it('removes the session cookie and every legacy unresolved-request cookie, and no other', async () => {
    const body = new FormData();
    body.set('csrf', LOGIN.csrfToken);
    const response = await POST(
      new Request('http://localhost:3200/auth/logout', { method: 'POST', body }),
    );
    const cleared = response.headers
      .getSetCookie()
      .filter((line) => /Max-Age=0|Expires=Thu, 01 Jan 1970/.test(line))
      .map((line) => line.split('=')[0]);
    expect(cleared).toEqual(
      expect.arrayContaining(['rasta_session', 'rasta_ur_0123456789abcdef01234567']),
    );
    expect(cleared).not.toContain('unrelated');
  });

  it('signs out a session whose organization cannot be told — the one the recovery page offers it to', async () => {
    const body = new FormData();
    body.set('csrf', LOGIN.csrfToken);
    const response = await POST(
      new Request('http://localhost:3200/auth/logout', { method: 'POST', body }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toMatch(/^http:\/\/keycloak\.test\/realms\/rasta\//);
    expect(response.headers.getSetCookie().join('\n')).toMatch(/rasta_session=;/);
  });

  it.each([
    ['a wrong token', 'not-the-csrf-token'],
    ['no token', null],
  ])(
    'with %s, changes nothing: 403, no cookie touched, nothing purged, no redirect',
    async (_label, csrf) => {
      const body = new FormData();
      if (csrf !== null) body.set('csrf', csrf);
      const response = await POST(
        new Request('http://localhost:3200/auth/logout', { method: 'POST', body }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'CSRF_TOKEN_MISMATCH' });
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.headers.get('location')).toBeNull();
      expect(purge).not.toHaveBeenCalled();
    },
  );
});
