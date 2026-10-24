import { tokenAuthority } from './realm-roles';
import type { WebSession } from './session';

/**
 * Which organization a session acts for — decided in one place (task 100).
 *
 * ## The access token decides, nothing else
 *
 * The portal sends no `X-Organization-Id`, so every service acts for the
 * organization in the access token (`tokenAuthority`, the guard's own reading
 * of `org_id`, `org_ids` and `org_roles`). The session's `organizationId` is a
 * copy of that answer, written whenever a token is stored: at the login
 * (`auth/callback`), at every refresh and, for a cookie sealed before the copy
 * was kept in step, by middleware before the route runs
 * (`session-refresh.ts`). It used to be the login's answer forever: a refresh
 * after the person switched organization elsewhere took the new token and kept
 * the old copy, so the pages said A while every request acted for B (PR 405
 * review 1, F1).
 *
 * ## Fail closed
 *
 * A session is usable for tenant data only when its token resolves (the guard
 * would not answer `TENANT_MISMATCH` to it) **and** the stored copy says the
 * same. Otherwise `readSession()` returns none — no page draws an organization,
 * a list or a form for it — and middleware hides it from the render when it
 * cannot rewrite it (`session-refresh.ts`). This only decides what the portal
 * draws and which form it accepts: the token is not verified here, and the
 * gateway and the service still decide every request.
 */

/** What an access token resolves to: an organization, none (a platform-wide token), or nothing usable. */
export type TokenOrganization =
  | { readonly kind: 'ORGANIZATION'; readonly organizationId: string }
  | { readonly kind: 'NONE' }
  | { readonly kind: 'UNRESOLVED' };

export function tokenOrganizationOf(accessToken: string): TokenOrganization {
  const authority = tokenAuthority(accessToken);
  if (!authority) return { kind: 'UNRESOLVED' };
  return authority.organizationId === null
    ? { kind: 'NONE' }
    : { kind: 'ORGANIZATION', organizationId: authority.organizationId };
}

/**
 * The value to store in a session's `organizationId` beside this token. An
 * unresolved token stores null, which no reader takes for "no organization":
 * every reader asks the token first.
 */
export function storedOrganizationFor(accessToken: string): string | null {
  const resolved = tokenOrganizationOf(accessToken);
  return resolved.kind === 'ORGANIZATION' ? resolved.organizationId : null;
}

/**
 * The one answer every consumer reads: the organization this session acts for
 * (null: a platform-wide token with no organization), or `undefined` when it
 * cannot be told — the token does not resolve, or the stored copy disagrees
 * with it.
 */
export function sessionOrganization(session: WebSession): string | null | undefined {
  const resolved = tokenOrganizationOf(session.accessToken);
  if (resolved.kind === 'UNRESOLVED') return undefined;
  const organizationId = resolved.kind === 'ORGANIZATION' ? resolved.organizationId : null;
  return organizationId === session.organizationId ? organizationId : undefined;
}

/** Thrown where a session that `readSession()` would have refused reaches a consumer. */
export class UnresolvedSessionOrganization extends Error {
  constructor() {
    super('The session organization cannot be resolved from its access token.');
    this.name = 'UnresolvedSessionOrganization';
  }
}

/**
 * The organization a page draws, filters and binds forms for. Every consumer
 * reads this, never the stored field (`session-organization.guard.spec.ts`).
 * Throws rather than guessing for a session `readSession()` would have
 * refused: a page that draws nothing is the fail-closed answer.
 */
export function actingOrganizationId(session: WebSession): string | null {
  const organizationId = sessionOrganization(session);
  if (organizationId === undefined) throw new UnresolvedSessionOrganization();
  return organizationId;
}

/** The top bar's label for it. */
export function actingOrganizationLabel(session: WebSession): string {
  return actingOrganizationId(session) ?? 'بدون سازمان فعال';
}

/**
 * A React key for a page's whole tree (`<AppShell key=…>`), so a switch of
 * organization remounts everything on it: no state drawn for one organization
 * — a restored record, a picked member, an answer still in flight — survives
 * into the other's page, even where a refresh re-renders the same route.
 */
export function actingScope(session: WebSession): string {
  return `organization:${actingOrganizationId(session) ?? ''}`;
}
