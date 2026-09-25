import { createHash } from 'node:crypto';
import type { WebServerEnv } from './env';
import { endpointsFor, OidcError, refreshTokens, type TokenResponse } from './oidc';
import { openSession, sealSession, sessionSecondsLeft, type WebSession } from './session';

/**
 * Keeping a session's tokens usable, at the one point where the result can
 * always be written back (ADR-059 § 4).
 *
 * ## Why this runs in middleware and not during a render
 *
 * The realm rotates refresh tokens: `revokeRefreshToken: true` with
 * `refreshTokenMaxReuse: 0` (`infrastructure/docker/keycloak/rasta-realm.json`).
 * Every refresh spends the refresh token it presents. A server component
 * cannot set a cookie, so the refresh `currentSession()` used to perform
 * during a render handed the new tokens to that one render and left the
 * cookie holding the spent token. The next navigation presented it, Keycloak
 * refused it, and the person was signed out — every access-token lifetime
 * (15 minutes in the development realm) for somebody who was only reading.
 *
 * Middleware runs before every route this portal serves and can always set a
 * cookie, on the response *and* on the request the render then reads. So the
 * rotation happens here, is persisted here, and the render sees the rotated
 * session in the same request.
 *
 * ## Two requests, one refresh token
 *
 * A browser can send several requests with the same cookie at once — a
 * navigation and its prefetches, two tabs. With reuse refused, the second
 * refresh of the same token would fail and end a perfectly good session. So
 * a refresh in flight — or finished moments ago — is shared by every request
 * that presents the same token, within this process. Replicas behind a load
 * balancer do not share this map: covering them needs sticky sessions or a
 * realm `refreshTokenMaxReuse` above zero, a decision for the realm's owner
 * rather than for this file.
 */

/** What a request's session cookie turned out to be. */
export type SessionRenewal =
  /** No cookie, nothing to do. */
  | { readonly kind: 'NONE' }
  /** A usable session that needs no change. */
  | { readonly kind: 'VALID' }
  /** Refreshed: write this cookie back, living no longer than `maxAgeSeconds`. */
  | { readonly kind: 'RENEWED'; readonly sealed: string; readonly maxAgeSeconds: number }
  /** Unreadable, past its lifetime, or refused by the provider: clear it. */
  | { readonly kind: 'ENDED' };

/**
 * How close to expiry counts as expired.
 *
 * A token that has thirty seconds left will very likely be rejected by the
 * time the gateway looks at it, and the request it fails is one a person is
 * waiting on. Refreshing early costs one call to Keycloak; not refreshing
 * costs a visible error on a page that was fine.
 */
export const REFRESH_SKEW_SECONDS = 60;

export function isExpiring(session: WebSession, now: number = Date.now()): boolean {
  return session.accessTokenExpiresAt - REFRESH_SKEW_SECONDS <= Math.floor(now / 1000);
}

/**
 * How long a refresh result is shared with other requests presenting the
 * same, now spent, refresh token. Longer than the token endpoint's own
 * deadline, so a request that arrives while the first is still waiting is
 * covered, and short enough that the tokens do not outstay their purpose in
 * memory.
 */
const SHARED_REFRESH_WINDOW_MS = 30_000;

interface SharedRefresh {
  readonly startedAt: number;
  readonly result: Promise<TokenResponse>;
}

/** Keyed by a hash of the refresh token, so the map never holds one it was given. */
const inFlight = new Map<string, SharedRefresh>();

function keyOf(refreshToken: string): string {
  return createHash('sha256').update(refreshToken, 'utf8').digest('base64url');
}

/** One refresh per refresh token, however many requests ask for it at once. */
function sharedRefresh(
  refreshToken: string,
  now: number,
  refresh: (refreshToken: string) => Promise<TokenResponse>,
): Promise<TokenResponse> {
  for (const [key, entry] of inFlight) {
    if (now - entry.startedAt > SHARED_REFRESH_WINDOW_MS) inFlight.delete(key);
  }

  const key = keyOf(refreshToken);
  const existing = inFlight.get(key);
  if (existing) return existing.result;

  const result = refresh(refreshToken);
  inFlight.set(key, { startedAt: now, result });
  return result;
}

export interface RenewalDependencies {
  readonly env: Pick<
    WebServerEnv,
    'OIDC_ISSUER_URL' | 'OIDC_CLIENT_ID' | 'WEB_SESSION_SECRET' | 'WEB_SESSION_MAX_AGE_SECONDS'
  >;
  /** The token endpoint call. Defaults to the real one; a seam for tests. */
  readonly refresh?: (refreshToken: string) => Promise<TokenResponse>;
  readonly now?: number;
}

/**
 * Decides what to do with a request's sealed session cookie.
 *
 * Fails closed on every path that cannot prove the session is still good: a
 * cookie that will not open, one past `WEB_SESSION_MAX_AGE_SECONDS`, and a
 * refresh the provider refused or did not answer in time all end it. Only an
 * error that is not the provider's — a bug — propagates.
 */
export async function renewSession(
  sealed: string | undefined,
  deps: RenewalDependencies,
): Promise<SessionRenewal> {
  if (!sealed) return { kind: 'NONE' };

  const now = deps.now ?? Date.now();
  const { env } = deps;

  const session = openSession(sealed, env.WEB_SESSION_SECRET);
  if (!session) return { kind: 'ENDED' };

  const secondsLeft = sessionSecondsLeft(session, env.WEB_SESSION_MAX_AGE_SECONDS, now);
  if (secondsLeft <= 0) return { kind: 'ENDED' };

  if (!isExpiring(session, now)) return { kind: 'VALID' };

  const refresh =
    deps.refresh ??
    ((refreshToken: string) =>
      refreshTokens({
        endpoints: endpointsFor(env.OIDC_ISSUER_URL),
        clientId: env.OIDC_CLIENT_ID,
        refreshToken,
      }));

  let tokens: TokenResponse;
  try {
    tokens = await sharedRefresh(session.refreshToken, now, refresh);
  } catch (error) {
    if (error instanceof OidcError) return { kind: 'ENDED' };
    throw error;
  }

  const renewed: WebSession = {
    ...session,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: Math.floor(now / 1000) + tokens.expires_in,
    refreshToken: tokens.refresh_token,
    // `issuedAt` is carried over untouched by the spread: a refresh extends
    // the access token, never the session.
  };

  return {
    kind: 'RENEWED',
    sealed: sealSession(renewed, env.WEB_SESSION_SECRET),
    // The cookie lives no longer than the session it carries.
    maxAgeSeconds: secondsLeft,
  };
}

/** Test seam: forget every shared refresh. */
export function forgetSharedRefreshes(): void {
  inFlight.clear();
}
