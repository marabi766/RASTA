import { ERROR_CODES } from '@rasta/contracts';
import { RastaError, type AuthGuardOptions, type UserTenantMismatch } from '@rasta/nest-common';
import { markGuardRefusal, refusalSiteOf } from './refusal-sites';

/**
 * identity-service's audit marking for the platform `AuthGuard`'s own tenant
 * refusal (ADR-053 § 4, AUD-004 Phase C10).
 *
 * ## Why a catch-and-mark wrapper was not enough
 *
 * Every earlier site is marked by wrapping a decision this service could see
 * the *result* of: `IdentityRolesGuard` catches the shared `RolesGuard`'s error
 * and reads the verified caller back out of the request context, which the auth
 * guard has already upgraded by then.
 *
 * The auth guard's tenant refusal is thrown **before** either of those exists.
 * `request.rastaAuth` is unassigned, and the request context still says
 * `ANONYMOUS`, because it is upgraded only after `resolveOrganization` returns.
 * So a subclass or filter catching the error would hold a refusal with no
 * trustworthy actor and no trustworthy tenant — and the only values within
 * reach would be the rejected header, the undecoded bearer token and the
 * error's own `internalContext`, every one of which is either attacker-chosen
 * or something evidence must never carry. Capturing from those would not be
 * weaker evidence; it would be forged evidence.
 *
 * Hence the shared guard gained one generic, optional seam
 * (`AuthGuardOptions.onUserTenantMismatch`): it states who it refused, from the
 * token it has just verified itself. All the audit policy — which refusals are
 * allowlisted, what the record says, what is fail-closed — stays here (A-03).
 * The shared package still knows nothing about audit or identity, and every
 * other service is unchanged, because none of them sets the seam.
 *
 * ## What this adds, and what it cannot do
 *
 * One `WeakMap` mark on the error the guard is about to throw, plus the trusted
 * actor and tenant that mark needs. The error's class, fields, message,
 * `internalContext` and serialisation are untouched, so the `403` the platform
 * filter builds is identical to an unmarked one. Nothing here can affect the
 * authorization decision: it runs after the decision is made, it returns
 * nothing, and the guard swallows anything it throws.
 */

const isNonBlank = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Marks the shared guard's user-token `TENANT_MISMATCH` as the
 * `AUTH_TENANT_MISMATCH` site, when it is attributable.
 *
 * Fail-closed, in the audit sense that governs this whole path: a refusal that
 * cannot be attributed exactly is left unmarked and therefore unrecorded, never
 * recorded approximately. The caller is refused either way — that decision was
 * made before this ran and nothing here revisits it.
 *
 * Every condition is checked against the seam's own trusted values:
 *
 *   - the code is exactly `TENANT_MISMATCH`, so a future refusal from the same
 *     seam is not silently recorded as this one;
 *   - the verified caller and the verified token's **active** organization are
 *     both present and non-blank — a token acting for no organization is not
 *     captured (see `AUTH_TENANT_MISMATCH`);
 *   - the roles are a real list, since they are recorded as the actor's own;
 *   - the error is not already marked, so a refusal is never counted twice or
 *     re-attributed by a second decider.
 */
export function markAuthGuardTenantMismatch(refusal: UserTenantMismatch): void {
  try {
    const { error, userId, activeOrganizationId, roles } = refusal;

    if (!(error instanceof RastaError) || error.code !== ERROR_CODES.TENANT_MISMATCH) return;
    if (!isNonBlank(userId) || !isNonBlank(activeOrganizationId)) return;
    if (!Array.isArray(roles)) return;
    if (refusalSiteOf(error) !== undefined) return;

    markGuardRefusal(error, 'AUTH_TENANT_MISMATCH', {
      userId,
      organizationId: activeOrganizationId,
      roles,
    });
  } catch {
    // Never let audit marking change or replace the refusal being thrown. The
    // shared guard swallows this too; belt and braces, on the path where a
    // thrown value would otherwise replace a deliberate 403.
  }
}

/**
 * The service's `AuthGuardOptions`, with refusal-audit observation attached.
 *
 * One function rather than an inline property at the composition root, so the
 * integration harness boots the *same* wiring the service does and cannot pass
 * while production is unobserved.
 */
export function withAuthGuardRefusalAudit(options: AuthGuardOptions): AuthGuardOptions {
  return { ...options, onUserTenantMismatch: markAuthGuardTenantMismatch };
}
