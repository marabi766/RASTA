'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { User } from 'oidc-client-ts';
import { ApiClient, type GatewayClient } from '../api/client';
import { createFixtureClient } from '../demo/fixture-client';
import { DEMO_IDENTITY, isFixtureMode, readDemoDataMode, type DemoDataMode } from '../demo/mode';
import { MissingConfigurationError, readPublicEnv, type PublicEnv } from '../env';
import { readClaims, type TokenClaims } from './claims';
import { getUserManager } from './user-manager';

/**
 * Session state for the whole application.
 *
 * The status is a closed set rather than a pair of booleans, because "not
 * signed in" and "we do not yet know" produce different screens and confusing
 * one for the other is how a portal flashes a login wall at a signed-in user
 * on every reload.
 */
export type SessionStatus =
  /** Asking Keycloak whether an SSO session exists. Nothing is known yet. */
  | 'loading'
  | 'anonymous'
  | 'authenticated'
  /** The application is misconfigured; no sign-in can be attempted. */
  | 'unavailable';

export interface SessionValue {
  readonly status: SessionStatus;
  readonly claims: TokenClaims | null;
  /** The organization every request will act as, or `null` before a choice. */
  readonly organizationId: string | null;
  /** Present when `status === 'unavailable'`. */
  readonly configurationIssues: readonly string[];
  readonly env: PublicEnv | null;
  /**
   * The selected data source, or `null` until there is one.
   *
   * Typed as the interface rather than the class, because in presentation mode
   * it is the fixture source. Screens cannot tell the two apart, and that is
   * the point — the only thing that legitimately knows is `dataMode`, and the
   * only thing that reads `dataMode` is the banner that discloses it.
   */
  readonly api: GatewayClient | null;
  /** Which source is selected. Decided from configuration, never from failure. */
  readonly dataMode: DemoDataMode;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /**
   * Selects the active tenant.
   *
   * Refuses an organization outside the token's membership set. That refusal
   * is a user-experience guard, not a security boundary — the gateway
   * validates `X-Organization-Id` against real memberships on every request
   * and answers `TENANT_MISMATCH` no matter what this function does
   * (ADR-009 Compliance).
   */
  selectOrganization(organizationId: string): boolean;
}

/**
 * Exported so a test can mount a screen against a known session without
 * standing up an identity provider. Application code uses `useSession`.
 */
export const SessionContext = createContext<SessionValue | null>(null);

