import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';

/**
 * Object-level authorization for documents (AGENTS.md S-03, BOLA).
 *
 * `@Roles` answers "may this kind of user handle documents at all". It never
 * sees the row, so it cannot answer "may they read *this* document" — and for
 * a service whose entire job is holding other people's contracts, licences and
 * damage photographs, that second question is the whole security model.
 *
 * ## Why a document is simpler than an order, and stricter
 *
 * An order legitimately concerns two organizations, so marketplace's checks
 * admit two. A document belongs to exactly **one**. There is no second party,
 * no counterparty read, and no cross-tenant path — which means every check
 * here reduces to: does the caller's organization own this row, or is the
 * caller a platform operator.
 *
 * ## Cross-tenant sharing is deliberately absent
 *
 * A supplier's licence will eventually need to be visible to a buyer
 * evaluating them, and a tender pack to the bidders invited to it. Neither has
 * an accepted design: no document defines who may grant such access, whether
 * it survives the relationship ending, or what an auditor sees. Inventing one
 * here would be inventing a business rule (AGENTS.md § 9), so
 * {@link assertDocumentReadable} refuses every cross-tenant read and the
 * question is recorded as Q-36 in `docs/24`. `AccessGrant` therefore names
 * subjects **within** the owning organization only.
 */

/** Roles that may register and read documents for their organization. */
export const DOCUMENT_ROLES = [
  'SYSTEM_ADMIN',
  'UNION_ADMIN',
  'ORGANIZATION_ADMIN',
  'PROCUREMENT_USER',
  'SUPPLIER',
  'FLEET_MANAGER',
  'TECHNICIAN',
] as const;

/** Platform-scope roles. */
export const PLATFORM_ROLES = ['SYSTEM_ADMIN', 'UNION_ADMIN'] as const;

/**
 * The role that must never reach this service.
 *
 * `docs/09` § 9.3 makes it a product constraint: the province oversight role
 * has aggregate access only, served by analytics-service. An auditor who could
 * read documents could read every contract and licence on the platform, which
 * is the opposite of aggregate-only. Refused here as well as at the gateway
 * and in every `@Roles`, because a rule this absolute should not depend on one
 * file staying correct.
 */
export function assertNotAuditor(): void {
  if (getContext().roles.includes('AUDITOR')) {
    throw RastaError.forbidden(
      'The oversight role has aggregate access only and no access to individual documents',
    );
  }
}

export function hasPlatformScope(): boolean {
  const context = getContext();
  // A service caller is exempt from the *role* check and from nothing else. It
  // never gets platform scope, which is what would let it read across tenants
  // — the ADR-035 lesson, and the reason a compromised service token cannot
  // become a platform-wide document reader.
  if (context.authType === 'SERVICE') return false;
  return PLATFORM_ROLES.some((role) => context.roles.includes(role));
}

function hasAnyRole(roles: readonly string[]): boolean {
  const context = getContext();
  if (context.authType === 'SERVICE') return true;
  return roles.some((role) => context.roles.includes(role));
}

export function assertCanHandleDocuments(): void {
  assertNotAuditor();
  if (!hasAnyRole(DOCUMENT_ROLES)) {
    throw RastaError.forbidden('This role may not handle documents');
  }
}

/** The fields any object-level check needs. */
export interface DocumentOwnership {
  readonly id: string;
  readonly organizationId: string;
}

/**
 * Whether the caller may know this document exists.
 *
 * `404` rather than `403` on a cross-tenant read, and the distinction is not
 * cosmetic: a `403` confirms the document exists and that somebody else owns
 * it, which for a document store is itself the leak. An outsider probing
 * identifiers learns nothing either way (ADR-011).
 */
export function assertDocumentReadable(document: DocumentOwnership): void {
  assertNotAuditor();
  if (!hasAnyRole(DOCUMENT_ROLES)) {
    throw RastaError.forbidden('This role may not handle documents');
  }
  if (hasPlatformScope()) return;

  if (getOrganizationId() !== document.organizationId) {
    throw RastaError.notFound('Document', document.id);
  }
}

/**
 * Whether the caller may change or delete this document.
 *
 * Deliberately the same ownership rule as reading rather than a looser one: a
 * platform operator who can read a document to resolve a support case can also
 * delete it, and both acts are audited. What is *not* permitted is a second
 * organization doing either, which is the case the tests exercise.
 */
export function assertDocumentWritable(document: DocumentOwnership): void {
  assertDocumentReadable(document);
}

/**
 * Whether the caller may redeem this upload intent.
 *
 * Stricter than reading a document, and platform scope does **not** exempt:
 * an intent is a permission issued to one organization to create one object,
 * and letting an operator finalize somebody else's upload would attach an
 * object to a tenant that never asked for it. An operator with a genuine
 * reason can act within the tenant, which is a different thing from acting
 * across it.
 */
export function assertIntentRedeemable(intent: { id: string; organizationId: string }): void {
  assertNotAuditor();
  if (!hasAnyRole(DOCUMENT_ROLES)) {
    throw RastaError.forbidden('This role may not handle documents');
  }

  if (getOrganizationId() !== intent.organizationId) {
    throw RastaError.notFound('UploadIntent', intent.id);
  }
}
