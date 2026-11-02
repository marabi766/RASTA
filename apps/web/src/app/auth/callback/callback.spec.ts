/**
 * @jest-environment node
 */

/**
 * The login stores the organization the access token acts for — the one every
 * service and every portal reader resolves — never the id token's own claim
 * (task 100). The provider calls are stood in for; the cookie handling, the
 * seal and the resolution are real.
 */

const SECRET = 'a-secret-that-is-long-enough-to-be-a-key';
Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: SECRET,
});

let accessToken = '';
jest.mock('@/server/oidc', () => ({
  ...jest.requireActual('@/server/oidc'),
  exchangeCode: async () => ({
    access_token: accessToken,
    refresh_token: 'refresh',
    id_token: 'id-token',
    expires_in: 900,
    token_type: 'Bearer',
  }),
  verifyIdToken: async () => ({ subject: 'USR_1', username: 'admin' }),
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { GET } = require('./route') as typeof import('./route');
const { LOGIN_ATTEMPT_COOKIE, sealLoginAttempt } =
  require('@/server/login-attempt') as typeof import('@/server/login-attempt');
const { SESSION_COOKIE, openSession } =
  require('@/server/session') as typeof import('@/server/session');
const { actingAccessToken } =
  require('@/test/session-token') as typeof import('@/test/session-token');
/* eslint-enable @typescript-eslint/no-require-imports */

async function signIn(): Promise<import('@/server/session').WebSession | null> {
  const attempt = sealLoginAttempt(
    { state: 'state-1', nonce: 'nonce-1', verifier: 'verifier-1', returnTo: '/' },
    SECRET,
  );
  const response = await GET(
    new Request('http://localhost:3200/auth/callback?state=state-1&code=code-1', {
      headers: { cookie: `${LOGIN_ATTEMPT_COOKIE}=${attempt}` },
    }),
  );
  const sealed = response.cookies.get(SESSION_COOKIE)?.value;
  return sealed ? openSession(sealed, SECRET) : null;
}

it('stores the access token’s organization', async () => {
  accessToken = actingAccessToken('ORG_A', ['ORGANIZATION_ADMIN']);
  expect(await signIn()).toMatchObject({ organizationId: 'ORG_A', accessToken });
});

it('stores none for a platform-wide token', async () => {
  accessToken = actingAccessToken(null);
  expect(await signIn()).toMatchObject({ organizationId: null });
});

it('stores none for a token that does not resolve — which no reader then takes for a session', async () => {
  // org_id it does not list as a membership: the guard says TENANT_MISMATCH.
  accessToken = actingAccessToken('ORG_A', ['OPERATOR'], { org_ids: ['ORG_B'] });
  expect(await signIn()).toMatchObject({ organizationId: null });
});

export {};
