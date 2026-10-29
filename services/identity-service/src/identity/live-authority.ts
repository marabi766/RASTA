import {
  GLOBAL_ROLES,
  RastaError,
  RolesGuard,
  getContext,
  type PlatformRole,
} from '@rasta/nest-common';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import type { IdentityRepository } from './identity.repository';

/**
 * The caller's authority to administer identity, read from the database at the
 * moment the decision commits (task 117, audit F1).
 *
 * ## Why the token is not enough here
 *
 * Every guard on the platform authorizes from the verified token, and a token
 * outlives a demotion by up to 905 s (ADR-060 § 7) — a window accepted because
 * it closes on its own. On identity's own administration routes it does not:
 * a demoted `ORGANIZATION_ADMIN` still holding the old token could
 * `POST /v1/memberships/<own>/roles` with `ORGANIZATION_ADMIN` again, the
 * ladder measured the token and agreed, and the role was back — permanently,
 * because nothing would ever take it away a second time. The re-read of the
 * **target** membership under its lock did not help: it asked whether the
 * caller may manage the target's roles, and answered from the caller's token.
 *
 * So every identity-administration write decides on the caller's **live**
 * membership in the organization they act for: read inside the write's own
 * transaction, after its user locks, on the database's clock, with the same
 * live predicate every other decision uses (`liveMembershipWhere`). The
 * token's roles remain the early refusal before any lock — a caller the token
 * already refuses learns nothing more — and are never the reason a write
 * commits.
 *
 * The gateway revocation list (EXT-005, PR #381) shrinks the token window to
 * the Kafka lag; it does not close this: a re-grant made inside that lag would
 * still be permanent. This check is needed either way.
 *
 * ## `SYSTEM_ADMIN`
 *
 * Not membership data. It is a Keycloak realm role, assigned outside the
 * platform and grantable by nobody through this API (ADR-060 § 2, Q-63), so
 * the database has nothing to re-read: its authority stays the token's, and a
 * realm role removed in Keycloak keeps working until the token expires — the
 * residual window #381 narrows. The live roles therefore are the live
 * membership's roles plus the token's global roles (`GLOBAL_ROLES`), exactly
 * the union a request's roles are built from (ADR-060 § 4).
 *
 * ## Who is checked
 *
 * A `USER` only. A service token never administers identity (`role-grants.ts`
 * refuses it), and the membership-expiry sweep runs as the system
 * (`createSystemContext`, `authType: 'SERVICE'`) and calls none of the paths
 * this guards: exempt by its type, not by a role name.
 */

/** Who may manage memberships: the `@Roles` of the membership and provisioning routes. */
export const MEMBERSHIP_ADMIN_ROLES = ['ORGANIZATION_ADMIN', 'UNION_ADMIN'] as const;

/** Who may decide a registration: the `@Roles` of approve and reject. */
export const REGISTRATION_REVIEW_ROLES = ['UNION_ADMIN'] as const;

/**
 * Who may edit another person's profile. `SYSTEM_ADMIN` is listed for
 * clarity; it satisfies every role check here, as it does in `RolesGuard`.
 */
export const PROFILE_ADMIN_ROLES = ['ORGANIZATION_ADMIN', 'SYSTEM_ADMIN'] as const;

/**
 * The caller's live roles in the organization they act for, refused unless
 * they include one of `required` (or `SYSTEM_ADMIN`, as `RolesGuard` reads it).
 *
 * Call it inside the write's transaction, after its locks — the caller's own
 * user row among them (`IdentityRepository.lockUsersInOrder`) — with `now` the
 * database's clock read after those locks. Fails closed: no acting
 * organization, no live membership there (none, suspended, revoked, expired,
 * not yet valid), or a user who is not `ACTIVE` leaves only the global roles,
 * and without one the answer is the same `403 INSUFFICIENT_ROLE` the ladder
 * gives — nothing tells the caller which of those it was.
 */
export async function liveAuthority(
  repository: IdentityRepository,
  tx: ExtendedPrismaClient,
  now: Date,
  required: readonly string[],
): Promise<readonly string[]> {
  const context = getContext();
  if (context.authType !== 'USER' || !context.userId) {
    throw RastaError.forbidden('Only a signed-in user may administer identity');
  }

  const global = context.roles.filter((role) => GLOBAL_ROLES.includes(role as PlatformRole));
  const held = context.organizationId
    ? await repository.findLiveRoles(tx, context.userId, context.organizationId, now)
    : null;
  const roles = [...new Set([...(held ?? []), ...global])];

  if (!roles.includes(RolesGuard.SUPER_ROLE) && !required.some((role) => roles.includes(role))) {
    throw RastaError.insufficientRole(required, roles);
  }
  return roles;
}
