import { z } from 'zod';
import { open, seal } from './session';

/**
 * The state carried between the redirect out to Keycloak and the redirect
 * back (ADR-059 § 1).
 *
 * Sealed with the same key as the session, in a cookie of its own that lives
 * ten minutes. It is not part of the session because there is no session yet:
 * this is what exists *while* somebody is logging in.
 *
 * ## Why this cookie is `Lax` and the session cookie is `Strict`
 *
 * The callback arrives as a top-level navigation **from Keycloak's origin**.
 * A `Strict` cookie is not sent on a cross-site navigation, so a `Strict`
 * login-attempt cookie would be missing at exactly the moment it is needed,
 * and every login would fail with "no attempt in progress". `Lax` is sent on a
 * top-level GET, which is precisely this case and no other.
 *
 * That is not a weakening of the session's own `Strict`: this cookie holds no
 * token, it is useless without the matching `state` in the URL, and it is
 * deleted the moment the callback runs.
 */

export const LOGIN_ATTEMPT_COOKIE = 'rasta_login';

/** Ten minutes: long enough to log in, short enough not to accumulate. */
export const LOGIN_ATTEMPT_MAX_AGE_SECONDS = 600;

export const loginAttemptSchema = z.object({
  /** Tied to the `state` parameter; proves the callback answers this request. */
  state: z.string().min(1),
  /** Tied to the id token's `nonce` claim; proves the token is not a replay. */
  nonce: z.string().min(1),
  /** The PKCE verifier. Never leaves this server. */
  verifier: z.string().min(1),
  /**
   * Where to send the browser afterwards.
   *
   * A path, never a URL, and validated again on use. A stored absolute URL is
   * an open redirect with a cookie for storage.
   */
  returnTo: z.string().startsWith('/'),
});

export type LoginAttempt = z.infer<typeof loginAttemptSchema>;

export function sealLoginAttempt(attempt: LoginAttempt, secret: string): string {
  return seal(loginAttemptSchema.parse(attempt), secret);
}

export function openLoginAttempt(sealed: string, secret: string): LoginAttempt | null {
  return open(sealed, secret, loginAttemptSchema);
}

export function loginAttemptCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    // See the note above: `strict` would not survive Keycloak's redirect back.
    sameSite: 'lax' as const,
    path: '/',
    maxAge: LOGIN_ATTEMPT_MAX_AGE_SECONDS,
  };
}

/**
 * Narrows a caller-supplied destination to a safe in-app path.
 *
 * Anything that is not a single-slash-rooted path becomes `/`. That rules out
 * `https://evil.test`, protocol-relative `//evil.test` — which a naive
 * `startsWith('/')` check accepts and a browser treats as absolute — and
 * anything with a backslash, which some browsers normalise into a slash.
 */
export function safeReturnTo(candidate: unknown): string {
  if (typeof candidate !== 'string') return '/';
  if (!candidate.startsWith('/')) return '/';
  if (candidate.startsWith('//')) return '/';
  if (candidate.includes('\\')) return '/';
  return candidate;
}
