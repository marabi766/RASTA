/**
 * Roles bound to the organization they were granted in (ADR-060).
 *
 * A token used to carry one flat list of realm roles, valid in every
 * organization the caller could name. An organization admin in A who was an
 * ordinary member of B was an admin in B too, because nothing tied the role to
 * the organization. The token now carries `org_roles`, one `ORG_ID:ROLE` pair
 * per role held in each membership, and a request's roles are those of the
 * organization it resolves to.
 *
 * Types and pure functions only (A-03): what a claim means, not what a service
 * does with it.
 */

/**
 * Every role the platform grants.
 *
 * The same list identity-service validates grants against
 * (`identity-service/src/identity/dto.ts`). It is repeated here because
 * services share no source (A-02), and the guard must refuse any pair naming
 * a role outside it rather than read it.
 */
export const PLATFORM_ROLES = [
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
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/**
 * The roles valid in **every** organization: `SYSTEM_ADMIN`, and nothing else
 * (ADR-060 § 2, `docs/24` Q-63).
 *
 * A constant, not configuration, on purpose. This is the trust model rather
 * than a business setting: two services reading two different lists would
 * make one role global in one of them and not in the other, and that drift
 * would itself be the hole. Changing it is a code change in this one place.
 */
export const GLOBAL_ROLES: readonly PlatformRole[] = ['SYSTEM_ADMIN'];

const KNOWN_ROLES: ReadonlySet<string> = new Set(PLATFORM_ROLES);

/** An organization id as identity-service writes it: no `:`, nothing blank. */
const ORGANIZATION_ID = /^[A-Za-z0-9_-]+$/;

export interface ParsedOrganizationRoles {
  /** Roles held, per organization id. */
  readonly byOrganization: ReadonlyMap<string, readonly string[]>;
  /** Values refused as malformed. Counted, never read "as far as possible". */
  readonly dropped: number;
}

/**
 * Reads the `org_roles` claim strictly.
 *
 * A value is kept only if it is exactly `ORG_ID:ROLE`: one `:`, an
 * organization id in the platform's alphabet, and a role from
 * {@link PLATFORM_ROLES}. Anything else is dropped and counted. A lenient
 * reader that took `A:B:ADMIN` as organization `A:B`, or trimmed a padded
 * role, would be deciding authority from a value nobody wrote.
 */
export function parseOrganizationRoles(values: readonly unknown[]): ParsedOrganizationRoles {
  const byOrganization = new Map<string, string[]>();
  let dropped = 0;

  for (const value of values) {
    const parts = typeof value === 'string' ? value.split(':') : [];
    const [organizationId, role] = parts;
    if (
      parts.length !== 2 ||
      !organizationId ||
      !role ||
      !ORGANIZATION_ID.test(organizationId) ||
      !KNOWN_ROLES.has(role)
    ) {
      dropped += 1;
      continue;
    }
    const held = byOrganization.get(organizationId) ?? [];
    if (!held.includes(role)) held.push(role);
    byOrganization.set(organizationId, held);
  }

  return { byOrganization, dropped };
}

/**
 * A request's roles: the membership's roles in the resolved organization,
 * plus the realm roles that are global (ADR-060 § 4, rule 3).
 *
 * Every other realm role is ignored. With no organization resolved, only the
 * global roles remain, and every tenant-scoped handler refuses as it always
 * has.
 */
export function rolesForRequest(
  resolvedOrganizationId: string | undefined,
  organizationRoles: ParsedOrganizationRoles,
  realmRoles: readonly string[],
): string[] {
  const granted = resolvedOrganizationId
    ? (organizationRoles.byOrganization.get(resolvedOrganizationId) ?? [])
    : [];
  const global = realmRoles.filter((role) => GLOBAL_ROLES.includes(role as PlatformRole));
  return [...new Set([...granted, ...global])];
}
