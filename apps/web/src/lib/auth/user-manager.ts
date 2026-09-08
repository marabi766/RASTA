import type * as OidcClient from 'oidc-client-ts';
import type { UserManager, UserManagerSettings } from 'oidc-client-ts';
import { oidcAuthority, type PublicEnv } from '../env';

/**
 * The browser's OIDC client.
 *
 * Authorization Code + PKCE against the existing public `rasta-web` client
 * (ADR-008, `infrastructure/docker/keycloak/rasta-realm.json`, which pins
 * `pkce.code.challenge.method: S256`). There is no client secret, no password
 * grant and no bypass — a public client that held a secret would not be a
 * secret, and a password grant would put the user's credentials through this
 * application, which is the thing an identity provider exists to prevent.
 *
 * ## Where the tokens live
 *
 * docs/16 § 16.11 is unambiguous: «Access Token فقط در حافظه (نه localStorage —
 * بردار XSS)». So the user store is `InMemoryWebStorage` — the token is gone on
 * reload, and a session is restored by asking Keycloak again rather than by
 * reading it back off disk.
 *
 * The **state** store is different and has to be. The PKCE code verifier is
 * created before the redirect to Keycloak and needed after coming back, so it
 * must survive a full page navigation; memory cannot. It goes to
 * `sessionStorage`: scoped to the tab, cleared when the tab closes, and deleted
 * by `oidc-client-ts` as soon as the callback consumes it. A one-use verifier
 * is not a credential — but it is still why this is `sessionStorage` and not
 * `localStorage`.
 *
 * ## Why the library is imported dynamically
 *
 * `oidc-client-ts` is around 45 KiB gzip, and eagerly importing it put the
 * portal's first load at 194.8 KiB against ADR-003's 200 KiB budget — inside
 * the limit, but with no room for the next feature. It is only needed once a
 * session is being established or renewed, which is after first paint by
 * definition, so it loads then.
 *
 * ## What is deliberately not here
 *
 * A refresh token in an `HttpOnly` cookie, which docs/16 § 16.11 also asks for.
 * That needs a backend-for-frontend to hold it, and ADR-009 rejected a BFF per
 * frontend at this scale. Until that is resolved, session continuity comes from
 * Keycloak's own SSO cookie via a silent renew — recorded as a gap rather than
 * papered over with `localStorage`.
 */

/** Kept as constants so a stray route can never become a redirect target. */
export const CALLBACK_PATH = '/auth/callback';
export const SILENT_RENEW_PATH = '/auth/silent-renew';

type OidcModule = typeof OidcClient;

export function buildSettings(
  oidc: OidcModule,
  env: PublicEnv,
  origin: string,
): UserManagerSettings {
  return {
    authority: oidcAuthority(env),
    client_id: env.keycloakClientId,
    redirect_uri: `${origin}${CALLBACK_PATH}`,
    post_logout_redirect_uri: `${origin}/`,
    silent_redirect_uri: `${origin}${SILENT_RENEW_PATH}`,
    response_type: 'code',
    scope: 'openid profile email',
    // Explicit rather than relied upon. `oidc-client-ts` defaults to PKCE for
    // the code flow, and this line is what a reviewer greps for.
    disablePKCE: false,
    // Access token lifetime is 15 minutes (ADR-008 Compliance). Renewing
    // slightly ahead keeps a long screen from failing mid-read.
    automaticSilentRenew: true,
    accessTokenExpiringNotificationTimeInSeconds: 90,
    // The session-status iframe polls Keycloak on an interval and is a common
    // source of spurious sign-outs behind a proxy. Expiry is handled by the
    // renew above and by the gateway answering 401.
    monitorSession: false,
    // Everything the interface needs is already in the access token's claims
    // (`claims.ts`); a userinfo round trip per sign-in would add nothing.
    loadUserInfo: false,
    userStore: new oidc.WebStorageStateStore({ store: new oidc.InMemoryWebStorage() }),
    stateStore: new oidc.WebStorageStateStore({
      store: sessionStorageOrMemory(oidc),
      prefix: 'rasta.oidc.',
    }),
  };
}

/**
 * One `UserManager` per browsing context.
 *
 * The *promise* is cached rather than the instance, so two callers racing
 * during startup get the same manager. Two instances would mean two in-memory
 * user stores and two silent-renew timers, with the second quietly overwriting
 * the first's state entries.
 */
let pending: Promise<UserManager> | null = null;

export function getUserManager(env: PublicEnv): Promise<UserManager> {
  pending ??= (async () => {
    const oidc = await import('oidc-client-ts');
    return new oidc.UserManager(buildSettings(oidc, env, window.location.origin));
  })();

  return pending;
}

/** Test seam. Never called by application code. */
export function resetUserManagerForTests(): void {
  pending = null;
}

/**
 * `sessionStorage`, or memory when the browser refuses it.
 *
 * Private modes and hardened configurations throw on access rather than
 * returning null. Falling back to memory degrades the sign-in redirect — the
 * verifier will not survive it — instead of crashing the application on first
 * paint.
 */
function sessionStorageOrMemory(oidc: OidcModule): Storage {
  try {
    const probe = '__rasta_probe__';
    window.sessionStorage.setItem(probe, '1');
    window.sessionStorage.removeItem(probe);
    return window.sessionStorage;
  } catch {
    return new oidc.InMemoryWebStorage();
  }
}
