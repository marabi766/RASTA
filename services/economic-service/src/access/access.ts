import { Logger } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import type { HierarchyQuestion } from '../organization/organization-hierarchy';

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
  // flow (docs/08 § 8.6). It is exempt from the *role* check, and from
  // nothing else — the tenant check below still applies.
  //
  // Until ADR-035 this returned outright, because a service call carried no
  // tenant and there was nothing to compare against. Now that its token is
  // signed for one organization, returning here would let a service holding a
  // token for A commit B, which is precisely the escape the signature exists
  // to prevent.
  const isService = context.authType === 'SERVICE';

  const isAdmin = FINANCIAL_ADMIN_ROLES.some((role) => context.roles.includes(role));
  if (!isService && !isAdmin) {
    throw RastaError.forbidden(
      'You do not have permission to commit this organization financially',
    );
  }

  // Platform administrators may act for another organization — an operator
  // resolving a stuck settlement (the six transaction commands are narrower
  // still: `canActFinanciallyFor`). Everyone else is confined to their own, and
  // the mismatch is a 403 rather than a 404 because the caller already knows
  // which organization they asked to act for.
  // `getOrganizationId()` rather than `context.organizationId`: a service
  // whose token carries no signed tenant is refused here with the platform's
  // 403 rather than silently comparing against `undefined` (ADR-035).
  if (getOrganizationId() !== organizationId && !hasPlatformScope()) {
    throw RastaError.tenantMismatch(organizationId, [context.organizationId ?? '(none)']);
  }
}

/**
 * The six commands that move or stop a transaction's money (docs/24 Q-136):
 * settlement, its authorisation, opening and resolving a dispute,
 * cancellation and refund. Named in every record of who did one for whom.
 */
export type FinancialCommand =
  'SETTLE' | 'AUTHORISE_SETTLEMENT' | 'DISPUTE' | 'RESOLVE_DISPUTE' | 'CANCEL' | 'REFUND';

/**
 * On what authority the caller acts on a transaction's books:
 *
 * - `OWN_ORGANIZATION` — the request acts for the organization whose books
 *   carry the transaction (its payer), or is the order saga as that party;
 * - `PAYEE` — the payee's financial administrator returning escrow (Q-62);
 * - `SYSTEM_ADMIN` — the platform operator, for any organization;
 * - `UNION_SUBTREE` — a union administrator, for an organization
 *   organization-service confirmed within its union (Q-136), at
 *   `hierarchyVersion`.
 */
export type FinancialAuthorityBasis =
  'OWN_ORGANIZATION' | 'PAYEE' | 'SYSTEM_ADMIN' | 'UNION_SUBTREE';

export interface FinancialAuthority {
  readonly command: FinancialCommand;
  readonly basis: FinancialAuthorityBasis;
  /** Who acts: the platform user id, or the calling service. */
  readonly actor: string;
  /** The organization the request acts for — its idempotency key and attribution. */
  readonly actingOrganizationId: string;
  /** The organization whose books carry the transaction: its own tenant, the payer. */
  readonly booksOrganizationId: string;
  /** For `UNION_SUBTREE`: organization-service's hierarchy version of the books organization. */
  readonly hierarchyVersion: number | null;
}

/** The records of who did a financial command for whom (`recordFinancialCommand`). */
const financialLog = new Logger('FinancialAuthority');

/**
 * The one rule for acting financially for an organization (docs/24 Q-136,
 * decided by the product owner 2026-10-16), for each of the six
 * {@link FinancialCommand}s, fresh and replayed alike:
 *
 * | caller                                   | for its own organization | for another one                         |
 * | ---------------------------------------- | ------------------------ | --------------------------------------- |
 * | financial administrator (any of the three) | as before              | `canCommitOrganization` refuses         |
 * | `SYSTEM_ADMIN`                           | as before                | yes — unchanged                         |
 * | `UNION_ADMIN`                            | as before                | only within its union's subtree; else 403 |
 * | a service                                | as the party its token names | `canCommitOrganization` refuses     |
 *
 * "Within the union's subtree" is decided by organization-service, the owner
 * of the hierarchy (A-13), asked over authenticated REST with a token signed
 * for the union — the organization the request acts for — never by anything
 * the client sends. "Could not confirm" is 503/504 and nothing is written
 * (fail closed). The caller asks this under the transaction's row lock, in the
 * transaction that commits the command; the answer's hierarchy version is in
 * the command's record, so a concurrent `ORGANIZATION_MOVED` can be ordered
 * against it (docs/23 D-054).
 *
 * The books stay the transaction's own: this decides only whether the caller
 * may act for them.
 */
