import { RastaError, RolesGuard, getContext } from '@rasta/nest-common';
import { PLATFORM_ROLES, type PlatformRole } from './dto';

/**
 * Which roles a caller may grant to somebody else.
 *
 * `@Roles('ORGANIZATION_ADMIN', 'UNION_ADMIN')` on the membership endpoints
 * answers *may this kind of user change roles at all*. It has never answered
 * *which roles may they hand out*, and until this file existed nothing did:
 * `updateMembershipRoles` wrote the requested array straight onto the row, and
 * `roleSchema` accepts every one of the eleven platform roles. An
 * `ORGANIZATION_ADMIN` could therefore grant `SYSTEM_ADMIN` — to a colleague
 * or, since their own membership is inside their own tenant, to themselves —
 * and `RolesGuard.SUPER_ROLE` honours that role everywhere on the platform.
 * One request, from any organization administrator, to the whole estate.
 *
 * Four endpoints write a role set, not one, and each carried the hole on its
 * own: `createUser`, `addMembership`, `updateMembershipRoles` and
 * `approveRegistration`. The fourth is the quietest of them.
 * `submitRegistration` is `@Public` — deliberately, an applicant has no
 * account yet — and stores the `requestedRoles` the applicant chose;
 * `approveRegistration` then grants `dto.roles ?? request.requestedRoles`. So
 * an anonymous stranger could file a request naming `SYSTEM_ADMIN` and wait
 * for a reviewer to click approve. Nothing about that screen would have
 * suggested the click was handing over the platform. A control applied to
 * three of four entry points is a control with one way around it.
 *
 * ## This is a documented control, not a new policy
 *
 * `docs/09-security-architecture.md` already asks for it twice:
 *
 *  - The RBAC table gives every role a **scope**. `SYSTEM_ADMIN` and
 *    `UNION_ADMIN` are `Platform`. `ORGANIZATION_ADMIN` is `Organization` —
 *    "همه در سازمان خود؛ مدیریت کاربران سازمان". `SUPPLIER`, `WORKSHOP` and
 *    `CONTRACTOR` are `Supplier Org`; `AUDITOR` is `Province`. An
 *    organization-scoped role managing its organization's users cannot also
 *    mean handing out platform-scoped ones.
 *  - Threat **I2** — "ارتقای سطح دسترسی با دستکاری نقش", impact High — lists
 *    the control as "تخصیص نقش فقط توسط `ORGANIZATION_ADMIN`+ · هر تغییر در
 *    Audit · تست مجوزدهی". The first clause was implemented as the route
 *    guard, the second as `ROLE_ASSIGNED`/`ROLE_REVOKED`, and the third —
 *    the authorization test — was never written. This file and its spec are
 *    the missing half.
 *
 * ## The ladder, and what is configurable about it
 *
 * The exclusions below follow the scope column and are not a judgement call:
 * an organization-scoped actor may not grant a platform-, province- or
 * supplier-scoped role. What the product document genuinely does not answer —
 * whether an administrator may promote a peer to their own role, and who
 * hands out the supplier-organization roles — is recorded as **docs/24 Q-60**
 * with a narrow temporary default, and both live in configuration so the
 * answer arrives as a deployment value rather than a patch.
 *
 * `SYSTEM_ADMIN` is grantable by nobody through this API. It is the
 * platform-operator role, the console that would justify handing it out does
 * not exist yet (`apps/admin`, ADR-058 § 2), and a role nobody can grant
 * through the API is one an attacker cannot reach through it either.
 */

/** The scope column of `docs/09` § RBAC, as data. */
export const ROLE_SCOPES = {
  SYSTEM_ADMIN: 'PLATFORM',
  UNION_ADMIN: 'PLATFORM',
  ORGANIZATION_ADMIN: 'ORGANIZATION',
  FLEET_MANAGER: 'ORGANIZATION',
  DRIVER: 'ORGANIZATION',
  OPERATOR: 'ORGANIZATION',
  PROCUREMENT_USER: 'ORGANIZATION',
  SUPPLIER: 'SUPPLIER_ORG',
  WORKSHOP: 'SUPPLIER_ORG',
  CONTRACTOR: 'SUPPLIER_ORG',
  AUDITOR: 'PROVINCE',
} as const satisfies Record<PlatformRole, string>;

export type RoleScope = (typeof ROLE_SCOPES)[PlatformRole];

/** Never grantable through this API, whoever is asking. */
export const UNGRANTABLE_ROLES: readonly PlatformRole[] = ['SYSTEM_ADMIN'];

/**
 * What each acting role may grant, by default.
 *
 * Defaults, not constants: `identityEnvSchema` reads each one from the
 * environment, so a deployment can answer Q-60 differently without a release.
 */
export const DEFAULT_GRANTS = {
  /** Everything the API allows at all — the platform operator, minus the role
   *  nobody may grant. */
  SYSTEM_ADMIN: PLATFORM_ROLES.filter((role) => !UNGRANTABLE_ROLES.includes(role)),
  /** Platform scope: may grant its own role and every organization role.
   *  Supplier-organization roles are excluded by default (Q-60). */
  UNION_ADMIN: [
    'UNION_ADMIN',
    'ORGANIZATION_ADMIN',
    'FLEET_MANAGER',
    'DRIVER',
    'OPERATOR',
    'PROCUREMENT_USER',
  ],
  /** Organization scope: the roles of its own organization, its own included
   *  (Q-60 — "مدیریت کاربران سازمان" read as covering a peer administrator). */
  ORGANIZATION_ADMIN: [
    'ORGANIZATION_ADMIN',
    'FLEET_MANAGER',
    'DRIVER',
    'OPERATOR',
    'PROCUREMENT_USER',
  ],
} as const satisfies Record<string, readonly PlatformRole[]>;

