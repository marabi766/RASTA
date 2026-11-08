/**
 * @jest-environment node
 */

/**
 * `AccountGuard` reads the session directly (`readSession()`), and fails closed
 * with it (task 100): a session whose organization cannot be told hands the
 * browser no tags — nothing is purged, nothing restored — and a resolved one
 * hands the person's tags only, never an organization or a token.
 */

const SECRET = 'a-secret-that-is-long-enough-to-be-a-key';
Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: SECRET,
});

let cookieValue: string | undefined;
jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'rasta_session' && cookieValue !== undefined ? { value: cookieValue } : undefined,
  }),
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { AccountGuard } = require('./AccountGuard') as typeof import('./AccountGuard');
const { sealSession } = require('@/server/session') as typeof import('@/server/session');
const { submissionBinding } =
  require('@/server/submission') as typeof import('@/server/submission');
const { actingAccessToken } =
  require('@/test/session-token') as typeof import('@/test/session-token');
/* eslint-enable @typescript-eslint/no-require-imports */

type WebSession = import('@/server/session').WebSession;

function session(overrides: Partial<WebSession> = {}): WebSession {
  const now = Math.floor(Date.now() / 1000);
  return {
    subject: 'USR_1',
    username: 'u',
    organizationId: 'ORG_A',
    accessToken: actingAccessToken('ORG_A'),
    accessTokenExpiresAt: now + 600,
    refreshToken: 'r',
    csrfToken: 'c',
    issuedAt: now - 60,
    ...overrides,
  };
}

const accountOf = async () => ((await AccountGuard()).props as { account: unknown }).account;

beforeEach(() => {
  cookieValue = undefined;
});

it('hands the person’s tags for a session acting for its token’s organization', async () => {
  cookieValue = sealSession(session(), SECRET);
  const binding = submissionBinding(session());
  expect(await accountOf()).toEqual({ person: binding.person, legacy: binding.legacy });
});

it.each([
  ['the stored copy says A, the token B', { accessToken: actingAccessToken('ORG_B') }],
  ['a token that does not open', { accessToken: 'opaque' }],
])('hands nothing when %s: nothing purged, nothing restored', async (_name, change) => {
  cookieValue = sealSession(session(change), SECRET);
  expect(await accountOf()).toBeNull();
});

it('hands nothing with no session', async () => {
  expect(await accountOf()).toBeNull();
});

export {};
