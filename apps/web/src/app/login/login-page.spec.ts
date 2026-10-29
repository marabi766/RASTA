/**
 * @jest-environment node
 */

/**
 * PR 405 review 2, F3: a session whose access token has no role in its own
 * organization is refused for tenant data — rightly — but it must not lock the
 * person out. `/login` sends it to the recovery page, which offers a logout
 * and another account; it never shows the sign-in link that would only bring
 * the same identity back through the provider's single sign-on.
 */

import { isValidElement } from 'react';

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
const LoginPage = (require('./page') as { default: (props: unknown) => Promise<unknown> }).default;
const { actingAccessToken } =
  require('@/test/session-token') as typeof import('@/test/session-token');
/* eslint-enable @typescript-eslint/no-require-imports */

const ORG = 'ORG-DEH-0001';

/** Signed in for ORG, but the token holds no role there: the guard would refuse it. */
const refused = {
  subject: 'USR_1',
  username: 'u',
  organizationId: null,
  accessToken: actingAccessToken(ORG, [], { org_roles: [] }),
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'r',
  csrfToken: 'csrf-of-this-login',
  issuedAt: 1_900_000_000,
};

const visit = (searchParams: Record<string, string> = {}) =>
  LoginPage({ searchParams: Promise.resolve(searchParams) });

beforeEach(() => {
  stored.current = null;
  stored.readable = null;
});

it('a refused session is sent to the recovery page, not shown the sign-in link again', async () => {
  stored.current = refused;
  await expect(visit({ returnTo: '/drivers' })).rejects.toThrow('NEXT_REDIRECT:/account/recovery');
});

it('a usable session still goes home; no session sees the sign-in page', async () => {
  stored.current = refused;
  stored.readable = refused;
  await expect(visit()).rejects.toThrow('NEXT_REDIRECT:/');
  stored.current = null;
  stored.readable = null;
  expect(isValidElement(await visit())).toBe(true);
});