/** The configured ladder, as the service holds it. */
export interface RoleGrantPolicy {
  readonly bySystemAdmin: readonly PlatformRole[];
  readonly byUnionAdmin: readonly PlatformRole[];
  readonly byOrganizationAdmin: readonly PlatformRole[];
}

/**
 * Injection token for the configured ladder.
 *
 * Declared beside the policy rather than in `app.module.ts` so the service can
 * import it without importing the module that provides it.
 */
export const ROLE_GRANT_POLICY = Symbol('ROLE_GRANT_POLICY');

export const DEFAULT_ROLE_GRANT_POLICY: RoleGrantPolicy = {
  bySystemAdmin: DEFAULT_GRANTS.SYSTEM_ADMIN,
  byUnionAdmin: DEFAULT_GRANTS.UNION_ADMIN,
  byOrganizationAdmin: DEFAULT_GRANTS.ORGANIZATION_ADMIN,
};

/**
 * The roles this caller may grant.
 *
 * A union across the acting roles they hold, because somebody may hold two —
 * and the widest of the two is what they can already do by other means. The
 * union is then intersected with what the API allows at all, so a
 * configuration that names `SYSTEM_ADMIN` cannot reintroduce it.
 */
export function grantableRoles(
  actorRoles: readonly string[],
  policy: RoleGrantPolicy,
): readonly PlatformRole[] {
  const granted = new Set<PlatformRole>();

  if (actorRoles.includes(RolesGuard.SUPER_ROLE)) {
    for (const role of policy.bySystemAdmin) granted.add(role);
  }
  if (actorRoles.includes('UNION_ADMIN')) {
    for (const role of policy.byUnionAdmin) granted.add(role);
  }
  if (actorRoles.includes('ORGANIZATION_ADMIN')) {
    for (const role of policy.byOrganizationAdmin) granted.add(role);
  }

  for (const role of UNGRANTABLE_ROLES) granted.delete(role);

  return PLATFORM_ROLES.filter((role) => granted.has(role));
}

/**
 * Refuses a grant the caller may not make.
 *
 * Checked before the row is read or written, on every path that sets roles:
 * creating a user, adding a membership, replacing a membership's roles, and
 * approving a registration.
 *
 * The **whole** resulting set is checked, not the roles being added to it. A
 * delta check would pass any request that merely keeps a role already on the
 * row, which is how "grant nothing, just re-send what is there" becomes a way
 * to launder a role the caller could not have granted in the first place.
 *
 * A service token is refused outright rather than granted the union of
 * everything: no service calls these endpoints today, and a machine that
 * needs to hand out roles later should say which ones in its own decision,
 * not inherit the widest set by accident.
 */
export function assertMayGrantRoles(
  requested: readonly PlatformRole[],
  policy: RoleGrantPolicy,
): void {
  assertWithinLadder(requested, policy, 'Only a signed-in user may grant roles');
}

/**
 * Refuses a change to a membership that already holds a role above the caller.
 *
 * The grant ladder alone stops an `ORGANIZATION_ADMIN` from *promoting*
 * anybody. It does not stop them from reaching the other way: replacing a
 * platform operator's role set with `['DRIVER']`, or revoking the membership
 * outright. Neither escalates the caller, so neither is threat I2 — but an
 * organization-scoped administrator who can demote or evict the platform
 * operator from their own tenant can lock the operator out of the organization
 * whose records the operator is there to oversee. `docs/09` scopes
 * `ORGANIZATION_ADMIN` to "مدیریت کاربران سازمان"; a platform-scoped
 * membership is not one of their organization's users in that sense.
 *
 * So the rule is symmetric, which is also the easier one to reason about: you
 * may only administer a membership whose roles you could have granted. It is
 * a **temporary decision** under `docs/24` Q-60 and moves with the same
 * configuration as the ladder itself — widen `ROLE_GRANTS_BY_*` and the reach
 * widens with it.
 */
export function assertMayManageMembershipRoles(
  current: readonly string[],
  policy: RoleGrantPolicy,
): void {
  assertWithinLadder(
    current as readonly PlatformRole[],
    policy,
    'Only a signed-in user may change a membership',
  );
}

/**
 * Refuses a role nobody can ever be granted, at the point it is asked for.
 *
 * `submitRegistration` is unauthenticated, so there is no caller to measure a
 * ladder against — but `UNGRANTABLE_ROLES` does not depend on who is asking.
 * A request naming one of them can never be approved, so accepting it would
 * only store an attacker-chosen platform role and put it in front of a
 * reviewer as something that looks like a legitimate ask. Refusing at the door
 * keeps the bait off the review queue; `approveRegistration` still applies the
 * full ladder, because that is where the grant actually happens.
 */
export function assertRolesMayBeRequested(requested: readonly PlatformRole[]): void {
  const refused = requested.filter((role) => UNGRANTABLE_ROLES.includes(role));
  if (refused.length === 0) return;

  throw RastaError.forbidden('One of the requested roles cannot be requested through registration');
}

/**
 * `insufficientRole` rather than a business rule: this is an authorization
 * decision, and the platform reports those with one code so a client — and an
 * audit reader — can tell a refusal from a validation failure. The refused
 * names go to `internalContext`, which the exception filter keeps out of the
 * response body (S-09).
 */
function assertWithinLadder(
  roles: readonly PlatformRole[],
  policy: RoleGrantPolicy,
  serviceTokenMessage: string,
): void {
  const context = getContext();

  if (context.authType !== 'USER') {
    throw RastaError.forbidden(serviceTokenMessage);
  }

  const allowed = grantableRoles(context.roles, policy);
  const refused = roles.filter((role) => !allowed.includes(role));
  if (refused.length === 0) return;

  throw RastaError.insufficientRole(refused, context.roles);
}
