import { cookies, headers } from 'next/headers';
import { webServerEnv } from './env';
import { SESSION_COOKIE, openSession, sessionSecondsLeft, type WebSession } from './session';
import type { SessionRefusal } from '@/lib/session-refusal';
import { isRefreshUnavailable } from './session-state';
import { sessionOrganization } from './session-organization';

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
 * The sealed session as it is stored, or null: for logging out and nothing
 * else. It does not ask which organization the session acts for, so nothing it
 * returns may draw or send tenant data — a logout only needs the CSRF token,
 * and must work for a session that `readSession()` refuses.
 */
export async function readStoredSessionForLogout(
  now: number = Date.now(),
): Promise<WebSession | null> {
  const sealed = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!sealed) return null;

  const env = webServerEnv();
  const session = openSession(sealed, env.WEB_SESSION_SECRET);
  if (!session) return null;
  if (sessionSecondsLeft(session, env.WEB_SESSION_MAX_AGE_SECONDS, now) <= 0) return null;
  return session;
}

/**
 * The session as it is stored, or null.
 *
 * Null for a cookie that will not open and for one past the configured
 * absolute lifetime (`WEB_SESSION_MAX_AGE_SECONDS`), checked here on the
 * server rather than left to the cookie's `Max-Age`, which only the browser
 * that received it honours.
 *
 * Null, too, when it cannot be told which organization the session acts for:
 * its access token does not resolve, or the stored copy disagrees with the
 * token (`session-organization.ts`). Middleware rewrites a stale copy before
 * the route runs, so a session that still disagrees here is one nothing may
 * be drawn for — every direct reader (`AccountGuard`, `/login`) and every
 * `currentSession()` caller gets none, never the wrong organization.
 */
export async function readSession(now: number = Date.now()): Promise<WebSession | null> {
  const session = await readStoredSessionForLogout(now);
  if (!session) return null;
  if (sessionOrganization(session) === undefined) return null;
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

/**
 * When `currentSession()` found none: whether that may be temporary — the
 * access token ran out and its refresh is unavailable right now
 * (`session-state.ts`) — rather than the session having ended.
 */
export async function sessionTemporarilyUnavailable(): Promise<boolean> {
  return isRefreshUnavailable(await headers());
}

/**
 * Why `currentSession()` found none, for an action's refusal
 * (`lib/session-refusal.ts`): `SESSION_UNAVAILABLE` when the refresh is only
 * unavailable for now, `NO_SESSION` — the session has ended — otherwise.
 */
export async function missingSessionReason(): Promise<SessionRefusal> {
  return (await sessionTemporarilyUnavailable()) ? 'SESSION_UNAVAILABLE' : 'NO_SESSION';
}
