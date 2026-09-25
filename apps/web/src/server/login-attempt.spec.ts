/**
 * @jest-environment node
 */
import {
  LOGIN_ATTEMPT_COOKIE,
  loginAttemptCookieOptions,
  openLoginAttempt,
  readSealedLoginAttempt,
  safeReturnTo,
  sealLoginAttempt,
} from './login-attempt';

const SECRET = 'a-secret-that-is-long-enough-to-be-a-key';

const attempt = {
  state: 'state-value',
  nonce: 'nonce-value',
  verifier: 'verifier-value',
  returnTo: '/assets',
};

describe('the attempt cookie', () => {
  it('round-trips, and refuses a tampered value', () => {
    expect(openLoginAttempt(sealLoginAttempt(attempt, SECRET), SECRET)).toEqual(attempt);
    expect(openLoginAttempt('forged', SECRET)).toBeNull();
  });

  it('is Lax, and that is deliberate rather than an oversight', () => {
    // The callback arrives as a top-level navigation from Keycloak's origin. A
    // `Strict` cookie is not sent on one, so a `Strict` attempt cookie would be
    // missing at exactly the moment it is needed and every login would fail.
    const options = loginAttemptCookieOptions(true);
    expect(options.sameSite).toBe('lax');
    expect(options.httpOnly).toBe(true);
    expect(options.secure).toBe(true);
    // Short-lived: long enough to log in, short enough not to accumulate.
    expect(options.maxAge).toBe(600);
  });

  it('is a different cookie from the session', () => {
    expect(LOGIN_ATTEMPT_COOKIE).toBe('rasta_login');
  });

  it('does not leave the verifier readable', () => {
    const sealed = sealLoginAttempt(attempt, SECRET);
    expect(Buffer.from(sealed, 'base64url').toString('utf8')).not.toContain('verifier-value');
  });
});

describe('reading the attempt cookie out of a raw Cookie header (L5-08)', () => {
  it('finds the cookie among others and decodes it', () => {
    const sealed = sealLoginAttempt(attempt, SECRET);
    const header = `other=1; ${LOGIN_ATTEMPT_COOKIE}=${encodeURIComponent(sealed)}; more=2`;
    expect(readSealedLoginAttempt(header)).toBe(sealed);
  });

  it('returns null rather than throwing on a malformed percent-escape', () => {
    // A lone `%` makes `decodeURIComponent` throw `URIError`. A callback
    // request carrying this cookie must fail closed — the same `no_attempt`
    // refusal an absent cookie gets — not surface as a framework error.
    expect(readSealedLoginAttempt(`${LOGIN_ATTEMPT_COOKIE}=%`)).toBeNull();
    expect(readSealedLoginAttempt(`${LOGIN_ATTEMPT_COOKIE}=%ZZ`)).toBeNull();
  });

  it('returns null when there is no cookie header, or no matching cookie in it', () => {
    expect(readSealedLoginAttempt(null)).toBeNull();
    expect(readSealedLoginAttempt('other=1')).toBeNull();
  });
});

describe('where a login may send the browser afterwards', () => {
  it('keeps an in-app path', () => {
    expect(safeReturnTo('/assets/AST_1')).toBe('/assets/AST_1');
    expect(safeReturnTo('/')).toBe('/');
  });

  it('refuses an absolute url — that is an open redirect with cookie storage', () => {
    expect(safeReturnTo('https://evil.test/steal')).toBe('/');
    expect(safeReturnTo('http://evil.test')).toBe('/');
  });

  it('refuses a protocol-relative url, which a naive check accepts', () => {
    // `//evil.test` starts with a slash and is treated by every browser as an
    // absolute URL. This is the case a `startsWith('/')` guard gets wrong.
    expect(safeReturnTo('//evil.test/steal')).toBe('/');
  });

  it('refuses a backslash, which some browsers normalise into a slash', () => {
    expect(safeReturnTo('/\\evil.test')).toBe('/');
    expect(safeReturnTo('\\\\evil.test')).toBe('/');
  });

  it('refuses anything that is not a string', () => {
    expect(safeReturnTo(null)).toBe('/');
    expect(safeReturnTo(undefined)).toBe('/');
    expect(safeReturnTo(['/assets'])).toBe('/');
  });
});
