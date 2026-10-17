import { Logger } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import type { HierarchyQuestion } from '../organization/organization-hierarchy';

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

/**
 * On what authority an operator decides a dispute:
 *
 * - `SYSTEM_ADMIN` — the platform operator, for any order;
 * - `OWN_ORGANIZATION` — a union administrator acting for the order's buyer itself;
 * - `UNION_SUBTREE` — a union administrator, for an order whose buyer
 *   organization-service confirmed within its union (docs/24 Q-136), at
 *   `hierarchyVersion`.
 */
export type DisputeAuthorityBasis = 'SYSTEM_ADMIN' | 'OWN_ORGANIZATION' | 'UNION_SUBTREE';

export interface DisputeAuthority {
  readonly basis: DisputeAuthorityBasis;
  /** The platform user id. */
  readonly actor: string;
  /** The organization the operator acts for. */
  readonly actingOrganizationId: string;
  /** The order's buyer: the payer whose money the decision settles or refunds. */
  readonly buyerOrganizationId: string;
  /** For `UNION_SUBTREE`: organization-service's hierarchy version of the buyer. */
  readonly hierarchyVersion: number | null;
}

/** The records of who decided a dispute for whom (`recordDisputeDecision`). */
const disputeLog = new Logger('DisputeAuthority');

/**
 * Resolving a dispute is an operator decision, never a party's — and a
 * financial one: `SETTLE` sends the order to settlement and `REFUND` to
 * compensation, both carried out by the saga on the buyer's books with the
 * buyer's own service token (ADR-040). economic-service never sees the
 * operator, so the rule economic-service applies to its own six financial
 * commands (docs/24 Q-136) is applied here, against the order's **buyer** —
 * the payer whose money moves (Codex on #314 round 3, F1):
 *
 * | caller        | for the buyer itself | for another organization                    |
 * | ------------- | -------------------- | ------------------------------------------- |
 * | `SYSTEM_ADMIN`| yes                  | yes — unchanged                             |
 * | `UNION_ADMIN` | yes                  | only when the buyer is within its union's subtree; else 403 |
 * | anyone else   | 403 (not an operator)| 403                                         |
 *
 * "Within" is organization-service's answer (A-13), asked with a token signed
 * for the union — the organization the request acts for — never anything the
 * client sends. "Could not confirm" is 503/504 and the decision is not taken
 * (fail closed). Asked by the command under the order's row lock, immediately
 * before the decision is written, and by its replay guard before a stored
 * decision is shown again.
 */
export async function assertDisputeResolver(
  order: OrderParties,
  hierarchy: HierarchyQuestion,
): Promise<DisputeAuthority> {
  assertNotAuditor();
  if (!hasPlatformScope()) {
    throw RastaError.forbidden('Only a platform operator may resolve a dispute');
  }
  const context = getContext();
  const actingOrganizationId = getOrganizationId();
  const authority = (basis: DisputeAuthorityBasis, hierarchyVersion: number | null = null) =>
    Object.freeze({
      basis,
      actor: context.userId ?? '(unknown)',
      actingOrganizationId,
      buyerOrganizationId: order.organizationId,
      hierarchyVersion,
    });

  if (context.roles.includes('SYSTEM_ADMIN')) return authority('SYSTEM_ADMIN');
  // Past platform scope, the caller is a union administrator.
  if (actingOrganizationId === order.organizationId) return authority('OWN_ORGANIZATION');
  const within = await hierarchy.withinVersion(actingOrganizationId, order.organizationId);
  if (within) return authority('UNION_SUBTREE', within.hierarchyVersion);

  disputeLog.warn(
    `Dispute decision on order ${order.id} refused: actor=${context.userId ?? '(unknown)'} ` +
      `actingOrganization=${actingOrganizationId} buyerOrganization=${order.organizationId} ` +
      'reason=OUTSIDE_UNION_SUBTREE',
  );
  throw RastaError.forbidden(
    "Resolving a dispute is limited to orders whose buyer is within your union's subtree",
  );
}

/**
 * The record of a dispute decision that committed: who decided, for which
 * organization, on whose order, which outcome, on what authority (docs/24
 * Q-136). One line, after the decision's transaction commits — logged, not
 * yet a durable audit record (S-06), as economic-service's
 * `recordFinancialCommand`.
 */
export function recordDisputeDecision(
  orderId: string,
  outcome: string,
  authority: DisputeAuthority,
): void {
  disputeLog.log(
    `Dispute decision ${outcome} on order ${orderId}: actor=${authority.actor} ` +
      `actingOrganization=${authority.actingOrganizationId} ` +
      `buyerOrganization=${authority.buyerOrganizationId} authority=${authority.basis}` +
      (authority.hierarchyVersion === null
        ? ''
        : ` hierarchyVersion=${authority.hierarchyVersion}`),
  );
}

/**
 * Which of the three roles this caller plays on this order, without throwing.
 *
 * The `assert*` functions above decide one question each and raise on a no.
 * A client rendering an order needs the whole answer at once — "what may I do
 * here" — and a refusal is not an answer it can draw a screen from.
 *
 * Deliberately built from the **same** predicates rather than beside them, so
 * there is no second definition of who a buyer is. If `assertBuyer` gains a
 * condition and this does not, the two disagree, and the shape of that
 * disagreement is a client offering a command the service then refuses.
 *
 * All three are independent, not exclusive:
 *
 *  - a platform operator acting for the buying organization is **both**
 *    `buyer` and `platform`, and may confirm receipt *and* resolve a dispute;
 *  - an `AUDITOR` is none of them, because the oversight role has no access to
 *    an individual order at all.
 *
 * `platform` is the role half of {@link assertDisputeResolver} only. Its
 * hierarchy half (docs/24 Q-136) is a question to organization-service, and a
 * read — a list of orders above all — does not ask it: a union administrator
 * is offered `RESOLVE_DISPUTE` on a disputed order whose buyer is outside its
 * union, and the command refuses it with 403.
 */
export interface OrderViewerParties {
  readonly buyer: boolean;
  readonly supplier: boolean;
  readonly platform: boolean;
}

export function viewerParties(order: OrderParties): OrderViewerParties {
  const context = getContext();
  if (context.roles.includes('AUDITOR')) {
    return { buyer: false, supplier: false, platform: false };
  }

  // A service caller acts for no organization and gets no party here. It is
  // the same rule `hasPlatformScope` applies for the same ADR-035 reason: a
  // machine must not inherit a human's side of a two-party order.
  if (context.authType === 'SERVICE') {
    return { buyer: false, supplier: false, platform: false };
  }

  const caller = context.organizationId;

  return {
    buyer: hasAnyRole(BUYER_ROLES) && caller === order.organizationId,
    supplier: hasAnyRole(SUPPLIER_ROLES) && caller === order.supplierOrganizationId,
    platform: hasPlatformScope(),
  };
}
