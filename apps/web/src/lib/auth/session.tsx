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
import { ApiClient } from '../api/client';
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
  /** Bound to the live session; `null` until there is one. */
  readonly api: ApiClient | null;
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

  useEffect(() => {
    let cancelled = false;

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
  }, []);

  const signIn = useCallback(async () => {
    if (!env) return;
    const manager = await getUserManager(env);
    await manager.signinRedirect({
      // Comes back as `state` on the callback, so a deep link survives the
      // round trip through the identity provider.
      state: { returnTo: window.location.pathname + window.location.search },
    });
  }, [env]);

  const signOut = useCallback(async () => {
    if (!env) return;
    clearSelection();
    const manager = await getUserManager(env);
    await manager.signoutRedirect();
  }, [env]);

  const selectOrganization = useCallback((next: string): boolean => {
    if (!memberships.current.includes(next)) return false;
    setOrganizationId(next);
    persistSelection(next);
    return true;
  }, []);

  const api = useMemo(() => {
    if (!env || status !== 'authenticated') return null;

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
  }, [env, status, organizationId]);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      claims,
      organizationId,
      configurationIssues,
      env,
      api,
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
