import type * as OidcClient from 'oidc-client-ts';
import { UnreadableTokenError, readClaims } from './claims';
import { buildSettings } from './user-manager';
import type { PublicEnv } from '../env';

/**
 * The authentication surface, checked for the properties that would be
 * expensive to discover in production.
 */

const ENV: PublicEnv = {
  apiBaseUrl: 'http://localhost:3000',
  keycloakUrl: 'http://localhost:8080',
  keycloakRealm: 'rasta',
  keycloakClientId: 'rasta-web',
};

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.signature-not-checked-here`;
}

// A minimal stand-in for the parts of `oidc-client-ts` `buildSettings` uses.
// Keeps this suite off the real library's storage machinery while still
// exercising the settings object the application actually constructs.
class FakeStore {
  constructor(readonly options: { store: unknown }) {}
}
class FakeMemory {}
const fakeOidc = {
  WebStorageStateStore: FakeStore,
  InMemoryWebStorage: FakeMemory,
} as unknown as typeof OidcClient;

describe('OIDC configuration', () => {
  const settings = buildSettings(fakeOidc, ENV, 'http://localhost:3200');

  it('uses Authorization Code with PKCE', () => {
    expect(settings.response_type).toBe('code');
    expect(settings.disablePKCE).toBe(false);
  });

  it('embeds no client secret and no password', () => {
    const serialized = JSON.stringify(settings, (_key, value) =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? { ...(value as object) }
        : value,
    );

    expect(serialized).not.toMatch(/client_secret|password|secret/i);
    expect(Object.keys(settings)).not.toContain('client_secret');
    // A password grant would need these; neither exists in the settings.
    expect(serialized).not.toMatch(/grant_type/);
  });

  it('points at the realm discovery authority and this origin callback', () => {
    expect(settings.authority).toBe('http://localhost:8080/realms/rasta');
    expect(settings.redirect_uri).toBe('http://localhost:3200/auth/callback');
    expect(settings.silent_redirect_uri).toBe('http://localhost:3200/auth/silent-renew');
    expect(settings.post_logout_redirect_uri).toBe('http://localhost:3200/');
  });

  it('keeps tokens out of localStorage', () => {
    // docs/16 § 16.11: the access token lives in memory only.
    const userStore = settings.userStore as unknown as FakeStore;
    expect(userStore.options.store).toBeInstanceOf(FakeMemory);

    // The state store must persist across the redirect, so it is sessionStorage
    // — tab-scoped and cleared on close. Never localStorage.
    const stateStore = settings.stateStore as unknown as FakeStore;
    expect(stateStore.options.store).toBe(window.sessionStorage);
    expect(stateStore.options.store).not.toBe(window.localStorage);
  });
});

describe('reading access-token claims', () => {
  it('reads the membership set from org_ids', () => {
    const claims = readClaims(
      token({
        sub: 'kc-1',
        rasta_uid: 'usr_1',
        org_id: 'org_a',
        org_ids: ['org_a', 'org_b'],
        realm_access: { roles: ['PROCUREMENT_USER'] },
        preferred_username: 'ali',
        exp: 1_800_000_000,
      }),
    );

    expect(claims.userId).toBe('usr_1');
    expect(claims.organizationIds).toEqual(['org_a', 'org_b']);
    expect(claims.activeOrganizationId).toBe('org_a');
    expect(claims.roles).toEqual(['PROCUREMENT_USER']);
    expect(claims.expiresAt).toBe(1_800_000_000_000);
  });

  it('folds an active organization missing from org_ids into the membership set', () => {
    // `mergeMemberships` on the server does the same; dropping it here would
    // hide an organization the gateway would accept.
    const claims = readClaims(token({ sub: 'kc-1', org_id: 'org_a', org_ids: ['org_b'] }));
    expect([...claims.organizationIds].sort()).toEqual(['org_a', 'org_b']);
  });

  it('accepts the single-valued form Keycloak emits for one membership', () => {
    const claims = readClaims(token({ sub: 'kc-1', org_ids: 'org_only' }));
    expect(claims.organizationIds).toEqual(['org_only']);
  });

  it('reports no memberships rather than guessing when the claim is absent', () => {
    const claims = readClaims(token({ sub: 'kc-1' }));
    expect(claims.organizationIds).toEqual([]);
    expect(claims.activeOrganizationId).toBeNull();
  });

  it('falls back to the IdP subject when the platform id is absent', () => {
    expect(readClaims(token({ sub: 'kc-only' })).userId).toBe('kc-only');
  });

  it('decodes Persian claim values as UTF-8', () => {
    expect(readClaims(token({ sub: 'kc-1', name: 'علی رضایی' })).displayName).toBe('علی رضایی');
  });

  it('refuses anything that is not a JWT', () => {
    expect(() => readClaims('not-a-token')).toThrow(UnreadableTokenError);
    expect(() => readClaims('a.b.c')).toThrow(UnreadableTokenError);
  });

  it('refuses a payload with no subject', () => {
    expect(() => readClaims(token({ org_ids: ['org_a'] }))).toThrow(UnreadableTokenError);
  });
});