export async function canActFinanciallyFor(
  command: FinancialCommand,
  booksOrganizationId: string,
  hierarchy: HierarchyQuestion,
): Promise<FinancialAuthority> {
  canCommitOrganization(booksOrganizationId);
  const context = getContext();
  const actingOrganizationId = getOrganizationId();
  const authority = (basis: FinancialAuthorityBasis, hierarchyVersion: number | null = null) =>
    financialAuthority(command, basis, booksOrganizationId, hierarchyVersion);

  if (actingOrganizationId === booksOrganizationId) return authority('OWN_ORGANIZATION');

  // Past `canCommitOrganization`, only platform scope acts for another
  // organization: a person, never a service.
  const isPerson = context.authType !== 'SERVICE';
  if (isPerson && context.roles.includes('SYSTEM_ADMIN')) return authority('SYSTEM_ADMIN');
  if (isPerson && context.roles.includes('UNION_ADMIN')) {
    // The union is the organization the request acts for, signed into the
    // question's token; the answer is organization-service's (A-13).
    const within = await hierarchy.withinVersion(actingOrganizationId, booksOrganizationId);
    if (within) return authority('UNION_SUBTREE', within.hierarchyVersion);
  }
  financialLog.warn(
    `Financial command ${command} refused: actor=${actorOf()} ` +
      `actingOrganization=${actingOrganizationId} booksOrganization=${booksOrganizationId} ` +
      'reason=OUTSIDE_UNION_SUBTREE',
  );
  throw outsideUnionRefused();
}

function outsideUnionRefused(): RastaError {
  return RastaError.forbidden(
    "Acting financially for another organization is limited to the organizations within your union's subtree",
  );
}

function financialAuthority(
  command: FinancialCommand,
  basis: FinancialAuthorityBasis,
  booksOrganizationId: string,
  hierarchyVersion: number | null = null,
): FinancialAuthority {
  return Object.freeze({
    command,
    basis,
    actor: actorOf(),
    actingOrganizationId: getOrganizationId(),
    booksOrganizationId,
    hierarchyVersion,
  });
}

function actorOf(): string {
  const context = getContext();
  return context.userId ?? context.callerService ?? '(unknown)';
}

/**
 * The record of a financial command that committed: who acted, for which
 * organization, on whose books, and on what authority (docs/24 Q-136). One
 * line per command, after its transaction commits — the settlement row also
 * keeps `acting_organization_id`; the other five commands have no column for
 * it, so this line is where the acting organization is kept (S-06: logged,
 * not yet a durable audit record).
 */
export function recordFinancialCommand(transactionId: string, authority: FinancialAuthority): void {
  financialLog.log(
    `Financial command ${authority.command} on ${transactionId}: actor=${authority.actor} ` +
      `actingOrganization=${authority.actingOrganizationId} ` +
      `booksOrganization=${authority.booksOrganizationId} authority=${authority.basis}` +
      (authority.hierarchyVersion === null
        ? ''
        : ` hierarchyVersion=${authority.hierarchyVersion}`),
  );
}

/**
 * Leave to post a settlement journal on the payer's books while acting for
 * another organization (docs/23 D-054, review of #287 r4 F3).
 *
 * Issued only by {@link settlementBooks} and checked by
 * `LedgerRepository.createJournal` (by identity, not by shape), so the journal
 * header is the one row it can carry across the tenant guard.
 */
export interface SettlementBooks {
  /** The payer, whose books the settlement journal is posted on. */
  readonly organizationId: string;
  /** The organization the platform administrator is acting for. */
  readonly actingOrganizationId: string;
}

const issuedSettlementBooks = new WeakSet<SettlementBooks>();

/**
 * Whose books a settlement journal is posted on, when that is not the
 * organization the request acts for — and the authority it is posted on.
 *
 * A settlement's journal belongs to the payer. A platform administrator acting
 * for another organization may settle it — {@link canActFinanciallyFor} admits
 * a system administrator, and a union administrator for an organization of its
 * union's subtree — but the journal header is tenant-scoped, and without this
 * the guard refused the write and the settlement failed as a 500. This is the
 * narrow, explicit leave to make that one write: everything else in the
 * request (its idempotency key, its attribution) stays with the acting
 * organization.
 *
 * `books` is `undefined` when the caller acts for the payer: there is nothing
 * to cross. Anyone else is refused exactly as {@link canActFinanciallyFor}
 * refuses them — it is that function, asked here under the row lock.
 */
export async function settlementBooks(
  payerOrganizationId: string,
  hierarchy: HierarchyQuestion,
): Promise<{ authority: FinancialAuthority; books: SettlementBooks | undefined }> {
  const authority = await canActFinanciallyFor('SETTLE', payerOrganizationId, hierarchy);
  if (authority.basis === 'OWN_ORGANIZATION') return { authority, books: undefined };
  if (authority.basis !== 'SYSTEM_ADMIN' && authority.basis !== 'UNION_SUBTREE') {
    // Unreachable for a settlement; stated so the crossing never rests on
    // another function's branch staying as it is.
    throw outsideUnionRefused();
  }
  const books = Object.freeze({
    organizationId: payerOrganizationId,
    actingOrganizationId: authority.actingOrganizationId,
  });
  issuedSettlementBooks.add(books);
  return { authority, books };
}

