/**
 * @jest-environment node
 */

/**
 * PR 405 review 2, F3: a session the portal refuses for tenant data — its
 * token holds no role in the organization it names — reaches a page that
 * offers a way out: a CSRF-protected logout and a sign-in with another
 * account. The page shows nothing of any tenant and makes no request.
 */

import { renderToStaticMarkup } from 'react-dom/server';

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const stored = { current: null as unknown, readable: null as unknown };
jest.mock('@/server/current-session', () => ({
  readSession: async () => stored.readable,
  readStoredSessionForLogout: async () => stored.current,
}));
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const RecoveryPage = (require('./page') as { default: () => Promise<React.ReactElement> }).default;
const { RECOVERY_LOGOUT, RECOVERY_SWITCH, RECOVERY_TEXT, RECOVERY_TITLE, SWITCH_ACCOUNT_HREF } =
  require('./RecoveryScreen') as typeof import('./RecoveryScreen');
const { GET: startLogin } =
  require('@/app/auth/login/route') as typeof import('@/app/auth/login/route');
const { sessionOrganization } =
  require('@/server/session-organization') as typeof import('@/server/session-organization');
const { actingAccessToken } =
  require('@/test/session-token') as typeof import('@/test/session-token');
/* eslint-enable @typescript-eslint/no-require-imports */

const ORG = 'ORG-DEH-0001';
const REFUSED = {
  subject: 'USR_1',
  username: 'person-name',
  organizationId: null,
  accessToken: actingAccessToken(ORG, [], { org_roles: [] }),
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-secret',
  csrfToken: 'csrf-of-this-login',
  issuedAt: 1_900_000_000,
};

const originalFetch = globalThis.fetch;
const fetched: string[] = [];
beforeEach(() => {
  stored.current = REFUSED;
  stored.readable = null;
  fetched.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetched.push(String(input));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

it('the session it is for is one the portal refuses: no organization can be told', () => {
  expect(sessionOrganization(REFUSED)).toBeUndefined();
});

it('explains, in fixed words, and offers a logout with this login’s CSRF token and another account', async () => {
  const html = renderToStaticMarkup(await RecoveryPage());
  expect(html).toContain(RECOVERY_TITLE);
  expect(html).toContain(RECOVERY_TEXT);
  expect(html).toContain(
    '<form action="/auth/logout" method="post"><input type="hidden" name="csrf" value="csrf-of-this-login"/>',
  );
  expect(html).toContain(RECOVERY_LOGOUT);
  expect(html).toContain(`href="${SWITCH_ACCOUNT_HREF.replace('&', '&amp;')}"`);
  expect(html).toContain(RECOVERY_SWITCH);
});

it('shows nothing of any tenant and of the session, and asks nobody anything', async () => {
  const html = renderToStaticMarkup(await RecoveryPage());
  for (const secret of [
    ORG,
    REFUSED.username,
    REFUSED.accessToken,
    REFUSED.refreshToken,
    REFUSED.subject,
  ]) {
    expect(html).not.toContain(secret);
  }
  // No portal shell, no menu.
  expect(html).not.toMatch(/<nav|<aside/);
  expect(fetched).toEqual([]);
});

it('sends a usable session home, and no session to sign in', async () => {
  stored.readable = REFUSED;
  await expect(RecoveryPage()).rejects.toThrow('NEXT_REDIRECT:/');
  stored.readable = null;
  stored.current = null;
  await expect(RecoveryPage()).rejects.toThrow('NEXT_REDIRECT:/login');
});

describe('another account', () => {
  const start = (query: string) => {
    const response = startLogin(new Request(`http://localhost:3200/auth/login${query}`));
    return new URL(response.headers.get('location')!);
  };

  it('asks the provider for credentials again — over a live single sign-on — and keeps PKCE, state and nonce', () => {
    const url = start('?prompt=login');
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    for (const name of ['code_challenge', 'state', 'nonce']) {
      expect(url.searchParams.get(name)).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    }
    expect(url.searchParams.get('state')).not.toBe(url.searchParams.get('nonce'));
  });

  it.each(['none', 'consent', 'select_account', 'login consent', ''])(
    'asks nothing else: prompt=%p is not passed on',
    (prompt) => {
      expect(start(`?prompt=${encodeURIComponent(prompt)}`).searchParams.has('prompt')).toBe(false);
    },
  );

  it('an ordinary sign-in asks for nothing, as before', () => {
    expect(start('').searchParams.has('prompt')).toBe(false);
  });

  it('the way back stays a safe path on this origin', () => {
    const response = startLogin(
      new Request('http://localhost:3200/auth/login?prompt=login&returnTo=https://evil.test/x'),
    );
    expect(response.headers.get('location')).not.toContain('evil.test');
  });
});
