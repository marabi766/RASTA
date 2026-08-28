import { RastaError, getContext } from '@rasta/nest-common';

/**
 * Object-level authorization for maintenance.
 *
 * The `@Roles` guard answers "may this kind of user do this kind of thing".
 * It cannot answer "may they touch *this* record", because it never sees the
 * record. That second question is this file's job — docs/09 § 9.3 calls it the
 * most critical layer — and answering it here honestly requires stating what
 * this service can and cannot know.
 *
 * ## What the documented rule asks for, and why it cannot be enforced yet
 *
 * docs/09 § 9.3 grants `OPERATOR` the permission `maintenance:create`, limited
 * to "فقط دارایی تخصیص‌یافته" — only the machines assigned to them. That fact
 * lives in fleet-service, and it cannot be resolved here today:
 *
 *   - `ASSET_ASSIGNED` carries a `driverId`, not the operator's `userId`, so
 *     the assignment stream alone cannot be matched against a token.
 *   - Reconstructing the mapping would mean replicating `DRIVER_REGISTERED`
 *     as well and maintaining fleet's core state inside this service — a
 *     second representation of another service's data, which is the coupling
 *     docs/03 § 3.6 exists to prevent.
 *   - And it would fail in the direction that matters most. The replica is
 *     eventually consistent, so an operator handed a machine two seconds ago
 *     would be refused permission to report that it has just broken down.
 *     **Refusing a breakdown report because a replica is stale is worse than
 *     letting a colleague in the same organization file one.**
 *
 * ## The temporary decision, and it is deliberately the narrow one
 *
 * Until that fact is resolvable (docs/24 Q-24, ADR-029):
 *
 *   - an operator or driver may **report a breakdown** on a machine belonging
 *     to their own organization — never another's, which the tenant guard
 *     enforces independently of anything here;
 *   - they may **read only the requests they themselves reported**;
 *   - they may do nothing else: no workshop referral, no starting or
 *     completing a repair, no cost entry, and above all no approval, which is
 *     the control that authorises money to move.
 *
 * This is narrower than the role's documented scope in every direction except
 * the one that would suppress a safety report. When fleet-service exposes the
 * holder of a machine — or the assignment event carries the operator's user id
 * — the narrowing tightens to the documented rule, and only this file changes.
 *
 * ## Workshops
 *
 * `WORKSHOP` (docs/09: `repair-order:*`, only jobs referred to them) is
 * **deferred**, not stubbed. A workshop user belongs to a *supplier*
 * organization, so serving them means reading rows that belong to another
 * tenant — a cross-tenant access model this platform does not have and must
 * not acquire by accident. `workshopOrganizationId` is recorded on every
 * repair order so the portal can be built later without a data migration; in
 * the meantime a workshop role falls into the narrowing below and sees only
 * what it reported, which is nothing. Safe by default (ADR-029, docs/24 Q-25).
 *
 * The rule is expressed as a narrowing, not a widening. Written the other way
 * round — "grant access if the caller is a supervisor" — a role that is
 * neither supervisory nor an operator would fall through to full access, which
 * is the wrong default.
 */

/** Roles that see and manage the whole organization's maintenance. */
export const MAINTENANCE_SUPERVISOR_ROLES = [
  'SYSTEM_ADMIN',
  'UNION_ADMIN',
  'ORGANIZATION_ADMIN',
  'FLEET_MANAGER',
] as const;

/** Roles that operate machines and report what goes wrong with them. */
export const MAINTENANCE_REPORTER_ROLES = ['OPERATOR', 'DRIVER'] as const;

export function isMaintenanceSupervisor(roles: readonly string[]): boolean {
  return MAINTENANCE_SUPERVISOR_ROLES.some((role) => roles.includes(role));
}

/**
 * How the caller's view of maintenance is bounded.
 *
 * `SUPERVISOR` sees everything in the tenant. `REPORTER` sees only what they
 * reported — and a reporter who has reported nothing sees an empty list rather
 * than an error, because "you have filed no breakdowns" is a legitimate state.
 */
export type MaintenanceScope = { kind: 'SUPERVISOR' } | { kind: 'REPORTER'; userId: string };

export function currentMaintenanceScope(): MaintenanceScope {
  const context = getContext();

  // A service-to-service caller has already been authorized by AuthGuard
  // against `@AllowService`, which is a stricter question than role
  // membership. Narrowing it to records it never reported would break every
  // internal read.
  if (context.authType === 'SERVICE') return { kind: 'SUPERVISOR' };

  if (isMaintenanceSupervisor(context.roles)) return { kind: 'SUPERVISOR' };

  if (!context.userId) {
    throw RastaError.forbidden('This request has no user identity to scope maintenance data to');
  }

  return { kind: 'REPORTER', userId: context.userId };
}

/**
 * Refuses access to a record the caller may not see.
 *
 * Throws `notFound`, never `forbidden`: a 403 confirms the record exists, and
 * an operator probing identifiers could map their colleagues' repairs and what
 * they cost. The platform's non-disclosure rule is uniform (docs/09,
 * `RastaError.notFound`).
 */
export function assertOwnReport(
  scope: MaintenanceScope,
  reportedBy: string | null,
  resourceType: string,
  resourceId: string,
): void {
  if (scope.kind === 'SUPERVISOR') return;
  if (reportedBy && reportedBy === scope.userId) return;
  throw RastaError.notFound(resourceType, resourceId);
}
