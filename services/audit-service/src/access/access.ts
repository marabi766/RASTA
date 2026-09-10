import { RastaError, getContext } from '@rasta/nest-common';

/**
 * Who may read audit evidence, and the layer that does not depend on a
 * decorator staying correct.
 *
 * ADR-053 § 10 gives the whole matrix, and two of its rows are the ones a
 * reader gets wrong:
 *
 *   SYSTEM_ADMIN        every tenant; the `organizationId` filter is optional.
 *   UNION_ADMIN         its own organization and its authorised subtree.
 *   ORGANIZATION_ADMIN  nothing, in MVP. Least privilege while "owner of the
 *                       record" is still ambiguous (ADR-053 § 11).
 *   AUDITOR             nothing. At all.
 *   a service token     nothing. No caller in MVP reads audit programmatically.
 *   anything else       closed by default (AGENTS.md S-02).
 *
 * ## The AUDITOR row is the surprising one, so it is enforced three times
 *
 * Despite the name, the province oversight role has **no** access to
 * audit-service. `docs/04` § 4.15 and `docs/09:169` both scope it to aggregate
 * analytics endpoints only — no row-level tenant data — and an audit record is
 * row-level tenant data by definition.
 *
 * economic-service, marketplace-service, document-service and supplier-service
 * each enforce that in three independent places: no gateway prefix grants it,
 * no `@Roles` names it, and an `assertNotAuditor()` refuses it even if both
 * were edited. This service carries the same three, and
 * `test/authorization.int-spec.ts` proves the third survives the first two
 * being bypassed.
 */

/** The only two roles any audit endpoint may be reached with. */
export const AUDIT_READER_ROLES = ['SYSTEM_ADMIN', 'UNION_ADMIN'] as const;

/** Platform scope: every tenant, and the platform-scoped rows as well. */
export const SYSTEM_SCOPE_ROLE = 'SYSTEM_ADMIN';

/** Subtree scope: the caller's own organization and what sits beneath it. */
export const UNION_SCOPE_ROLE = 'UNION_ADMIN';

/**
 * The role that must never reach this service.
 *
 * Refused here as well as at the gateway and in every `@Roles`, because a rule
 * this absolute should not depend on one file staying correct. This is the
 * layer that survives an editing mistake in the other two.
 */
export function assertNotAuditor(): void {
  if (getContext().roles.includes('AUDITOR')) {
    throw RastaError.forbidden(
      'The oversight role has aggregate access only and no access to audit records',
    );
  }
}

/**
 * Refuses a service token outright.
 *
 * `AuthGuard` already refuses one on an endpoint with no `@AllowService`, so
 * this is the second layer. Written as an explicit refusal rather than as the
 * `hasAnyRole` shape used elsewhere — where `authType === 'SERVICE'` satisfies
 * every role check — because that shape is safe only while no endpoint is
 * annotated, and the first `@AllowService` added here would silently hand a
 * service token the whole evidence store. `docs/04` § 4.15 is explicit that
 * writing is Kafka-only and that nothing reads audit programmatically in MVP.
 */
export function assertNotServiceCaller(): void {
  if (getContext().authType === 'SERVICE') {
    throw RastaError.forbidden('No service-to-service access to audit records is granted');
  }
}

/** How wide the caller's authority reaches, before any filter is applied. */
export type AuditScopeKind = 'PLATFORM' | 'SUBTREE';

/**
 * The caller's authority, resolved from the **verified token** and nothing
 * else.
 *
 * ADR-053 § 10: "the scope comes from the verified token, never from a query
 * parameter — defect D-2 recorded in `request-context.ts:38-52` is exactly this
 * mistake." So this function reads roles and the active organization from the
 * request context and never looks at the request.
 */
export interface AuditCallerAuthority {
  readonly kind: AuditScopeKind;
  /**
   * The organization a `SUBTREE` caller acts for — the root of what they may
   * reach. Undefined for a `PLATFORM` caller, whose authority has no root.
   */
  readonly rootOrganizationId?: string;
}

/**
 * Resolves the caller's authority, refusing everyone the matrix excludes.
 *
 * `SYSTEM_ADMIN` wins when a token carries both roles: it is strictly the wider
 * authority, so resolving to the narrower one would deny a read the matrix
 * allows without making anything safer.
 */
export function resolveCallerAuthority(): AuditCallerAuthority {
  assertNotAuditor();
  assertNotServiceCaller();

  const context = getContext();

  if (context.roles.includes(SYSTEM_SCOPE_ROLE)) {
    return { kind: 'PLATFORM' };
  }

  if (context.roles.includes(UNION_SCOPE_ROLE)) {
    const rootOrganizationId = context.organizationId;
    if (!rootOrganizationId) {
      // A `RastaError`, not the bare `Error` that `getOrganizationId()` throws:
      // a union administrator whose token names no active organization has no
      // subtree, which is a refusal to state, not a 500 to investigate.
      throw RastaError.forbidden(
        'This request has no active organization, so no audit scope can be established',
      );
    }
    return { kind: 'SUBTREE', rootOrganizationId };
  }

  // ORGANIZATION_ADMIN and every unlisted role land here. `RolesGuard` has
  // already refused them; this is the layer that still refuses if it did not.
  throw RastaError.forbidden('This role may not read audit records');
}
