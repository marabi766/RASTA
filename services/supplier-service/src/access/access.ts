import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';

/**
 * Object-level authorization for supplier-service (AGENTS.md S-03, BOLA).
 *
 * `@Roles` answers "may this kind of user do this kind of thing". It never sees
 * the record, so it cannot answer "may they touch *this* supplier" — and in a
 * service whose whole purpose is one party deciding about another, that second
 * question is the security model.
 *
 * ## The separation this file exists to enforce
 *
 * Two populations act on a supplier profile and they must never overlap on one
 * row:
 *
 *   the supplier side    SUPPLIER, WORKSHOP, CONTRACTOR, ORGANIZATION_ADMIN.
 *                        Registers and maintains **its own organization's**
 *                        profile, and submits qualifications for it.
 *   the platform side    SYSTEM_ADMIN, UNION_ADMIN. Reviews submissions and
 *                        decides them, suspends and reinstates.
 *
 * A supplier organization must never approve, reject, suspend or reinstate
 * itself. That is {@link assertNotDecidingOwnCase}, and it is applied **after**
 * the role check rather than instead of it — because the dangerous case is not
 * a supplier holding an operator role by mistake, it is a platform operator who
 * also belongs to a supplier organization deciding their own submission. A role
 * check alone cannot see that; only the row can.
 *
 * ## Why the directory is different, and how it is contained
 *
 * `SearchSuppliers` and `ListQualifiedFor` deliberately cross tenants: a buyer
 * finding a workshop in another organization is the entire point of a
 * directory, and `docs/04` § 4.10 calls this service "فهرست باز" — an open
 * list. Every other read is scoped to one tenant.
 *
 * The crossing is contained two ways, and both are needed. This file decides
 * *who* may list ({@link assertCanBrowseDirectory}); `views.ts` decides *what a
 * listing contains*, and that projection carries no evidence identifier, no
 * decision note, no actor and no suspension narrative. Neither control would be
 * sufficient alone: an authorized caller reading a leaky projection is still a
 * leak.
 *
 * ## Service callers get nothing
 *
 * No endpoint in this service carries `@AllowService`, so `AuthGuard` refuses a
 * service token before any of this runs (ADR-020: a valid internal token proves
 * *which* service is calling and by itself grants access to nothing). This file
 * refuses `SERVICE` again anyway. `marketplace-service` will eventually need a
 * `SupplierQualificationPort`, and the endpoint that serves it should be opened
 * deliberately with a named caller — not inherited because a helper here
 * treated an internal token as a wildcard, which is how other services'
 * `hasAnyRole` behaves today.
 */

/** Roles that may register and maintain their own organization's profile. */
export const SUPPLIER_SIDE_ROLES = [
  'ORGANIZATION_ADMIN',
  'SUPPLIER',
  'WORKSHOP',
  'CONTRACTOR',
] as const;

/**
 * Roles that may decide a qualification, suspend, or reinstate.
 *
 * `docs/09` § 9.3 gives platform scope to exactly these two. Nothing else
 * decides — not `ORGANIZATION_ADMIN`, whose scope is its own organization, and
 * not this service, which has no judgement of its own.
 */
export const PLATFORM_ROLES = ['SYSTEM_ADMIN', 'UNION_ADMIN'] as const;

/**
 * Roles that may read the public directory.
 *
 * Broader than either side above, because finding a supplier is what buyers,
 * fleet managers and procurement staff do. `docs/09` § 9.3 gives
 * `PROCUREMENT_USER` `rfq:read` and `FLEET_MANAGER` `maintenance:*`, and
 * neither is usable without being able to see who exists.
 *
 * `AUDITOR` is absent, and `OPERATOR`/`DRIVER` are absent: the first is refused
 * platform-wide (below), and the last two have no command that needs a supplier.
 */
export const DIRECTORY_ROLES = [
  ...PLATFORM_ROLES,
  ...SUPPLIER_SIDE_ROLES,
  'PROCUREMENT_USER',
  'FLEET_MANAGER',
] as const;

/**
 * The role that must never reach this service.
 *
 * `docs/09` § 9.3 states it as a product constraint: the province oversight role
 * has aggregate access only, served by analytics-service. A supplier directory
 * is row-level data about named organizations — who is qualified, who is
 * suspended and why — which is the opposite of aggregate-only.
 *
 * Refused here as well as at the gateway and in every `@Roles`, because a rule
 * this absolute should not depend on one file staying correct. The same
 * three-layer defence economic-service, marketplace-service and
 * document-service each carry.
 */
export function assertNotAuditor(): void {
  if (getContext().roles.includes('AUDITOR')) {
    throw RastaError.forbidden(
      'The oversight role has aggregate access only and no access to individual suppliers',
    );
  }
}

/**
 * Refuses a service token outright.
 *
 * `AuthGuard` already refuses one on an endpoint with no `@AllowService`, so
 * this is the second layer. Deliberately **not** the `hasAnyRole` shape used
 * elsewhere, where `authType === 'SERVICE'` returns true and satisfies every
 * role check: that shape is safe only while no endpoint is annotated, and the
 * first `@AllowService` added for the marketplace port would silently grant the
 * caller every role in this file.
 */
export function assertNotServiceCaller(): void {
  if (getContext().authType === 'SERVICE') {
    throw RastaError.forbidden(
      'No service-to-service access to supplier data is granted in this phase',
    );
  }
}

function hasAnyRole(roles: readonly string[]): boolean {
  const context = getContext();
  return roles.some((role) => context.roles.includes(role));
}

