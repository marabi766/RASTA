/**
 * @jest-environment node
 */
import {
  isBoundSubmissionId,
  isSubmissionId,
  mintSubmissionId,
  newSubmissionId,
} from './submission';
import type { WebSession } from './session';

/**
 * The submission id: a per-render reference, sent back with its form.
 *
 * What is asserted here is its *shape*, its uniqueness, and — for the bound
 * kind — that only this server can issue one and only to the session it was
 * issued for. Whether a repeated id produces one record is the receiving
 * service's decision (`usage-records` stores it; maintenance-service's create
 * does not), so it is proven per service, in `write.spec.ts` against a real
 * fetch and in the browser suite, never here.
 */
describe('submission ids', () => {
  it('mints a fresh id every time', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSubmissionId()));
    expect(ids.size).toBe(200);
  });

  it('accepts what it mints', () => {
    for (let index = 0; index < 20; index += 1) {
      expect(isSubmissionId(newSubmissionId())).toBe(true);
    }
  });

  it('fits inside what a service stores as a client reference (8..128)', () => {
    const id = newSubmissionId();
    expect(id.length).toBeGreaterThanOrEqual(8);
    expect(id.length).toBeLessThanOrEqual(128);
  });

  it('refuses an id a client chose for itself', () => {
    // A caller-chosen reference could be short enough to collide on purpose,
    // which would hand somebody else's record back to them.
    expect(isSubmissionId('sub_aaa')).toBe(false);
    expect(isSubmissionId('sub_')).toBe(false);
    expect(isSubmissionId('nope')).toBe(false);
    expect(isSubmissionId(`sub_${'a'.repeat(200)}`)).toBe(false);
  });

  it('refuses a value that is not a string', () => {
    expect(isSubmissionId(undefined)).toBe(false);
    expect(isSubmissionId(null)).toBe(false);
    expect(isSubmissionId(42)).toBe(false);
  });

  it('refuses characters outside base64url, including a path separator', () => {
    expect(isSubmissionId('sub_aaaaaaaaaaaaaaaaaa/.')).toBe(false);
    expect(isSubmissionId('sub_aaaaaaaaaaaaaaaaaa+=')).toBe(false);
  });
});

describe('submission ids bound to a session', () => {
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
    expect(isBoundSubmissionId(newSubmissionId(), SESSION)).toBe(false);
    expect(isBoundSubmissionId('chosen-by-the-client', SESSION)).toBe(false);
  });

  it('is not accepted by the shape-only check, so the two kinds cannot be swapped', () => {
    expect(isSubmissionId(mintSubmissionId(SESSION))).toBe(false);
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
});
