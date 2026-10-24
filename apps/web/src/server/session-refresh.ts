import Redis from 'ioredis';
import type { WebServerEnv } from './env';
import { endpointsFor, refreshTokens, type TokenResponse } from './oidc';
import {
  processRefreshCoordinator,
  redisRefreshCoordinator,
  type RefreshCoordinator,
} from './refresh-coordinator';
import { openSession, sealSession, sessionSecondsLeft, type WebSession } from './session';
import { storedOrganizationFor } from './session-organization';

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
 * ## When a refusal clears the cookie, and when it does not
 *
 * When the provider refuses a refresh, it may be because another replica
 * spent the token a moment ago and is sending the rotated cookie back right
 * now. Clearing the cookie at once would race that response, and whichever
 * arrived last would decide whether the person stays signed in. So:
 *
 *   - a transient or ambiguous failure (no answer, a 5xx, a malformed body,
 *     an unheard-from holder) never clears it;
 *   - `invalid_grant` — the provider refused the token itself — clears it only
 *     after `REJECTION_GRACE_MS` since the token was first refused, with no
 *     rotation of it having appeared (Codex #113 R2-2). Within the grace the
 *     browser keeps its cookie, and a rotated one in flight still lands.
 *
 * Until then only this render stops using a session whose access token has
 * already run out. Without the terminal rule a revoked session kept its
 * cookie, and re-asked the provider, until its absolute lifetime ran out.
 *
 * ## The organization goes with the token
 *
 * The session's `organizationId` is the stored copy of the organization its
 * access token acts for (`session-organization.ts`). A refresh writes the new
 * token's, and a cookie whose copy disagrees with its token — sealed before
 * the copy was kept in step — is resealed with the token's here, before the
 * route runs, when its token needs no refresh. Where the cookie cannot be
 * written (a refused refresh, below) such a session is hidden from the render
 * instead: no page may draw it for one organization while it acts for another
 * (PR 405 review 1, F1).
 */

/**
 * How long after a token's first `invalid_grant` its cookie is still left
 * alone. Longer than a rotation takes to reach the browser, and than a
 * rotation stays in the shared store (30 s), so a concurrent rotation always
 * wins the race it would otherwise lose.
 */
export const REJECTION_GRACE_MS = 60_000;

/** What a request's session cookie turned out to be. */
export type SessionRenewal =
  /** No cookie, nothing to do. */
  | { readonly kind: 'NONE' }
  /** A usable session that needs no change. */
  | { readonly kind: 'VALID' }
  /**
   * Refreshed — or, with the same tokens, resealed so its stored organization
   * is its token's: write this cookie back, living no longer than
   * `maxAgeSeconds`.
   */
  | { readonly kind: 'RENEWED'; readonly sealed: string; readonly maxAgeSeconds: number }
  /**
   * The refresh was refused or went unanswered. Leave the browser's cookie
   * alone (see above); `usable` says whether this request may still act on
   * the session — true while its access token has not yet expired, judged by
   * the clock once the refresh settled, and its stored organization is its
   * token's (the cookie cannot be resealed here). Either way the failure may pass: the
   * login itself is not known to have ended (`session-state.ts`).
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
  /**
   * The clock read once the refresh has settled — for whether the access
   * token is still usable, and for the rejection grace. Defaults to `now` when
   * that is given (a test with a fixed instant), and to the real clock
   * otherwise. A refresh can take seconds; a decision taken from the instant
   * before it started could call a token usable that has expired meanwhile
   * (PR 319 review 3, finding 2).
   */
  readonly clock?: () => number;
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

  if (!isExpiring(session, now)) {
    if (inStep(session)) return { kind: 'VALID' };
    // Same tokens, the token's organization: no refresh is spent, so nothing
    // can race this write.
    const resealed: WebSession = {
      ...session,
      organizationId: storedOrganizationFor(session.accessToken),
    };
    return {
      kind: 'RENEWED',
      sealed: sealSession(resealed, env.WEB_SESSION_SECRET),
      maxAgeSeconds: secondsLeft,
    };
  }

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
  // Read after the await: the token may have run out while the refresh was out.
  const settledAt = deps.clock?.() ?? deps.now ?? Date.now();
  // A copy that disagrees with its token cannot be resealed on a refusal (the
  // cookie is left alone), so this render does not use it either.
  const usable = session.accessTokenExpiresAt > Math.floor(settledAt / 1000) && inStep(session);
  if (outcome.kind === 'REFUSED') return { kind: 'REFUSED', usable };
  if (outcome.kind === 'REJECTED') {
    // Terminal for the token — once the grace has passed with no rotation of
    // it having appeared anywhere (a rotation would have been returned here
    // instead: it outranks a rejection in the shared store).
    if (settledAt - outcome.firstRejectedAt >= REJECTION_GRACE_MS) return { kind: 'ENDED' };
    return { kind: 'REFUSED', usable };
  }
  const { tokens } = outcome;

  const renewed: WebSession = {
    ...session,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: Math.floor(now / 1000) + tokens.expires_in,
    refreshToken: tokens.refresh_token,
    // The new token's organization, never the login's: the person may have
    // switched organization since, and the token is what every service reads.
    organizationId: storedOrganizationFor(tokens.access_token),
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

/** True when the session's stored organization is the one its token acts for. */
function inStep(session: WebSession): boolean {
  return session.organizationId === storedOrganizationFor(session.accessToken);
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
