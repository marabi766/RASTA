/**
 * @jest-environment node
 *
 * Server code, tested in the environment it runs in. The portal's default is
 * jsdom, which is right for components and wrong here: this file is about
 * `fetch`, `Response` and `node:crypto`, and a browser-shaped environment
 * would be testing a different runtime than the one that serves the request.
 */
import {
  SESSION_COOKIE,
  seal,
  csrfMatches,
  newCsrfToken,
  openSession,
  sealSession,
  sessionCookieOptions,
  viewOf,
  type WebSession,
} from './session';

/**
 * The session cookie is where this portal's whole security posture lives
 * (ADR-059 § 4), so what it refuses matters more than what it accepts.
 */

const SECRET = 'a-secret-that-is-long-enough-to-be-a-key';

function session(overrides: Partial<WebSession> = {}): WebSession {
  return {
    subject: 'USR_01J8',
    username: 'dehyar',
    organizationId: 'ORG_01J8',
    accessToken: 'access-token-value',
    accessTokenExpiresAt: 1_800_000_000,
    refreshToken: 'refresh-token-value',
    csrfToken: 'csrf-token-value',
    ...overrides,
  };
}

describe('sealing and opening', () => {
  it('round-trips a session', () => {
    expect(openSession(sealSession(session(), SECRET), SECRET)).toEqual(session());
  });

  it('produces a different ciphertext every time for the same input', () => {
    // A fresh nonce per seal. Reusing one with the same key breaks AES-GCM
    // outright, so this is a correctness assertion and not an aesthetic one.
    const first = sealSession(session(), SECRET);
    const second = sealSession(session(), SECRET);
    expect(first).not.toEqual(second);
    expect(openSession(first, SECRET)).toEqual(openSession(second, SECRET));
  });

  it('refuses a cookie sealed with another key', () => {
    expect(openSession(sealSession(session(), SECRET), `${SECRET}-different`)).toBeNull();
  });

  it('refuses a tampered cookie rather than opening it', () => {
    // GCM authenticates: a flipped byte fails to open instead of decrypting
    // into something the caller then has to be suspicious of.
    const sealed = sealSession(session(), SECRET);
    const bytes = Buffer.from(sealed, 'base64url');
    bytes[bytes.length - 1] ^= 0xff;
    expect(openSession(bytes.toString('base64url'), SECRET)).toBeNull();
  });

  it('refuses a cookie whose authentication tag was shortened', () => {
    // A short tag is a weak tag: sixteen bytes make a forgery a one-in-2^128
    // event, four bytes make it one in 2^32. Both halves of the cipher state
    // the length, so a caller cannot present a shorter one and have it
    // verified against its own length.
    const sealed = sealSession(session(), SECRET);
    const raw = Buffer.from(sealed, 'base64url');
    const shortened = Buffer.concat([raw.subarray(0, 12), raw.subarray(12, 16), raw.subarray(28)]);
    expect(openSession(shortened.toString('base64url'), SECRET)).toBeNull();
  });

  it('refuses a truncated cookie', () => {
    const sealed = sealSession(session(), SECRET);
    expect(openSession(sealed.slice(0, 8), SECRET)).toBeNull();
  });

  it('refuses a cookie that is not sealed at all', () => {
    expect(openSession('not-a-cookie', SECRET)).toBeNull();
    expect(openSession('', SECRET)).toBeNull();
  });

  it('refuses a session whose shape no longer matches', () => {
    // A cookie from an older deployment, still sealed with the live key: it
    // opens cryptographically and is still not a session this code can use.
    // Treating it as one would hand a page half a session — a username with
    // no token behind it.
    const fromAnotherVersion = seal({ subject: 'USR_1', username: 'dehyar' }, SECRET);
    expect(openSession(fromAnotherVersion, SECRET)).toBeNull();
  });

  it('does not leave the tokens readable in the cookie value', () => {
    // The point of encrypting rather than signing: anybody who can read the
    // cookie jar gets nothing.
    const sealed = sealSession(session(), SECRET);
    const asText = Buffer.from(sealed, 'base64url').toString('utf8');
    expect(sealed).not.toContain('refresh-token-value');
    expect(asText).not.toContain('refresh-token-value');
    expect(asText).not.toContain('access-token-value');
  });
});

describe('cookie attributes', () => {
  it('is http-only, strict and path-wide', () => {
    const options = sessionCookieOptions({ secure: true, maxAgeSeconds: 3600 });
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('strict');
    expect(options.secure).toBe(true);
    expect(options.path).toBe('/');
    expect(options.maxAge).toBe(3600);
  });

  it('can drop Secure only because local development has no TLS', () => {
    // Stated rather than silent: a `Secure` cookie is never sent over plain
    // HTTP, so on localhost the portal would appear to log nobody in.
    expect(sessionCookieOptions({ secure: false, maxAgeSeconds: 60 }).secure).toBe(false);
  });

  it('names the cookie the same way everywhere', () => {
    expect(SESSION_COOKIE).toBe('rasta_session');
  });
});

describe('the CSRF token', () => {
  it('is long and different every time', () => {
    const first = newCsrfToken();
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(newCsrfToken()).not.toEqual(first);
  });

  it('matches only the exact value', () => {
    const token = newCsrfToken();
    expect(csrfMatches(token, token)).toBe(true);
    expect(csrfMatches(token, `${token}x`)).toBe(false);
    expect(csrfMatches(token, token.slice(0, -1))).toBe(false);
    expect(csrfMatches(token, '')).toBe(false);
  });

  it('refuses anything that is not a string, including a missing field', () => {
    // A form without the field yields `null` from `FormData.get`, and a
    // comparison that coerced it would accept the request it exists to refuse.
    const token = newCsrfToken();
    expect(csrfMatches(token, null)).toBe(false);
    expect(csrfMatches(token, undefined)).toBe(false);
    expect(csrfMatches(token, { toString: () => token })).toBe(false);
  });
});

describe('what a page is allowed to see', () => {
  it('carries no token into the view a React tree receives', () => {
    // A React tree is serialized into the page for hydration. Anything in it
    // is in the HTML, which is why the shell takes this and not the session.
    const view = viewOf(session());
    expect(view).toEqual({
      subject: 'USR_01J8',
      username: 'dehyar',
      organizationId: 'ORG_01J8',
    });
    expect(JSON.stringify(view)).not.toContain('token');
  });
});
