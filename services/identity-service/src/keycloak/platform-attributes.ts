import { isMembershipLive, type MembershipWindow } from '../identity/membership-window';

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

export interface ProjectableMembership extends MembershipWindow {
  organizationId: string;
  roles: readonly string[];
}

/** One `organization_roles` value. Neither an organization id nor a role name contains `:`. */
export function organizationRole(organizationId: string, role: string): string {
  return `${organizationId}:${role}`;
}

/**
 * The attributes a user should carry, derived from their rows alone.
 *
 * A membership counts only while it is live (`membership-window.ts`):
 * `ACTIVE`, and `now` inside `[validFrom, validUntil)`. An expired membership
 * grants nothing in the database's own terms, so it must not grant anything in
 * the token either. An active
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
  const live = memberships.filter((membership) => isMembershipLive(membership, now));

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

/**
 * What a narrowing change writes to Keycloak **before** it commits (ADR-060,
 * write-ahead addendum, D-064): each attribute keeps only the values it holds
 * both before and after the change.
 *
 * Never wider than either side, so it is safe whichever way the transaction
 * ends: committed, Keycloak is at most what the rows now grant, and the
 * projection after commit writes `after` in full; rolled back, it is at most
 * what they granted all along. A removed role, a revoked or lapsed
 * organization and an active organization that moves are all absent from it;
 * a role added in the same change waits for the projection after commit.
 * Every other organization of the user — their roles there, and an active
 * organization that does not move — is in both, and is written unchanged.
 */
export function intersectAttributes(
  before: PlatformAttributes,
  after: PlatformAttributes,
): PlatformAttributes {
  const both = (name: PlatformAttributeName) =>
    before[name].filter((value) => after[name].includes(value));
  return {
    rasta_user_id: both('rasta_user_id'),
    organization_ids: both('organization_ids'),
    organization_roles: both('organization_roles'),
    active_organization_id: both('active_organization_id'),
  };
}

/** Whether `narrower` holds no value `wider` does not, in any of the four attributes. */
export function isWithin(narrower: PlatformAttributes, wider: PlatformAttributes): boolean {
  return PLATFORM_ATTRIBUTE_NAMES.every((name) =>
    narrower[name].every((value) => wider[name].includes(value)),
  );
}

/**
 * The attributes of an account no decision has granted anything yet: its
 * provenance alone. What a registration approval creates its account with,
 * and what the orphan repair leaves one with (#219 r2).
 */
export function provenanceOnly(userId: string): PlatformAttributes {
  return {
    rasta_user_id: [userId],
    organization_ids: [],
    organization_roles: [],
    active_organization_id: [],
  };
}

/** Whether an account's attributes grant anything: an organization, a role or an active organization. */
export function grantsAnything(attributes: PlatformAttributes): boolean {
  return (
    attributes.organization_ids.length +
      attributes.organization_roles.length +
      attributes.active_organization_id.length >
    0
  );
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
