/**
 * The Keycloak user attributes this service owns, and how they are derived
 * (ADR-060 § 5).
 *
 * Each becomes a token claim through a protocol mapper in the realm:
 *
 *   rasta_user_id          -> rasta_uid   the platform user id
 *   organization_ids       -> org_ids     every organization the user belongs to
 *   organization_roles     -> org_roles   `ORG_ID:ROLE`, one per role per membership
 *   active_organization_id -> org_id      the organization requests act for by default
 *
 * The realm declares all four as managed, admin-only attributes
 * (`rasta-realm.json`, user profile): Keycloak 26 silently drops an attribute
 * written through the Admin API that its user profile does not declare, and a
 * user must never be able to read or write these from the account console —
 * `organization_roles` is what authorization is built from.
 *
 * **Always all four, always from the database.** Keycloak's admin `PUT
 * /users/:id` replaces the attribute map *and* clears top-level fields the body
 * leaves out (verified on 26.0: a body carrying only `attributes` erased the
 * user's email and first name). So there is no such thing as updating one of
 * these; there is only rebuilding the set and writing the whole
 * representation back.
 */

export const PLATFORM_ATTRIBUTE_NAMES = [
  'rasta_user_id',
  'organization_ids',
  'organization_roles',
  'active_organization_id',
] as const;

export type PlatformAttributeName = (typeof PLATFORM_ATTRIBUTE_NAMES)[number];

export type PlatformAttributes = Record<PlatformAttributeName, string[]>;

export interface ProjectableUser {
  id: string;
  activeOrganizationId: string | null;
}

export interface ProjectableMembership {
  organizationId: string;
  roles: readonly string[];
  status: string;
  validUntil: Date | null;
}

/** One `organization_roles` value. Neither an organization id nor a role name contains `:`. */
export function organizationRole(organizationId: string, role: string): string {
  return `${organizationId}:${role}`;
}

/**
 * The attributes a user should carry, derived from their rows alone.
 *
 * A membership counts only while it is `ACTIVE` and not past its
 * `validUntil`: an expired membership grants nothing in the database's own
 * terms, so it must not grant anything in the token either. An active
 * organization the user no longer belongs to is dropped rather than kept —
 * the guard would otherwise be handed an organization with no roles in it.
 *
 * Sorted, so that the same rows always produce the same attributes and a
 * reconcile can compare them without caring about order.
 */
export function platformAttributesFor(
  user: ProjectableUser,
  memberships: readonly ProjectableMembership[],
  now: Date,
): PlatformAttributes {
  const live = memberships.filter(
    (membership) =>
      membership.status === 'ACTIVE' &&
      (membership.validUntil === null || membership.validUntil > now),
  );

  const organizationIds = [...new Set(live.map((membership) => membership.organizationId))].sort();
  const organizationRoles = [
    ...new Set(
      live.flatMap((membership) =>
        membership.roles.map((role) => organizationRole(membership.organizationId, role)),
      ),
    ),
  ].sort();

  const active =
    user.activeOrganizationId && organizationIds.includes(user.activeOrganizationId)
      ? [user.activeOrganizationId]
      : [];

  return {
    rasta_user_id: [user.id],
    organization_ids: organizationIds,
    organization_roles: organizationRoles,
    active_organization_id: active,
  };
}

/** The platform attributes as Keycloak holds them, missing ones read as empty. */
export function readPlatformAttributes(
  attributes: Record<string, string[] | undefined> | undefined,
): PlatformAttributes {
  const read = (name: PlatformAttributeName) => [...(attributes?.[name] ?? [])].sort();
  return {
    rasta_user_id: read('rasta_user_id'),
    organization_ids: read('organization_ids'),
    organization_roles: read('organization_roles'),
    active_organization_id: read('active_organization_id'),
  };
}

/** Which platform attributes differ between what Keycloak holds and what it should. */
export function divergentAttributes(
  actual: PlatformAttributes,
  expected: PlatformAttributes,
): PlatformAttributeName[] {
  return PLATFORM_ATTRIBUTE_NAMES.filter(
    (name) => JSON.stringify([...actual[name]].sort()) !== JSON.stringify(expected[name]),
  );
}
