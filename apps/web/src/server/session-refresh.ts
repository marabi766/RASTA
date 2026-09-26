import Redis from 'ioredis';
import type { WebServerEnv } from './env';
import { endpointsFor, refreshTokens, type TokenResponse } from './oidc';
import {
  processRefreshCoordinator,
  redisRefreshCoordinator,
  type RefreshCoordinator,
} from './refresh-coordinator';
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
 * navigation and its prefetches, two tabs — and they may land on different
 * replicas. `refresh-coordinator.ts` makes them share one refresh, across
 * replicas through Redis when `WEB_REDIS_URL` is set.
 *
 * ## A refusal never clears the cookie
 *
 * When the provider refuses a refresh, it may be because another replica
 * spent the token a moment ago and is sending the rotated cookie back right
 * now. Clearing the cookie here would race that response, and whichever
 * arrived last would decide whether the person stays signed in. So a refusal
 * leaves the browser's cookie untouched; only this render stops using a
 * session whose access token has already run out. A cookie that genuinely
 * died is harmless where it is — its refresh token is spent and its access
 * token expired — and the next sign-in replaces it.
 */

/** What a request's session cookie turned out to be. */
export type SessionRenewal =
  /** No cookie, nothing to do. */
  | { readonly kind: 'NONE' }
  /** A usable session that needs no change. */
  | { readonly kind: 'VALID' }
  /** Refreshed: write this cookie back, living no longer than `maxAgeSeconds`. */
  | { readonly kind: 'RENEWED'; readonly sealed: string; readonly maxAgeSeconds: number }
  /**
   * The refresh was refused or went unanswered. Leave the browser's cookie
   * alone (see above); `usable` says whether this request may still act on
   * the session — true while its access token has not yet expired.
   */
  | { readonly kind: 'REFUSED'; readonly usable: boolean }
  /**
   * Definitively over, on any replica at any moment: the cookie does not open,
   * or it is past `WEB_SESSION_MAX_AGE_SECONDS`. Clear it.
   */
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

export interface RenewalDependencies {
  readonly env: Pick<
    WebServerEnv,
    | 'OIDC_ISSUER_URL'
    | 'OIDC_CLIENT_ID'
    | 'WEB_SESSION_SECRET'
    | 'WEB_SESSION_MAX_AGE_SECONDS'
    | 'WEB_REDIS_URL'
  >;
  /** The token endpoint call. Defaults to the real one; a seam for tests. */
  readonly refresh?: (refreshToken: string) => Promise<TokenResponse>;
  /** Who shares the refresh. Defaults to the process-wide one for this env. */
  readonly coordinator?: RefreshCoordinator;
  readonly now?: number;
}

/**
 * Decides what to do with a request's sealed session cookie.
 *
 * A cookie that will not open or is past `WEB_SESSION_MAX_AGE_SECONDS` is
 * ended. A refresh the provider refused or did not answer in time is
 * `REFUSED`: the cookie stays, and the session is used only while its access
 * token is still valid — so nothing past its expiry is ever sent onward. Only
 * an error that is not the provider's — a bug — propagates.
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

  const coordinator = deps.coordinator ?? defaultCoordinator(env);
  const outcome = await coordinator.refresh(session.refreshToken, refresh);
  if (outcome.kind === 'REFUSED') {
    return { kind: 'REFUSED', usable: session.accessTokenExpiresAt > Math.floor(now / 1000) };
  }
  const { tokens } = outcome;

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

// ---------------------------------------------------------------------------
// The process-wide coordinator
// ---------------------------------------------------------------------------

let coordinator: RefreshCoordinator | undefined;

/** Warnings an operator must see, at most once a minute each. Names no token. */
const lastWarned = new Map<string, number>();
function warnOperator(code: string, message: string): void {
  const now = Date.now();
  if (now - (lastWarned.get(code) ?? 0) < 60_000) return;
  lastWarned.set(code, now);
  process.emitWarning(message, { code });
}

/**
 * Redis when `WEB_REDIS_URL` is set, this process alone otherwise.
 *
 * Without Redis, two replicas can still race for one refresh token; the
 * loser's refusal leaves the cookie alone, so the cost is one request that
 * sees the person as signed out, never a sign-out. That is acceptable for
 * one replica and development, and said out loud for anything else.
 */
function defaultCoordinator(env: RenewalDependencies['env']): RefreshCoordinator {
  if (coordinator) return coordinator;

  if (!env.WEB_REDIS_URL) {
    warnOperator(
      'RASTA_WEB_REFRESH_UNCOORDINATED',
      'WEB_REDIS_URL is not set: session refreshes are coordinated within this process only. ' +
        'Set it wherever the portal runs more than one replica or worker.',
    );
    coordinator = processRefreshCoordinator();
    return coordinator;
  }

  const redis = new Redis(env.WEB_REDIS_URL, {
    // Bounded, not instant: a command may wait for the connection being
    // established — the first refresh after a start or a reconnect would
    // otherwise always go uncoordinated — but never longer than
    // `commandTimeout`. Past it the command fails and the refresh goes ahead
    // uncoordinated rather than holding a person's request.
    enableOfflineQueue: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 2_000,
  });
  // A connection error is reported per command; the client's own event would
  // otherwise be an unhandled 'error' and take the process down.
  redis.on('error', () => undefined);

  coordinator = redisRefreshCoordinator({
    redis,
    secret: env.WEB_SESSION_SECRET,
    onRedisError: () =>
      warnOperator(
        'RASTA_WEB_REFRESH_REDIS_UNAVAILABLE',
        'Redis is unavailable: session refreshes are proceeding uncoordinated.',
      ),
  });
  return coordinator;
}

/** Test seam: drop the process-wide coordinator and everything it holds. */
export function forgetSharedRefreshes(): void {
  coordinator = undefined;
  lastWarned.clear();
}
