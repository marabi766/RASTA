import { cookies } from 'next/headers';
import { webServerEnv } from './env';
import { SESSION_COOKIE, openSession, sessionSecondsLeft, type WebSession } from './session';

/**
 * Reading the current session.
 *
 * Server components and route handlers ask for this; nothing else in the app
 * touches the cookie. That single entry point is what makes "no token reaches
 * the browser" checkable rather than hopeful.
 *
 * Nothing here refreshes. `middleware.ts` has already done that for this
 * request, through `session-refresh.ts`, because middleware is the one place
 * a rotated refresh token can always be written back — see that file for why
 * a refresh during a render signed people out.
 */

/**
 * The session as it is stored, or null.
 *
 * Null for a cookie that will not open and for one past the configured
 * absolute lifetime (`WEB_SESSION_MAX_AGE_SECONDS`), checked here on the
 * server rather than left to the cookie's `Max-Age`, which only the browser
 * that received it honours.
 */
export async function readSession(now: number = Date.now()): Promise<WebSession | null> {
  const sealed = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!sealed) return null;

  const env = webServerEnv();
  const session = openSession(sealed, env.WEB_SESSION_SECRET);
  if (!session) return null;
  if (sessionSecondsLeft(session, env.WEB_SESSION_MAX_AGE_SECONDS, now) <= 0) return null;
  return session;
}

/**
 * The session a page or an action should act with, or null.
 *
 * Middleware refreshed the access token before this request reached here if
 * it was near expiry. One whose access token has nonetheless already expired
 * — the refresh failed, or middleware did not run — is not used: the caller
 * sends the person to sign in rather than sending the gateway a token it
 * will refuse.
 */
export async function currentSession(now: number = Date.now()): Promise<WebSession | null> {
  const session = await readSession(now);
  if (!session) return null;
  if (session.accessTokenExpiresAt <= Math.floor(now / 1000)) return null;
  return session;
}
