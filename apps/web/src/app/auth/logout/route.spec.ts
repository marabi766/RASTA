/**
 * @jest-environment node
 */
const LOGIN = { csrfToken: 'csrf-token-for-this-session' };
jest.mock('@/server/current-session', () => ({ readSession: async () => LOGIN }));
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
  Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_LOGIN_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { POST } = require('./route') as typeof import('./route');

describe('logout', () => {
  it('removes the session cookie and every unresolved-request cookie, and no other', async () => {
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
});