export function hasPlatformScope(): boolean {
  const context = getContext();
  // A service caller never gets platform scope — the ADR-035 lesson, and the
  // reason a leaked internal token cannot become a platform-wide reader.
  if (context.authType === 'SERVICE') return false;
  return PLATFORM_ROLES.some((role) => context.roles.includes(role));
}

/** The fields every object-level check needs. */
export interface SupplierOwnership {
  readonly id: string;
  readonly organizationId: string;
}

// ---------------------------------------------------------------------------
// Endpoint-level entry points
// ---------------------------------------------------------------------------

/**
 * Whether the caller may register a profile for their own organization.
 *
 * Platform roles are deliberately **not** here. A `SYSTEM_ADMIN` registering a
 * supplier would be creating the very record they are then asked to judge, and
 * `docs/09` scopes registration to the organization that is registering. An
 * operator who genuinely needs a profile created asks the organization to
 * create it, which leaves the right name on the row.
 */
export function assertCanRegisterSupplier(): void {
  assertNotAuditor();
  assertNotServiceCaller();
  if (!hasAnyRole(SUPPLIER_SIDE_ROLES)) {
    throw RastaError.forbidden('This role may not register a supplier profile');
  }
  // Reached for its own error: a token with no organization cannot name an
  // owner for the profile, and defaulting one would be inventing a tenant.
  getOrganizationId();
}

/** Whether the caller may read the cross-tenant directory at all. */
export function assertCanBrowseDirectory(): void {
  assertNotAuditor();
  assertNotServiceCaller();
  if (!hasAnyRole(DIRECTORY_ROLES)) {
    throw RastaError.forbidden('This role may not browse the supplier directory');
  }
}

/**
 * Whether the caller may read the platform review queue.
 *
 * Cross-tenant and platform-only. It exists because "SYSTEM_ADMIN and
 * UNION_ADMIN may review qualification submissions" is not operable if a
 * reviewer has to already know which supplier applied. It returns the private
 * qualification view — including evidence identifiers — which is exactly why it
 * is restricted to the two roles that already decide these.
 */
export function assertCanReviewQualifications(): void {
  assertNotAuditor();
  assertNotServiceCaller();
  if (!hasPlatformScope()) {
    throw RastaError.forbidden('Only a platform operator may review qualification submissions');
  }
}

// ---------------------------------------------------------------------------
// Object-level checks
// ---------------------------------------------------------------------------

/**
 * Whether the caller may read this supplier's **private** record.
 *
 * `404` rather than `403` for another tenant, and the distinction is not
 * cosmetic: a `403` confirms the profile exists and that somebody else owns it.
 * An outsider probing identifiers learns nothing either way (ADR-011).
 *
 * The directory is not a hole in this. A stranger who lists finds the supplier
 * — that is what a directory does — but gets the catalogue-safe projection,
 * which is a different object. This gate is about the private one.
 */
export function assertSupplierReadable(supplier: SupplierOwnership): void {
  assertNotAuditor();
  assertNotServiceCaller();
  if (hasPlatformScope()) return;

  if (!hasAnyRole(DIRECTORY_ROLES)) {
    throw RastaError.forbidden('This role may not read supplier records');
  }

  if (getOrganizationId() !== supplier.organizationId) {
    throw RastaError.notFound('Supplier', supplier.id);
  }
}

/**
 * Whether the caller may act **as** this supplier — submit a qualification,
 * maintain the profile.
 *
 * Platform scope does not exempt, and that is the asymmetry that matters. A
 * platform operator may *read* any profile to review it; letting one submit on
 * a supplier's behalf would produce a submission whose `submittedBy` is the
 * person who will approve it, and the self-approval check further down would
 * have nothing to catch — the two halves of the decision would already be the
 * same person by then.
 */
export function assertActingAsSupplier(supplier: SupplierOwnership): void {
  assertNotAuditor();
  assertNotServiceCaller();

  if (!hasAnyRole(SUPPLIER_SIDE_ROLES)) {
    throw RastaError.forbidden('This role may not act on behalf of a supplier');
  }

  if (getOrganizationId() !== supplier.organizationId) {
    // 404, not 403: a stranger must not learn the profile exists.
    throw RastaError.notFound('Supplier', supplier.id);
  }
}

/**
 * The rule that keeps a decision a decision.
 *
 * "A supplier organization must never approve, reject, suspend or reinstate
 * itself." Enforced on the row, not on the role, because the case it catches is
 * a person who legitimately holds `UNION_ADMIN` **and** belongs to the supplier
 * organization in question. Every role check they face passes.
 *
 * `403` rather than `404`: they can already read this profile and they know it
 * exists, so hiding it would be theatre. What they are told is that the
 * decision is not theirs to make.
 *
 * `SYSTEM_ADMIN` is not exempt. An exemption would make the control depend on
 * which admin role somebody holds, and the whole point is that no role makes
 * self-judgement acceptable.
 */
export function assertNotDecidingOwnCase(supplier: SupplierOwnership): void {
  const context = getContext();
  const caller = context.organizationId;

  if (caller && caller === supplier.organizationId) {
    throw RastaError.forbidden(
      'A supplier organization may not decide its own qualification, suspension or reinstatement',
    );
  }
}

/**
 * Whether the caller may decide this supplier's qualification or suspension.
 *
 * The two checks in order, and the order is the point: platform scope first, so
 * a supplier-side caller is refused for the reason that actually applies to
 * them, then the self-judgement check, which is the one that catches somebody
 * who passed the first.
 */
export function assertCanDecideAbout(supplier: SupplierOwnership): void {
  assertNotAuditor();
  assertNotServiceCaller();

  if (!hasPlatformScope()) {
    throw RastaError.forbidden(
      'Only a platform operator may decide a supplier qualification or suspension',
    );
  }

  assertNotDecidingOwnCase(supplier);
}
