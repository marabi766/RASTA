/**
 * The realm roles that are global, read from the session's access token.
 *
 * identity-service's `/v1/users/me` reports membership roles only, but every
 * backend service builds a request's roles as the membership's roles *plus*
 * the global realm roles (`rolesForRequest`, ADR-060 § 4 rule 3: today only
 * `SYSTEM_ADMIN`). So a person with the realm role and a narrow membership is
 * a `SYSTEM_ADMIN` to economic-service and construction-service. The portal
 * reads the same claim (`realm_access.roles`) so that the links it draws agree
 * with what the services allow.
 *
 * The token is **not verified here**: it came from the token endpoint over TLS
 * into the sealed session, and the result only chooses which links to *draw*.
 * The gateway and the services verify the token on every request and decide
 * access. Callers read it only after `/v1/users/me` succeeded.
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

/** The services' view of a request: the membership's roles plus the global realm roles. */
export function requestRoles(
  membershipRoles: readonly string[],
  accessToken: string,
): readonly string[] {
  return [...new Set([...membershipRoles, ...globalRealmRoles(accessToken)])];
}
