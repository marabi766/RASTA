import { tokenActiveOrganization, tokenAuthority, type TokenAuthority } from './realm-roles';
import type { WebSession } from './session';

/** What every reader here needs of a session: its token and its pinned organization. */
export type SessionTokens = Pick<WebSession, 'accessToken' | 'organizationId'>;

/**
 * Which organization a session acts for — decided in one place.
 *
 * ## The session decides, the token must agree (task 118)
 *
 * A session is **pinned** to one organization when it is created: the access
 * token's active organization at sign-in (`pinnedOrganizationFor`, written by
 * `auth/callback`). Nothing changes it afterwards. A refresh brings a new token
 * and keeps the pin (`session-refresh.ts`), and every gateway call carries it
 * as `X-Organization-Id` (`tenantCredential` → `gateway.ts`), so the service
 * acts for the organization the page was drawn for — never for whichever one
 * the account was switched to elsewhere since (audit F2: a refresh after a
 * switch to B in another session used to leave the label on A while every
 * request acted for B; task 100 then moved the label to B silently).
 *
 * The guard checks the header against the token: the pinned organization must
 * be one of its memberships (`org_ids`) **and** hold a role there
 * (`org_roles`), otherwise the request is `TENANT_MISMATCH` — refused, never
 * re-resolved to the token's active organization (`resolveOrganization` in
 * nest-common). A header that differs from the token's active organization is
 * accepted when the token grants it: that is the pinning.
 *
 * ## Fail closed
 *
 * The session acts for its pinned organization only while its token grants
 * that organization a role (`sessionOrganization`). When a refreshed token no
 * longer does — the membership or every role in it was removed — the session
 * is not moved anywhere: `readSession()` refuses it and the person lands on
 * `/account/recovery`, which says the organization of this sign-in is no longer
 * theirs (`organizationLost`). Only a new sign-in pins another organization.
 *
 * A session pinned to **no** organization (a token with no `org_id` at sign-in)
 * acts for none: it sends no header, its tenant-bound pages and actions are
 * refused before anything is sent (`tenant-gate.ts`, `tenantCredential`), and
 * only the person's own pages work (`personalCredential`).
 *
 * This only decides what the portal draws, which form it accepts and which
 * organization it asks for: the token is not verified here, and the gateway
 * and the service still decide every request.
 */

/**
 * The organization a new session is pinned to: the access token's active
 * organization (`org_id`) as the token names it, or null when it names none.
 * Read once, at sign-in. A malformed claim pins none, and a token that grants
 * nothing in the organization it names is pinned to it all the same — such a
 * session is refused by `sessionOrganization` and recovered, never acted for.
 */
export function pinnedOrganizationFor(accessToken: string): string | null {
  return tokenActiveOrganization(accessToken)?.organizationId ?? null;
}

/**
 * The one answer every consumer reads: the organization this session acts for
 * (null: pinned to none), or `undefined` when it cannot act at all — its token
 * no longer grants the pinned organization a role, or does not resolve.
 */
export function sessionOrganization(session: SessionTokens): string | null | undefined {
  const pinned = session.organizationId;
  if (pinned !== null) return tokenAuthority(session.accessToken, pinned) ? pinned : undefined;
  // Pinned to none: its requests carry no header, so the guard resolves the
  // token's own active organization and refuses all of them if that grants
  // nothing. Such a session is recovered rather than half-used.
  const active = tokenActiveOrganization(session.accessToken);
  if (!active) return undefined;
  return tokenAuthority(session.accessToken, active.organizationId) ? null : undefined;
}

/**
 * True when the session is pinned to an organization its (readable) token no
 * longer grants a role in — the membership or its roles were removed, or the
 * sign-in named one it held nothing in. What `/account/recovery` says in that
 * case; nothing else reads it.
 */
export function organizationLost(session: SessionTokens) {
  return session.organizationId !== null && sessionOrganization(session) === undefined;
}

/** Thrown where a session that `readSession()` would have refused reaches a consumer. */
export class UnresolvedSessionOrganization extends Error {
  constructor() {
    super('The session organization cannot be resolved from its access token.');
    this.name = 'UnresolvedSessionOrganization';
  }
}

/**
 * Thrown where a session pinned to no organization reaches something that
 * reads or writes a tenant's data. `tenant-gate.ts` keeps such a session away
 * from every tenant-bound route before it renders; this is the second wall, at
 * the gateway call itself, so a header-less request — which the guard would
 * answer for the token's active organization — is never sent.
 */
export class NoActingOrganization extends Error {
  constructor() {
    super('This session acts for no organization; nothing tenant-bound is sent for it.');
    this.name = 'NoActingOrganization';
  }
}

/**
 * The organization a page draws, filters and binds forms for. Every consumer
 * reads this, never the stored field (`session-organization.spec.ts`).
 * Throws rather than guessing for a session `readSession()` would have
 * refused: a page that draws nothing is the fail-closed answer.
 */