/** Whether `books` was issued by {@link settlementBooks} — not merely shaped like it. */
export function isIssuedSettlementBooks(books: SettlementBooks): boolean {
  return issuedSettlementBooks.has(books);
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

  // No exemption for a service caller. Its token names one organization, and
  // that is the organization it is a party as — the same question asked of
  // everybody else (ADR-035).
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
 * The facts a refund decision reads off a transaction.
 *
 * `status` is part of it because the answer depends on it: a disputed
 * transaction is a platform decision in a way a held one is not.
 */
export interface RefundableTransaction {
  id: string;
  organizationId: string;
  counterpartyOrganizationId: string | null;
  status: string;
}

export interface RefundPolicy {
  /**
   * Whether the payee's financial administrator may return escrowed funds.
   *
   * The one part of this rule that is a product choice rather than a control
   * (docs/24 Q-62), so it comes from configuration:
   * `ECONOMIC_REFUND_BY_PAYEE_ENABLED`.
   */
  payeeMayRefund: boolean;
}

/**
 * Refuses a refund the caller has no authority to make (docs/24 Q-62, Q-136),
 * and answers the authority it is made on.
 *
 * A refund returns escrow to the **payer**, so the payer is the one party
 * whose say-so cannot be enough: a payer that could refund its own escrow
 * could confirm receipt, or open a dispute, and then take the money back —
 * stepping around `resolve-dispute`, which is a platform decision, and leaving
 * the payee unpaid (docs/10 § 10.5). The rule:
 *
 * | caller                                         | may refund                  |
 * | ---------------------------------------------- | --------------------------- |
 * | not a party, no platform scope                 | 404 (never learns it exists) |
 * | the payer, in any role, from any state         | never — 403                  |
 * | a service `@AllowService` admits on the route  | as the party its token names |
 * | the payee's financial administrator            | yes, unless `DISPUTED`       |
 * | `SYSTEM_ADMIN` acting for another organization | from any refundable state    |
 * | `UNION_ADMIN` acting for another organization  | the same, only if the payer is within its union's subtree (Q-136); else 403 |
 *
 * The last two are {@link canActFinanciallyFor} for the payer's books — the
 * one rule every financial command shares. The payee's own rule is judged
 * first and asks nothing of the hierarchy, so a union administrator of the
 * payee keeps what the payee's own administrator has.
 *
 * **The service row is the order saga.** marketplace-service's token is signed
 * for the *buyer* — the payer — and its refund is the compensation for an order
 * cancelled before settlement, an authority its own saga has already checked
 * (docs/08 § 8.4). It is still held to the tenant check above it: a token for
 * an organization that is not a party gets the same 404 as anyone (ADR-035).
 *
 * The state machine still decides whether a refund is possible at all; this
 * only decides who may ask.
 */
export async function assertMayRefund(
  transaction: RefundableTransaction,
  policy: RefundPolicy,
  hierarchy: HierarchyQuestion,
): Promise<FinancialAuthority> {
  // First, so that a non-party learns nothing — not even that it would have
  // been refused for a different reason.
  assertTransactionVisible(transaction);

  const context = getContext();
  const acting = getOrganizationId();
  const payer = transaction.organizationId;
  const isPayee = acting === transaction.counterpartyOrganizationId;

  if (context.authType === 'SERVICE') {
    return financialAuthority('REFUND', isPayee ? 'PAYEE' : 'OWN_ORGANIZATION', payer);
  }

  if (acting === payer) {
    throw RastaError.forbidden('The payer cannot refund its own transaction');
  }

  const isAdmin = FINANCIAL_ADMIN_ROLES.some((role) => context.roles.includes(role));
  if (isPayee && isAdmin && policy.payeeMayRefund && transaction.status !== 'DISPUTED') {
    return financialAuthority('REFUND', 'PAYEE', payer);
  }

  if (hasPlatformScope()) return canActFinanciallyFor('REFUND', payer, hierarchy);

  if (transaction.status === 'DISPUTED') {
    throw RastaError.forbidden(
      'A disputed transaction is refunded only by a platform decision on the dispute',
    );
  }
  throw RastaError.forbidden('You do not have permission to refund this transaction');
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

  // A service caller is held to the same rule, against the organization its
  // token was signed for (ADR-035).
  if (wallet.organizationId !== getOrganizationId() && !hasPlatformScope()) {
    throw RastaError.notFound('Wallet', wallet.id);
  }
}
