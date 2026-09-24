import { RastaError, getContext } from '@rasta/nest-common';

/**
 * Which organization a caller may provision a user into.
 *
 * `role-grants.ts` (Q-60) answers *which roles* may be handed out. This
 * answers the question next to it, which nothing answered: *whose
 * organization* may they be handed out in.
 *
 * ## What was possible
 *
 * `createUser` took `dto.organizationId` from the request body and used it
 * unchecked — into `keycloak.createUser`, which creates a real, enabled
 * account, and then into a membership row written through
 * `runUnscoped('membership provisioning targets a specified organization')`.
 * That reason is true of a platform operator and false of an
 * `ORGANIZATION_ADMIN`, and the endpoint's `@Roles` puts both on the same
 * path. So any organization administrator could name **any** organization on
 * the platform and provision a working account into it, with any role their
 * Q-60 ladder allows. `addMembership` had the same gap.
 *
 * It is the same shape as the escalation Q-60 closed, one axis over: that one
 * was *which roles*, this one is *whose tenant*. Neither was checked before
 * Q-60, and Q-60 did not check this one either.
 *
 * ## Three paths write a membership, not two
 *
 * `createUser`, `addMembership` and `approveRegistration` all reach
 * `createMembershipRow`. Restricting the first two alone would be theatre:
 * `submitRegistration` is `@Public`, so anyone — including an administrator,
 * unauthenticated — can file a request naming any organization, and approving
 * their own filing would walk straight around the restriction.
 *
 * ## Why the check runs before any lookup
 *
 * `addMembership` used to answer three ways for an organization the caller has
 * no business naming: `404` when no such user exists, `409` when the user is
 * already a member, and `201` otherwise. That is an oracle telling an outsider
 * whether a given person belongs to a given organization — and the `201`
 * branch is not a read, it *grants* the membership it was probing for.
 * Refusing on the tenant before anything is read closes it: every probe at
 * another organization now returns the same refusal, whatever exists behind
 * it.
 */

/**
 * The configured answer to "who may name somebody else's organization".
 *
 * A list, not a boolean, because the honest answer differs per role and the
 * product document does not give it (`docs/24` Q-61).
 */
export interface ProvisioningScopePolicy {
  readonly crossOrgRoles: readonly string[];
}

/**
 * Only the platform operator, by default.
 *
 * `docs/09` scopes `ORGANIZATION_ADMIN` to "همه در سازمان خود؛ مدیریت کاربران
 * سازمان" — *their own* organization — so excluding it is reading the table,
 * not a judgement call.
 *
 * `UNION_ADMIN` is the judgement call, and it is excluded on purpose. The
 * table calls it Platform-scoped, but "may provision a user into any
 * organization on the platform, including ones with no relationship to this
 * union" is a far wider claim than that phrase supports, and inventing it
 * would be inventing a business fact (CLAUDE.md § 9). The narrow reading is
 * the reversible one: a deployment that knows better sets
 * `USER_PROVISIONING_CROSS_ORG_ROLES` and gets the wider behaviour with no
 * release. The wide reading is not reversible — accounts it created stay
 * created.
 *
 * `SYSTEM_ADMIN` keeps the reach because it is the platform-operator role and
 * `apps/admin` does not exist yet (ADR-058 § 2); it is also the one role that
 * cannot be granted through this API at all (Q-60), so its holders are fixed
 * outside the platform rather than mintable from inside it.
 */
export const DEFAULT_PROVISIONING_SCOPE_POLICY: ProvisioningScopePolicy = {
  crossOrgRoles: ['SYSTEM_ADMIN'],
};

/** Injection token, declared here so the service need not import the module. */
export const PROVISIONING_SCOPE_POLICY = Symbol('PROVISIONING_SCOPE_POLICY');

/**
 * Refuses provisioning into an organization this caller has no authority over.
 *
 * Raised as `TENANT_MISMATCH` rather than a business rule or a bare `403`:
 * the platform already treats that code as the tenant-boundary signal worth
 * alerting on, and repeated occurrences here are exactly what probing looks
 * like. Its message names no organization, and the requested and permitted
 * ids go to `internalContext`, which the exception filter keeps out of the
 * response body (S-09) — so the refusal itself does not become the oracle it
 * was written to close.
 */
export function assertMayProvisionInto(
  organizationId: string,
  policy: ProvisioningScopePolicy,
): void {
  const context = getContext();

  if (context.authType !== 'USER') {
    throw RastaError.forbidden('Only a signed-in user may provision an account');
  }

  if (policy.crossOrgRoles.some((role) => context.roles.includes(role))) return;

  // Their *active* organization — the one this request acts for — not the set
  // they belong to. A caller who belongs to several chooses which one they are
  // acting as with `X-Organization-Id`, and that choice is what every other
  // tenant decision in the platform is measured against.
  if (context.organizationId === organizationId) return;

  throw RastaError.tenantMismatch(
    organizationId,
    context.organizationId ? [context.organizationId] : [],
  );
}
