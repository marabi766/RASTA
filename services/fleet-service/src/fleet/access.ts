import { RastaError, getContext } from '@rasta/nest-common';

/**
 * Object-level authorization for fleet.
 *
 * The `@Roles` guard answers "may this kind of user do this kind of thing".
 * It cannot answer "may they touch *this* record", because it never sees the
 * record. That second question is this file's job, and the product document
 * asks it explicitly: `DRIVER` and `OPERATOR` see only the assets assigned to
 * them (docs/02 § 2.3, docs/04 § 4.6).
 *
 * The rule is expressed as a narrowing, not a widening: a caller who holds a
 * supervisory role sees the whole organization's fleet, and everyone else is
 * narrowed to their own driver record. Written the other way round — "grant
 * access if the caller is a supervisor" — a role that is neither supervisory
 * nor a driver would fall through to full access, which is the wrong default.
 */

/** Roles that see and manage the whole organization's fleet. */
export const FLEET_SUPERVISOR_ROLES = [
  'SYSTEM_ADMIN',
  'UNION_ADMIN',
  'ORGANIZATION_ADMIN',
  'FLEET_MANAGER',
] as const;

/** Roles that operate machines and record what they did with them. */
export const FLEET_OPERATOR_ROLES = ['OPERATOR', 'DRIVER'] as const;

export function isFleetSupervisor(roles: readonly string[]): boolean {
  return FLEET_SUPERVISOR_ROLES.some((role) => roles.includes(role));
}

/**
 * How the caller's view of the fleet is bounded.
 *
 * `SUPERVISOR` sees everything in the tenant. `SELF` sees only rows tied to
 * their own driver record — and if they have no driver record, that is an
 * empty set rather than an error, because "you are not a driver here" is a
 * legitimate state, not a failure.
 */
export type FleetScope = { kind: 'SUPERVISOR' } | { kind: 'SELF'; userId: string };

export function currentFleetScope(): FleetScope {
  const context = getContext();

  // A service-to-service caller has already been authorized by AuthGuard
  // against `@AllowService`, which is a stricter question than role
  // membership. Narrowing it to a driver record it does not have would break
  // every internal read.
  if (context.authType === 'SERVICE') return { kind: 'SUPERVISOR' };

  if (isFleetSupervisor(context.roles)) return { kind: 'SUPERVISOR' };

  if (!context.userId) {
    throw RastaError.forbidden('This request has no user identity to scope fleet data to');
  }

  return { kind: 'SELF', userId: context.userId };
}

/**
 * Refuses access to a record the caller may not see.
 *
 * Throws `notFound`, never `forbidden`: a 403 confirms the record exists, and
 * an operator probing identifiers could map their colleagues' assignments.
 * The platform's non-disclosure rule is uniform (docs/09, `RastaError.notFound`).
 */
export function assertOwnDriverRecord(
  scope: FleetScope,
  driver: { id: string; userId: string } | null,
  resourceType: string,
  resourceId: string,
): void {
  if (scope.kind === 'SUPERVISOR') return;
  if (driver && driver.userId === scope.userId) return;
  throw RastaError.notFound(resourceType, resourceId);
}
