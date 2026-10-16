/**
 * The realm roles that are global, read from the session's access token.
 *
 * identity-service's `/v1/users/me` reports membership roles only, but every
 * backend service builds a request's roles as the membership's roles *plus*
 * the global realm roles (`rolesForRequest`, ADR-060 § 4 rule 3: today only
 * `SYSTEM_ADMIN`). So a person with the realm role and a membership holding
 * only `CONTRACTOR` is a `SYSTEM_ADMIN` to construction-service. The portal
 * reads the same claim (`realm_access.roles`) so that what it draws and which
 * door it knocks on agree with the service.
 *
 * The token is **not verified here**: it came from the token endpoint over TLS
 * into the sealed session, and the result only chooses what to *draw*. The
 * gateway and the service verify the token on every request and decide access.
 */

/** Mirrors `GLOBAL_ROLES` in `packages/nest-common` (`auth/tenant-roles.ts`). */
const GLOBAL_REALM_ROLES: readonly string[] = ['SYSTEM_ADMIN'];

export function globalRealmRoles(accessToken: string): string[] {
  const payload = accessToken.split('.')[1];
  if (!payload) return [];
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const realmAccess =
      claims && typeof claims === 'object'
        ? (claims as Record<string, unknown>)['realm_access']
        : undefined;
    const roles =
      realmAccess && typeof realmAccess === 'object'
        ? (realmAccess as { roles?: unknown }).roles
        : undefined;
    if (!Array.isArray(roles)) return [];
    return [...new Set(roles.filter((r): r is string => GLOBAL_REALM_ROLES.includes(r)))];
  } catch {
    return [];
  }
}

/** The service's view of a request: the membership's roles plus the global realm roles. */
export function requestRoles(
  membershipRoles: readonly string[],
  accessToken: string,
): readonly string[] {
  return [...new Set([...membershipRoles, ...globalRealmRoles(accessToken)])];
}

/** Mirrors `PLATFORM_ROLES` in `packages/nest-common` (`auth/tenant-roles.ts`): a pair naming any other role is refused. */
const KNOWN_ROLES: ReadonlySet<string> = new Set([
  'SYSTEM_ADMIN',
  'UNION_ADMIN',
  'ORGANIZATION_ADMIN',
  'FLEET_MANAGER',
  'DRIVER',
  'OPERATOR',
  'PROCUREMENT_USER',
  'SUPPLIER',
  'WORKSHOP',
  'CONTRACTOR',
  'AUDITOR',
]);

/** Mirrors the guard's organization id alphabet: no `:`, nothing blank. */
const ORGANIZATION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * What a backend service will act on for a request carrying this access token:
 * the organization it resolves to and the roles it holds there.
 *
 * The portal sends no `X-Organization-Id`, so the guard resolves the token's
 * own `org_id`; the roles are that organization's `org_roles` pairs (read as
 * strictly as `parseOrganizationRoles` does: exactly `ORG_ID:ROLE`, a known
 * role, anything else ignored) plus the global realm roles — `rolesForRequest`.
 *
 * **Why the token and not `/v1/users/me`.** identity-service reports the
 * membership rows *now*; the service decides on the claims the token was
 * minted with. Until the token is refreshed the two disagree — a role removed
 * still works, a role added is still refused — and a form drawn from the rows
 * would be hidden from someone the service accepts, or shown to someone it
 * refuses (PR 319 review 1, finding 1). Drawing from the token keeps what is
 * drawn and what is decided the same thing.
 *
 * With no `org_id` the request resolves to no organization and only the
 * global realm roles remain, as in the guard. Null when the token cannot be
 * read, or names an organization it is not a member of (`org_ids`) or holds no
 * role in — the guard answers both `TENANT_MISMATCH`. Not verified
 * here — the result only chooses what to draw; the gateway and the service
 * verify the token on every request.
 */
export interface TokenAuthority {
  readonly organizationId: string | null;
  readonly roles: readonly string[];
}

export function tokenAuthority(accessToken: string): TokenAuthority | null {
  const payload = accessToken.split('.')[1];
  if (!payload) return null;
  let claims: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    claims = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const organizationId = claims['org_id'];
  if (organizationId === undefined) {
    return { organizationId: null, roles: globalRealmRoles(accessToken) };
  }
  if (typeof organizationId !== 'string' || !ORGANIZATION_ID.test(organizationId)) return null;
  const memberships = Array.isArray(claims['org_ids']) ? (claims['org_ids'] as unknown[]) : [];
  if (!memberships.includes(organizationId)) return null;

  const pairs = Array.isArray(claims['org_roles']) ? (claims['org_roles'] as unknown[]) : [];
  const granted: string[] = [];
  let member = false;
  for (const value of pairs) {
    const parts = typeof value === 'string' ? value.split(':') : [];
    const [organization, role] = parts;
    if (parts.length !== 2 || !organization || !role || !ORGANIZATION_ID.test(organization)) {
      continue;
    }
    if (!KNOWN_ROLES.has(role) || organization !== organizationId) continue;
    member = true;
    if (!granted.includes(role)) granted.push(role);
  }
  // The guard refuses a request whose organization the token grants nothing in.
  if (!member) return null;

  return {
    organizationId,
    roles: [...new Set([...granted, ...globalRealmRoles(accessToken)])],
  };
}