/** Session-scoped, so a closed tab forgets the choice. Not a credential. */
const ACTIVE_ORGANIZATION_KEY = 'rasta.activeOrganizationId';

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [claims, setClaims] = useState<TokenClaims | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [configurationIssues, setConfigurationIssues] = useState<readonly string[]>([]);

  const [env, setEnv] = useState<PublicEnv | null>(null);
  // The token is held in a ref, not in state: it changes on every silent renew
  // and nothing renders from it, so putting it in state would re-render the
  // entire tree every fifteen minutes for no visible change.
  const accessToken = useRef<string | null>(null);
  const memberships = useRef<readonly string[]>([]);
  const fixtureClient = useRef<GatewayClient | null>(null);

  // Read at module scope of the effect rather than on every render: a value
  // that could change between renders would defeat the guarantee that the mode
  // is decided once.
  const [dataMode] = useState<DemoDataMode>(() => readDemoDataMode());

  useEffect(() => {
    let cancelled = false;

    // The mode is read once, before anything else, and never reconsidered.
    // Nothing that happens later — a failed request, a missing service, a
    // rejected token — can move a live session into fixtures.
    if (isFixtureMode(dataMode)) {
      void (async () => {
        const client = await createFixtureClient();
        if (cancelled) return;

        // No `oidc-client-ts`, no token, no storage. A fixture session is not a
        // signed-in session with the checks removed; it is a different thing
        // that never enters the authentication path at all.
        fixtureClient.current = client;
        memberships.current = [...DEMO_IDENTITY.organizationIds];
        setClaims(demoClaims());
        setOrganizationId(DEMO_IDENTITY.organizationId);
        setStatus('authenticated');
      })();

      return () => {
        cancelled = true;
      };
    }

    let resolvedEnv: PublicEnv;
    try {
      resolvedEnv = readPublicEnv();
    } catch (error) {
      if (error instanceof MissingConfigurationError) {
        setConfigurationIssues(error.issues);
        setStatus('unavailable');
        return;
      }
      throw error;
    }

    setEnv(resolvedEnv);

    const adopt = (user: User | null): void => {
      if (cancelled) return;

      if (!user || !user.access_token || user.expired) {
        accessToken.current = null;
        memberships.current = [];
        setClaims(null);
        setStatus('anonymous');
        return;
      }

      accessToken.current = user.access_token;
      const nextClaims = readClaims(user.access_token);
      memberships.current = nextClaims.organizationIds;
      setClaims(nextClaims);
      setOrganizationId((current) => restoreSelection(current, nextClaims));
      setStatus('authenticated');
    };

    // `oidc-client-ts` is imported on demand to keep it out of the initial
    // bundle, so the manager — and therefore the event subscription — arrives
    // asynchronously. `detach` is filled in once it does; a component unmounted
    // before then is covered by `cancelled`.
    let detach: (() => void) | null = null;

    void (async () => {
      const manager = await getUserManager(resolvedEnv);
      if (cancelled) return;

      const onUnloaded = (): void => adopt(null);
      manager.events.addUserLoaded(adopt);
      manager.events.addUserUnloaded(onUnloaded);
      manager.events.addSilentRenewError(onUnloaded);
      manager.events.addAccessTokenExpired(onUnloaded);

      detach = () => {
        manager.events.removeUserLoaded(adopt);
        manager.events.removeUserUnloaded(onUnloaded);
        manager.events.removeSilentRenewError(onUnloaded);
        manager.events.removeAccessTokenExpired(onUnloaded);
      };

      const existing = await manager.getUser();
      if (existing && !existing.expired) {
        adopt(existing);
        return;
      }

      // No token in memory — which is every reload, by design. Keycloak's own
      // SSO cookie is what makes this succeed without another password prompt;
      // when there is no session it fails, and that failure is simply
      // "anonymous", not an error worth showing.
      try {
        adopt(await manager.signinSilent());
      } catch {
        adopt(null);
      }
    })();

    return () => {
      cancelled = true;
      detach?.();
    };
    // `dataMode` is stable — it comes from a `useState` initializer and has no
    // setter — so declaring it re-runs nothing. It is declared because the
    // effect branches on it, and an undeclared branch condition is how a mode
    // switch would silently fail to take effect.
  }, [dataMode]);

  const signIn = useCallback(async () => {
    // A fixture session has no identity provider to redirect to, and reaching
    // for one would be the exact coupling this mode exists to avoid.
    if (isFixtureMode(dataMode) || !env) return;
    const manager = await getUserManager(env);
    await manager.signinRedirect({
      // Comes back as `state` on the callback, so a deep link survives the
      // round trip through the identity provider.
      state: { returnTo: window.location.pathname + window.location.search },
    });
  }, [env, dataMode]);

  const signOut = useCallback(async () => {
    if (isFixtureMode(dataMode) || !env) return;
    clearSelection();
    const manager = await getUserManager(env);
    await manager.signoutRedirect();
  }, [env, dataMode]);

  const selectOrganization = useCallback((next: string): boolean => {
    if (!memberships.current.includes(next)) return false;
    setOrganizationId(next);
    persistSelection(next);
    return true;
  }, []);

  /**
   * The single data-source selection point for the whole application.
   *
   * Everything above this line is identical in both modes: the same adapters,
   * the same screens, the same schemas, the same four render states. That is
   * deliberate — a presentation that took a different code path from the
   * product would be demonstrating the presentation.
   */
  const api = useMemo<GatewayClient | null>(() => {
    if (status !== 'authenticated') return null;
    if (isFixtureMode(dataMode)) return fixtureClient.current;
    if (!env) return null;

    return new ApiClient({
      baseUrl: env.apiBaseUrl,
      // Read at call time so a silently renewed token is picked up without
      // rebuilding the client — and so a signed-out session cannot leave a
      // stale token captured in a closure.
      session: () =>
        accessToken.current
          ? {
              accessToken: accessToken.current,
              organizationId,
              organizationIds: memberships.current,
            }
          : null,
    });
  }, [env, status, organizationId, dataMode]);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      claims,
      organizationId,
      configurationIssues,
      env,
      api,
      dataMode,
      signIn,
      signOut,
      selectOrganization,
    }),
    [
      status,
      claims,
      organizationId,
      configurationIssues,
      env,
      api,
      dataMode,
      signIn,
      signOut,
      selectOrganization,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}

/**
 * The claims a fixture session presents.
 *
 * Shaped like `TokenClaims` so every screen reads it the same way, but built
 * from a constant rather than decoded from anything: there is no token in
 * fixture mode to decode. `expiresAt` is `null` because nothing expires when
 * nothing was issued — a fabricated expiry would invite the renew machinery to
 * take an interest in a session it has no business touching.
 */
function demoClaims(): TokenClaims {
  return {
    subject: DEMO_IDENTITY.subject,
    userId: DEMO_IDENTITY.userId,
    displayName: DEMO_IDENTITY.displayName,
    roles: [...DEMO_IDENTITY.roles],
    activeOrganizationId: DEMO_IDENTITY.organizationId,
    organizationIds: [...DEMO_IDENTITY.organizationIds],
    expiresAt: null,
  };
}

/**
 * Picks the organization to act as after a token arrives.
 *
 * Order matters: a choice the user made this session wins over the identity
 * provider's `org_id`, but only if the new token still backs it. A user
 * removed from an organization between two renews must not keep acting as it.
 */
function restoreSelection(current: string | null, claims: TokenClaims): string | null {
  if (current && claims.organizationIds.includes(current)) return current;

  const stored = readStoredSelection();
  if (stored && claims.organizationIds.includes(stored)) return stored;

  if (claims.activeOrganizationId && claims.organizationIds.includes(claims.activeOrganizationId)) {
    return claims.activeOrganizationId;
  }

  return claims.organizationIds.length === 1 ? (claims.organizationIds[0] ?? null) : null;
}

function readStoredSelection(): string | null {
  try {
    return window.sessionStorage.getItem(ACTIVE_ORGANIZATION_KEY);
  } catch {
    return null;
  }
}

function persistSelection(organizationId: string): void {
  try {
    window.sessionStorage.setItem(ACTIVE_ORGANIZATION_KEY, organizationId);
  } catch {
    // A browser that refuses storage loses the choice on navigation. That is a
    // degraded experience, not a failure worth interrupting the user for.
  }
}

function clearSelection(): void {
  try {
    window.sessionStorage.removeItem(ACTIVE_ORGANIZATION_KEY);
  } catch {
    /* see persistSelection */
  }
}
