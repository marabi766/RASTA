import { isBoundSubmissionId, mintSubmissionId, submissionBinding } from './submission';
import type { WebSession } from './session';

/**
 * The submission id: a per-render reference, sent back with its form, bound to
 * the session it was issued for.
 *
 * What is asserted here is that only this server can issue one and only to the
 * session it was issued for. Whether a repeated id produces one record is the
 * receiving service's decision (`usage-records` and, since issue 157,
 * maintenance-service's and asset-service's creates store it), so
 * it is proven per service, in
 * `write.spec.ts` against a real fetch and in the browser suite, never here.
 */
describe('submission ids', () => {
  const SESSION: WebSession = {
    subject: 'USR_1',
    username: 'operator',
    organizationId: 'ORG_1',
    accessToken: 'access-token-value',
    accessTokenExpiresAt: 2_000_000_000,
    refreshToken: 'refresh-token-value',
    csrfToken: 'csrf-token-for-this-session',
    issuedAt: 1_900_000_000,
  };

  const ENV = {
    API_GATEWAY_URL: 'http://gateway.test:3000',
    OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
    OIDC_CLIENT_ID: 'rasta-web',
    WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
    WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  };

  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });
  afterAll(() => {
    process.env = original;
  });

  it('accepts an id it minted for the same session', () => {
    expect(isBoundSubmissionId(mintSubmissionId(SESSION), SESSION)).toBe(true);
  });

  it('mints a fresh id every time', () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintSubmissionId(SESSION)));
    expect(ids.size).toBe(200);
  });

  it('fits inside what a service stores as a client reference (8..128)', () => {
    const id = mintSubmissionId(SESSION);
    expect(id.length).toBeGreaterThanOrEqual(8);
    expect(id.length).toBeLessThanOrEqual(128);
    expect(id).toMatch(/^sub_[A-Za-z0-9_-]+$/);
  });

  it('refuses a well-formed id this server never issued', () => {
    // Right prefix, right length, right alphabet — and nobody's MAC.
    expect(isBoundSubmissionId(`sub_${'A'.repeat(38)}`, SESSION)).toBe(false);
    expect(isBoundSubmissionId(`sub_${'Zz9_-'.repeat(8)}ab`, SESSION)).toBe(false);
  });

  it('refuses an id a client chose for itself in the original, unbound format', () => {
    // The removed shape-only format: twenty characters after the prefix.
    expect(isBoundSubmissionId(`sub_${'B'.repeat(20)}`, SESSION)).toBe(false);
    expect(isBoundSubmissionId('chosen-by-the-client', SESSION)).toBe(false);
  });

  it('refuses another person’s id', () => {
    const id = mintSubmissionId(SESSION);
    expect(isBoundSubmissionId(id, { ...SESSION, subject: 'USR_2' })).toBe(false);
  });

  it('refuses an id minted under an earlier login: a new session has a new CSRF token', () => {
    const id = mintSubmissionId(SESSION);
    expect(isBoundSubmissionId(id, { ...SESSION, csrfToken: 'a-token-from-the-next-login' })).toBe(
      false,
    );
  });

  it('is unaffected by the session fields that do not identify the login', () => {
    const id = mintSubmissionId(SESSION);
    expect(
      isBoundSubmissionId(id, {
        ...SESSION,
        accessToken: 'refreshed',
        accessTokenExpiresAt: 2_100_000_000,
      }),
    ).toBe(true);
  });

  describe('bound to the organization the access token acts for (task 095)', () => {
    /** A token as the portal reads it: only the payload is decoded, never verified. */
    const token = (claims: Record<string, unknown>) =>
      `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
    const forOrg = (org: string | undefined, extra: Record<string, unknown> = {}): WebSession => ({
      ...SESSION,
      accessToken: token({ ...(org === undefined ? {} : { org_id: org }), ...extra }),
    });

    it('survives a refresh that keeps the organization', () => {
      const id = mintSubmissionId(forOrg('ORG-DEH-0001', { exp: 1 }));
      expect(isBoundSubmissionId(id, forOrg('ORG-DEH-0001', { exp: 2, jti: 'next' }))).toBe(true);
    });

    it('refuses a form drawn for one organization once the token acts for another', () => {
      // The session's own organizationId does not move on a refresh; the token's does.
      const id = mintSubmissionId(forOrg('ORG-DEH-0001'));
      expect(isBoundSubmissionId(id, forOrg('ORG-DEH-0002'))).toBe(false);
      expect(isBoundSubmissionId(id, forOrg(undefined))).toBe(false);
      // And the reverse: drawn while acting for none, sent while acting for one.
      expect(isBoundSubmissionId(mintSubmissionId(forOrg(undefined)), forOrg('ORG-DEH-0001'))).toBe(
        false,
      );
    });

    it('reads the claim strictly: an organization id the guard would not accept binds nothing', () => {
      const id = mintSubmissionId(forOrg('ORG-DEH-0001'));
      expect(isBoundSubmissionId(id, forOrg('ORG-DEH-0001:FLEET_MANAGER'))).toBe(false);
    });
  });

  it('refuses an id whose nonce or MAC was altered, one character at a time', () => {
    const id = mintSubmissionId(SESSION);
    for (let i = 'sub_'.length; i < id.length; i += 1) {
      const swapped = id[i] === 'A' ? 'B' : 'A';
      expect(isBoundSubmissionId(`${id.slice(0, i)}${swapped}${id.slice(i + 1)}`, SESSION)).toBe(
        false,
      );
    }
  });

  it('refuses a non-canonical spelling of a genuine MAC (the spare bits of the last character)', () => {
    const id = mintSubmissionId(SESSION);
    const last = id[id.length - 1];
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    // Characters that decode to the same 16 bytes: differ only in the four unused bits.
    const sibling =
      alphabet[(alphabet.indexOf(last) & ~0b1111) | ((alphabet.indexOf(last) + 1) & 0b1111)];
    expect(sibling).not.toBe(last);
    expect(isBoundSubmissionId(`${id.slice(0, -1)}${sibling}`, SESSION)).toBe(false);
  });

  it('refuses an id under a different server secret', () => {
    // `webServerEnv()` caches per module instance, so each verifier is loaded
    // fresh with the secret it should see.
    const verifierWith = (secret: string) => {
      let verify: (value: unknown, session: WebSession) => boolean = () => false;
      jest.isolateModules(() => {
        process.env.WEB_SESSION_SECRET = secret;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        verify = (require('./submission') as typeof import('./submission')).isBoundSubmissionId;
      });
      return verify;
    };

    const id = mintSubmissionId(SESSION);
    // The control: a fresh instance with the same secret accepts, so the
    // refusal below is the secret and not the isolation.
    expect(verifierWith(ENV.WEB_SESSION_SECRET)(id, SESSION)).toBe(true);
    expect(verifierWith('a-different-secret-that-is-also-long-enough')(id, SESSION)).toBe(false);
  });

  it.each([undefined, null, 42, {}, [], ''])('refuses %p', (value) => {
    expect(isBoundSubmissionId(value, SESSION)).toBe(false);
  });

  it('refuses the wrong length and a path separator', () => {
    const id = mintSubmissionId(SESSION);
    expect(isBoundSubmissionId(id.slice(0, -1), SESSION)).toBe(false);
    expect(isBoundSubmissionId(`${id}A`, SESSION)).toBe(false);
    expect(isBoundSubmissionId(`${id.slice(0, -1)}/`, SESSION)).toBe(false);
  });

  describe('the binding a browser may remember', () => {
    it('tells a re-login from another person, and is stable for one login', () => {
      const binding = submissionBinding(SESSION);
      expect(submissionBinding({ ...SESSION })).toEqual(binding);

      const relogin = submissionBinding({ ...SESSION, csrfToken: 'a-new-login' });
      expect(relogin.owner).toBe(binding.owner);
      expect(relogin.session).not.toBe(binding.session);

      expect(submissionBinding({ ...SESSION, subject: 'USR_2' }).owner).not.toBe(binding.owner);
      expect(submissionBinding({ ...SESSION, organizationId: 'ORG_2' }).owner).not.toBe(
        binding.owner,
      );
      expect(submissionBinding({ ...SESSION, organizationId: null }).owner).not.toBe(binding.owner);
    });

    it('reveals none of the session’s values, and depends on the server’s secret', () => {
      const binding = submissionBinding(SESSION);
      const text = JSON.stringify(binding);
      for (const value of [
        SESSION.subject,
        SESSION.csrfToken,
        SESSION.accessToken,
        SESSION.refreshToken,
      ]) {
        expect(text).not.toContain(value);
      }
      expect(binding.owner).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(binding.session).toMatch(/^[A-Za-z0-9_-]{16}$/);

      // `webServerEnv()` caches per module instance: load one with another secret.
      let other = binding;
      jest.isolateModules(() => {
        process.env.WEB_SESSION_SECRET = 'a-different-secret-that-is-also-long-enough';
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        other = (require('./submission') as typeof import('./submission')).submissionBinding(
          SESSION,
        );
      });
      expect(other).not.toEqual(binding);
    });
  });
});