export function actingOrganizationId(session: WebSession): string | null {
  const organizationId = sessionOrganization(session);
  if (organizationId === undefined) throw new UnresolvedSessionOrganization();
  return organizationId;
}

/**
 * What the session's token grants **in the organization it acts for**: the
 * roles every screen draws from and every role check reads — never the token's
 * active organization's, which a switch made elsewhere moves (audit F2). Null
 * when the session cannot act.
 */
export function sessionAuthority(session: SessionTokens): TokenAuthority | null {
  const organizationId = sessionOrganization(session);
  if (organizationId === undefined) return null;
  return tokenAuthority(session.accessToken, organizationId);
}

/**
 * The roles every screen in this portal draws from ({@link sessionAuthority}).
 * Null when the session cannot act; a screen then offers nothing gated.
 */
export function sessionRoles(session: SessionTokens): readonly string[] | null {
  return sessionAuthority(session)?.roles ?? null;
}

/**
 * The roles a write form is offered on: {@link sessionRoles}, but only for a
 * session that acts for an organization. Every write the portal sends is
 * tenant-scoped — the service acts for the request's organization and cannot
 * act for none — so a session pinned to none, a platform administrator's
 * included, is offered no write form; the role rule itself is
 * `rolesGuardAdmits`.
 */
export function sessionWriteRoles(session: SessionTokens): readonly string[] | null {
  const authority = sessionAuthority(session);
  return authority?.organizationId ? authority.roles : null;
}

/**
 * The organization a cookie sealed before task 100 kept as its copy, when it
 * differs from the acting one: the one that build tagged and keyed this
 * login's unresolved submissions under (`session.ts`, `formerOrganizationId`).
 * For **recognising** those records as this person's, never for acting,
 * labelling or sending. `undefined`: none, or the same as the acting one.
 */
export function formerOrganizationCopy(session: WebSession): string | null | undefined {
  const former = session.formerOrganizationId;
  if (former === undefined) return undefined;
  return former === actingOrganizationId(session) ? undefined : former;
}

/** The top bar's label for it. */
export function actingOrganizationLabel(session: WebSession): string {
  return actingOrganizationId(session) ?? 'بدون سازمان فعال';
}

/**
 * A React key for a page's whole tree (`<AppShell key=…>`), so a change of
 * organization remounts everything on it: no state drawn for one organization
 * — a restored record, a picked member, an answer still in flight — survives
 * into the other's page, even where a refresh re-renders the same route.
 */
export function actingScope(session: WebSession): string {
  return `organization:${actingOrganizationId(session) ?? ''}`;
}

// ---------------------------------------------------------------------------
// What a gateway call is sent with
// ---------------------------------------------------------------------------

/**
 * The bearer and the organization one gateway call is sent for — the only
 * thing `callGateway` accepts. Minted here and nowhere else: `callGateway`
 * refuses an object this module did not mint (`credentialHeaders`), so no call
 * path can send a session's token without its pinned organization, and the
 * header is computed in one place.
 */
export interface GatewayCredential {
  readonly accessToken: string;
  /** Sent as `X-Organization-Id`; null sends none. */
  readonly organizationId: string | null;
}

const minted = new WeakSet<GatewayCredential>();

function mint(accessToken: string, organizationId: string | null): GatewayCredential {
  const credential: GatewayCredential = Object.freeze({ accessToken, organizationId });
  minted.add(credential);
  return credential;
}

/**
 * For every call that reads or writes a tenant's data — every call but the
 * person's own profile. Carries the session's organization; throws for a
 * session that acts for none (`NoActingOrganization`) or cannot act
 * (`UnresolvedSessionOrganization`), so nothing is sent that the guard could
 * answer for the token's active organization instead.
 */
export function tenantCredential(session: SessionTokens): GatewayCredential {
  const organizationId = sessionOrganization(session);
  if (organizationId === undefined) throw new UnresolvedSessionOrganization();
  if (organizationId === null) throw new NoActingOrganization();
  return mint(session.accessToken, organizationId);
}

/**
 * For the person's own record (`/v1/users/me`), which a session pinned to no
 * organization may read too. Still carries the session's organization when it
 * has one, so even this read is answered for the organization the page shows.
 */
export function personalCredential(session: SessionTokens): GatewayCredential {
  const organizationId = sessionOrganization(session);
  if (organizationId === undefined) throw new UnresolvedSessionOrganization();
  return mint(session.accessToken, organizationId);
}

/**
 * The two headers a credential becomes. Throws for one this module did not
 * mint: a literal `{ accessToken, organizationId }` built elsewhere is exactly
 * the bypass this boundary exists to close.
 */
export function credentialHeaders(credential: GatewayCredential): Record<string, string> {
  if (!minted.has(credential)) {
    throw new Error('A gateway call needs a credential from session-organization.ts.');
  }
  return {
    authorization: `Bearer ${credential.accessToken}`,
    ...(credential.organizationId === null
      ? {}
      : { 'x-organization-id': credential.organizationId }),
  };
}
