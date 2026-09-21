import { cookies } from 'next/headers';
import { webServerEnv } from './env';
import { endpointsFor, OidcError, refreshTokens } from './oidc';
import {
  SESSION_COOKIE,
  openSession,
  sealSession,
  sessionCookieOptions,
  type WebSession,
} from './session';

/**
 * Reading the current session, and keeping its access token usable.
 *
 * Server components and route handlers ask for this; nothing else in the app
 * touches the cookie. That single entry point is what makes "no token reaches
 * the browser" checkable rather than hopeful.
 */

/**
 * How close to expiry counts as expired.
 *
 * A token that has thirty seconds left will very likely be rejected by the
 * time the gateway looks at it, and the request it fails is one a person is
 * waiting on. Refreshing early costs one call to Keycloak; not refreshing
 * costs a visible error on a page that was fine.
 */
const REFRESH_SKEW_SECONDS = 60;

export function isExpiring(session: WebSession, now = Date.now()): boolean {
  return session.accessTokenExpiresAt - REFRESH_SKEW_SECONDS <= Math.floor(now / 1000);
}

/** The session as it is stored, or null. No refresh, no side effects. */
export async function readSession(): Promise<WebSession | null> {
  const sealed = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!sealed) return null;
  return openSession(sealed, webServerEnv().WEB_SESSION_SECRET);
}

/**
 * The session with a usable access token, refreshing it if it is about to
 * expire.
 *
 * Returns null when there is no session or when the refresh failed — a
 * refresh token can be revoked, expired or already used, and all three mean
 * the person has to log in again. The caller redirects; it is not this
 * function's business to decide where.
 *
 * ## Why the rewritten cookie may not reach the browser
 *
 * A server component cannot set a cookie in Next.js: only a route handler or
 * a server action can. When a refresh happens during a page render, the new
 * tokens are used for that render and the cookie is rewritten on the next
 * request that can write one. The session stays valid either way, because the
 * refresh token in the cookie is still the one Keycloak accepted — this costs
 * an extra refresh, not a broken session.
 */
export async function currentSession(): Promise<WebSession | null> {
  const session = await readSession();
  if (!session) return null;
  if (!isExpiring(session)) return session;

  const env = webServerEnv();
  try {
    const tokens = await refreshTokens({
      endpoints: endpointsFor(env.OIDC_ISSUER_URL),
      clientId: env.OIDC_CLIENT_ID,
      refreshToken: session.refreshToken,
    });

    const refreshed: WebSession = {
      ...session,
      accessToken: tokens.access_token,
      accessTokenExpiresAt: Math.floor(Date.now() / 1000) + tokens.expires_in,
      refreshToken: tokens.refresh_token,
    };

    try {
      (await cookies()).set(
        SESSION_COOKIE,
        sealSession(refreshed, env.WEB_SESSION_SECRET),
        sessionCookieOptions({
          secure: env.WEB_COOKIE_SECURE,
          maxAgeSeconds: env.WEB_SESSION_MAX_AGE_SECONDS,
        }),
      );
    } catch {
      // Rendering a page, where writing is not allowed. See the note above.
    }

    return refreshed;
  } catch (error) {
    if (error instanceof OidcError) return null;
    throw error;
  }
}
