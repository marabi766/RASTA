import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';

/**
 * Object-level authorization for the marketplace (S-03, BOLA).
 *
 * `@Roles` answers "may this kind of user do this kind of thing". It never
 * sees the record, so it cannot answer "may they touch *this* order" — and in
 * a marketplace that second question is the whole security model: two
 * organizations are legitimately involved in every order, and each may do
 * exactly one half of the things that can be done to it.
 *
 * ## Why an order needs its own check
 *
 * Every other row here carries one `organizationId` and the tenant guard
 * scopes it automatically. An `Order` names **two** organizations — the buyer
 * who owns the row and the supplier who must be able to fulfil it — so the
 * supplier's reads cross the tenant guard with a written reason and land here,
 * where the check is explicit and narrow: exactly the two named parties.
 *
 * ## The rule that decides who releases money
 *
 * `ConfirmReceipt` is the only command that lets settlement happen (ADR-038),
 * and only the **buyer organization** may issue it. Not the supplier — who
 * would then be confirming their own delivery — and not a platform operator,
 * who was not there. That is {@link assertBuyer}.
 */

/** Roles that may commit their organization to a purchase. */
export const BUYER_ROLES = [
  'SYSTEM_ADMIN',
  'UNION_ADMIN',
  'ORGANIZATION_ADMIN',
  'PROCUREMENT_USER',
] as const;

/**
 * Roles that may publish offers and record fulfilment.
 *
 * `ORGANIZATION_ADMIN` is here because `docs/09` § 9.3 defines it as "everything
 * in their own organization" — and selling is something an organization does.
 * It grants nothing extra: {@link assertSupplier} still requires the caller's
 * organization to be the one named on the order, so an administrator can act as
 * the seller for their own organization's orders and for nobody else's.
 *
 * An organization is a buyer in one order and a seller in the next; the
 * platform has no separate "supplier account" concept, and inventing one would
 * be inventing a business fact (AGENTS.md § 9).
 */
export const SUPPLIER_ROLES = [
  'SYSTEM_ADMIN',
  'UNION_ADMIN',
  'SUPPLIER',
  'ORGANIZATION_ADMIN',
] as const;

/** Roles allowed to read the marketplace at all. */
export const READ_ROLES = [...new Set([...BUYER_ROLES, ...SUPPLIER_ROLES])] as const;

/** Platform-scope roles — the only ones that may resolve a dispute. */
export const PLATFORM_ROLES = ['SYSTEM_ADMIN', 'UNION_ADMIN'] as const;

/**
 * The role that must never reach this service.
 *
 * `docs/09` § 9.3 states it as a product constraint: the province oversight
 * role has aggregate access only, served by analytics-service. Refused here as
 * well as at the gateway and in every `@Roles`, because a rule this absolute
 * should not depend on one file staying correct — the same three-layer defence
 * economic-service has.
 */
export function assertNotAuditor(): void {
  if (getContext().roles.includes('AUDITOR')) {
    throw RastaError.forbidden(
      'The oversight role has aggregate access only and no access to individual orders',
    );
  }
}

export function hasPlatformScope(): boolean {
  const context = getContext();
  // A service caller is exempt from the *role* check and from nothing else —
  // it never gets platform scope, which is what would let it read across
  // tenants (the ADR-035 lesson from economic-service).
  if (context.authType === 'SERVICE') return false;
  return PLATFORM_ROLES.some((role) => context.roles.includes(role));
}

function hasAnyRole(roles: readonly string[]): boolean {
  const context = getContext();
  if (context.authType === 'SERVICE') return true;
  return roles.some((role) => context.roles.includes(role));
}

/** The two organizations an order concerns. */
export interface OrderParties {
  readonly id: string;
  readonly organizationId: string;
  readonly supplierOrganizationId: string;
}

/**
 * Either party may read the order; nobody else may know it exists.
 *
 * `404` rather than `403` on a cross-tenant read: telling an outsider "you may
 * not see this" confirms it exists, which is itself the leak (ADR-011).
 */
export function assertOrderVisible(order: OrderParties): void {
  assertNotAuditor();
  if (hasPlatformScope()) return;

  const caller = getOrganizationId();
  if (caller === order.organizationId || caller === order.supplierOrganizationId) return;

  throw RastaError.notFound('Order', order.id);
}

/**
 * Only the buying organization may act as the buyer.
 *
 * Used for receipt confirmation, cancellation, disputes and reviews. A
 * platform operator is **not** exempt: `ConfirmReceipt` releases money against
 * a delivery only the buyer witnessed, and an operator confirming it would be
 * asserting something they cannot know.
 */
export function assertBuyer(order: OrderParties, action: string): void {
  assertNotAuditor();

  if (!hasAnyRole(BUYER_ROLES)) {
    throw RastaError.forbidden(`This role may not ${action}`);
  }

  if (getOrganizationId() !== order.organizationId) {
    // The supplier can see this order, so 404 would be a lie. It is a genuine
    // authorization refusal on a record the caller is entitled to know about.
    throw RastaError.forbidden(`Only the buying organization may ${action}`);
  }
}

/**
 * Only the supplying organization may act as the supplier.
 *
 * Confirming an order and recording fulfilment are statements about what the
 * seller has done, and nobody else is in a position to make them.
 */
export function assertSupplier(order: OrderParties, action: string): void {
  assertNotAuditor();

  if (!hasAnyRole(SUPPLIER_ROLES)) {
    throw RastaError.forbidden(`This role may not ${action}`);
  }

  if (getOrganizationId() !== order.supplierOrganizationId) {
    throw RastaError.forbidden(`Only the supplying organization may ${action}`);
  }
}

/** An offer may only be changed by the supplier that owns it. */
export function assertOfferOwner(offer: { id: string; organizationId: string }): void {
  assertNotAuditor();

  if (!hasAnyRole(SUPPLIER_ROLES)) {
    throw RastaError.forbidden('This role may not manage offers');
  }

  if (hasPlatformScope()) return;

  if (getOrganizationId() !== offer.organizationId) {
    // Offers of other suppliers are publicly listed, but their existence under
    // a given id is not something a stranger gets to confirm by trying to edit
    // one.
    throw RastaError.notFound('Offer', offer.id);
  }
}

/** Resolving a dispute is an operator decision, never a party's. */
export function assertDisputeResolver(): void {
  assertNotAuditor();
  if (!hasPlatformScope()) {
    throw RastaError.forbidden('Only a platform operator may resolve a dispute');
  }
}
