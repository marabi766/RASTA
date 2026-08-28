import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';

/**
 * Object-level authorization for the financial domain.
 *
 * The `@Roles` guard answers "may this kind of user do this kind of thing". It
 * cannot answer "may they touch *this* record", because it never sees the
 * record. That second question is this file's job — docs/09 § 9.3 calls it the
 * most critical layer — and in this service it is the difference between a
 * user reading their own organization's balances and reading everybody's.
 *
 * ## The rule this file exists to keep absolutely
 *
 * **CONSTRAINT (product document, ch. 4, restated in docs/09 § 9.3 and
 * docs/10 § 10.13):** the province oversight role has aggregate access only,
 * "بدون دسترسی به جزئیات تراکنش‌های فردی". In code that means:
 *
 * > **`AUDITOR` has no permission on economic-service at all.** Not read-only,
 * > not restricted — none. The governance dashboard is served by
 * > analytics-service, from aggregates.
 *
 * It is enforced three times over, and deliberately so: the gateway's routing
 * table never grants `AUDITOR` an economic prefix, every controller lists its
 * roles explicitly, and {@link assertNotAuditor} refuses it here even if both
 * of those were edited. A rule this consequential should not depend on one
 * file staying correct.
 *
 * ## Why a transaction needs its own check
 *
 * Every other row in this service carries one `organizationId` and is scoped
 * automatically. A transaction names *two* organizations — a payer and a payee
 * — and the payee is legitimately entitled to see it. The tenant guard cannot
 * express that, so those reads cross it with a written reason and land here,
 * where the check is explicit and narrow: exactly the two named parties, and
 * nobody else.
 */

/** Roles that may act on the financial state of their own organization. */
export const FINANCIAL_ADMIN_ROLES = ['SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN'] as const;

/**
 * Platform-scope roles — the only ones that may read across tenants.
 *
 * `UNION_ADMIN` is a Platform-scope role in docs/09 § 9.3's table, which is
 * what makes the trial balance legitimately theirs to read.
 */
export const PLATFORM_ROLES = ['SYSTEM_ADMIN', 'UNION_ADMIN'] as const;

/**
 * The role that may change governance configuration.
 *
 * Narrower than `PLATFORM_ROLES`: docs/10 § 10.7 requires `SYSTEM_ADMIN` for a
 * commission-rate change specifically, because the rate is approved by the
 * steering group and the platform must record who applied their decision
 * (ADR-023).
 */
export const RULE_ADMIN_ROLES = ['SYSTEM_ADMIN'] as const;

/**
 * The one role that must never reach this service.
 *
 * Refused here as well as at the gateway and in every controller's `@Roles`,
 * because the product document's constraint is absolute and a defence that
 * exists in one place is a defence one edit away from being gone.
 */
export function assertNotAuditor(): void {
  const context = getContext();
  if (context.roles.includes('AUDITOR')) {
    throw RastaError.forbidden(
      'The oversight role has aggregate access only and no access to individual financial records',
    );
  }
}

export function hasPlatformScope(): boolean {
  const context = getContext();
  if (context.authType === 'SERVICE') return false;
  return PLATFORM_ROLES.some((role) => context.roles.includes(role));
}

/**
 * Refuses a cross-tenant financial report to anyone without platform scope.
 *
 * Used by the trial balance, which is platform-wide by nature: a per-tenant
 * slice of a ledger does not balance, because a settlement's counterparty and
 * commission legs belong to other organizations (docs/10 § 10.13).
 *
 * A service-to-service caller does **not** get platform scope. `@AllowService`
 * already established that the calling *service* may use the endpoint; that is
 * a different question from whether a cross-tenant financial report should be
 * readable over an internal call, and the conservative answer is the right one
 * for a report of every organization's balances.
 */
export function assertPlatformScope(what: string): void {
  assertNotAuditor();
  if (!hasPlatformScope()) {
    throw RastaError.forbidden(`${what} is available to platform administrators only`);
  }
}

/**
 * Whether the caller may commit this organization to money moving.
 *
 * Settlement, dispute, refund and cancellation all change what an organization
 * owes or is owed, so they are limited to the roles that can commit it. An
 * operator or driver, who may report a breakdown, may not authorise the
 * payment for it — the same narrowing maintenance-service applied for the same
 * reason (ADR-029).
 */
export function canCommitOrganization(organizationId: string): void {
  assertNotAuditor();
  const context = getContext();

  // A service-to-service caller has already been authorized against
  // `@AllowService`, which is a stricter question than role membership:
  // marketplace-service settling an order it owns is exactly the documented
  // flow (docs/08 § 8.6).
  if (context.authType === 'SERVICE') return;

  const isAdmin = FINANCIAL_ADMIN_ROLES.some((role) => context.roles.includes(role));
  if (!isAdmin) {
    throw RastaError.forbidden(
      'You do not have permission to commit this organization financially',
    );
  }

  // Platform administrators may act for another organization — an operator
  // resolving a stuck settlement. Everyone else is confined to their own, and
  // the mismatch is a 403 rather than a 404 because the caller already knows
  // which organization they asked to act for.
  if (context.organizationId !== organizationId && !hasPlatformScope()) {
    throw RastaError.tenantMismatch(organizationId, [context.organizationId ?? '(none)']);
  }
}

/**
 * Refuses a transaction the caller is not a party to.
 *
 * Throws `notFound`, never `forbidden`: a 403 confirms the record exists, and
 * an attacker walking identifiers could map which organizations trade with
 * which and for how much. The platform's non-disclosure rule is uniform
 * (docs/09, `RastaError.notFound`).
 */
export function assertTransactionVisible(transaction: {
  id: string;
  organizationId: string;
  counterpartyOrganizationId: string | null;
}): void {
  assertNotAuditor();

  const context = getContext();
  if (context.authType === 'SERVICE') return;

  const caller = getOrganizationId();
  if (transaction.organizationId === caller) return;
  if (transaction.counterpartyOrganizationId === caller) return;

  // Platform administrators may read any transaction — that is what makes a
  // stuck settlement diagnosable at all — but they reach this line only when
  // they are not a party, so the crossing is explicit rather than incidental.
  if (hasPlatformScope()) return;

  throw RastaError.notFound('Transaction', transaction.id);
}

/**
 * Refuses a wallet that is not the caller's own.
 *
 * There is no "read another organization's wallet" path for a tenant, not even
 * for a counterparty. A payee learns what it will receive from the transaction
 * and from its own wallet — never from the payer's balance.
 */
export function assertWalletVisible(wallet: { id: string; organizationId: string }): void {
  assertNotAuditor();

  const context = getContext();
  if (context.authType === 'SERVICE') return;

  if (wallet.organizationId !== getOrganizationId() && !hasPlatformScope()) {
    throw RastaError.notFound('Wallet', wallet.id);
  }
}
