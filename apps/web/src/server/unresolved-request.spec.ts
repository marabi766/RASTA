/**
 * @jest-environment node
 */
import type { WebSession } from './session';

/**
 * The generic retention of an unresolved write request: what it keeps, for whom,
 * and what it never holds.
 */

const jar = new Map<string, string>();
jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  clearUnresolved,
  mayResend,
  readUnresolved,
  rememberUnresolved,
  requestDigest,
  unresolvedCookieName,
} = require('./unresolved-request') as typeof import('./unresolved-request');
/* eslint-enable @typescript-eslint/no-require-imports */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'owner',
  organizationId: 'ORG_A',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
  issuedAt: 1_900_000_000,
};
const SCOPE = { purpose: 'supplier-write', target: 'SUP_1' };
const REQUEST = { key: 'sub_key', digest: 'd', deadline: 5_000, ref: 'stamp' };

beforeEach(() => jar.clear());

describe('remembering an unresolved request', () => {
  it('gives back what was kept, for the same person, organization and login', async () => {
    await rememberUnresolved(SESSION, SCOPE, REQUEST, 1_000);
    expect(await readUnresolved(SESSION, SCOPE, 1_000)).toEqual(REQUEST);
  });

  it('still gives it back past its deadline: expired is unresolved, not forgotten', async () => {
    await rememberUnresolved(SESSION, SCOPE, REQUEST, 1_000);
    const kept = await readUnresolved(SESSION, SCOPE, 9_000_000);
    expect(kept).toEqual(REQUEST);
    expect(mayResend(kept!, 5_000)).toBe(true);
    expect(mayResend(kept!, 5_001)).toBe(false);
    expect(mayResend({ ...REQUEST, deadline: null }, 9e15)).toBe(true);
  });

  it.each([
    ['another person', { ...SESSION, subject: 'USR_2' }],
    ['a later login', { ...SESSION, csrfToken: 'later' }],
    ['another organization', { ...SESSION, organizationId: 'ORG_B' }],
    ['no organization', { ...SESSION, organizationId: null }],
  ])('is not seen by %s', async (_name, other) => {
    await rememberUnresolved(SESSION, SCOPE, REQUEST, 1_000);
    expect(await readUnresolved(other, SCOPE, 1_000)).toBeNull();
  });

  it('is keyed by purpose and target', async () => {
    await rememberUnresolved(SESSION, SCOPE, REQUEST, 1_000);
    expect(await readUnresolved(SESSION, { ...SCOPE, target: 'SUP_2' })).toBeNull();
    expect(await readUnresolved(SESSION, { purpose: 'other' })).toBeNull();
    // A cookie copied under another scope's name does not open as that scope.
    const copy = unresolvedCookieName({ purpose: 'other' });
    jar.set(copy, jar.get(unresolvedCookieName(SCOPE))!);
    expect(await readUnresolved(SESSION, { purpose: 'other' })).toBeNull();
  });

  it.each(['', 'x.y', 'garbage', undefined])('reads nothing from the cookie %j', async (value) => {
    if (value !== undefined) jar.set(unresolvedCookieName(SCOPE), value);
    expect(await readUnresolved(SESSION, SCOPE)).toBeNull();
  });

  it('is gone once cleared', async () => {
    await rememberUnresolved(SESSION, SCOPE, REQUEST);
    await clearUnresolved(SCOPE);
    expect(await readUnresolved(SESSION, SCOPE)).toBeNull();
  });

  it('refuses a purpose that is not a plain slug', async () => {
    await expect(rememberUnresolved(SESSION, { purpose: 'A b' }, REQUEST)).rejects.toThrow();
  });
});

describe('the body digest', () => {
  it('is equal for equal bodies in any property order, and differs for any change', () => {
    const a = requestDigest(SESSION, 'p', { x: 1, y: { b: 2, a: [1, 2] } });
    expect(requestDigest(SESSION, 'p', { y: { a: [1, 2], b: 2 }, x: 1 })).toBe(a);
    expect(requestDigest(SESSION, 'p', { x: 1, y: { b: 2, a: [2, 1] } })).not.toBe(a);
    expect(requestDigest(SESSION, 'p', { x: 2, y: { b: 2, a: [1, 2] } })).not.toBe(a);
  });

  it('keeps omitted and null apart, and is keyed by person and purpose', () => {
    expect(requestDigest(SESSION, 'p', { x: null })).not.toBe(requestDigest(SESSION, 'p', {}));
    const body = { x: 1 };
    expect(requestDigest({ ...SESSION, subject: 'USR_2' }, 'p', body)).not.toBe(
      requestDigest(SESSION, 'p', body),
    );
    expect(requestDigest(SESSION, 'q', body)).not.toBe(requestDigest(SESSION, 'p', body));
  });
});
