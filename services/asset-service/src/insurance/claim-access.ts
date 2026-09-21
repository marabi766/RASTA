import { RastaError, RolesGuard, getContext } from '@rasta/nest-common';

/**
 * Who may decide a claim, and up to what amount.
 *
 * The `@Roles` guard cannot answer this, because the answer is not in code:
 * the product document names no approval authority for insurance claims, and
 * AGENTS.md § 1 (principle 2) forbids inventing one. So the authority is
 * configuration — `INSURANCE_CLAIM_DECISION_ROLES` and
 * `INSURANCE_CLAIM_APPROVAL_CEILING_MINOR` — and this file is the one place
 * that reads it. The temporary decision and its owner are docs/24 Q-59.
 *
 * Two things this deliberately does **not** do:
 *
 *  - It does not fall through to "allowed". A caller with none of the
 *    configured roles is refused, and a caller that is not a user at all —
 *    a service token, an anonymous request — is refused before roles are
 *    even consulted. The direction is narrowing, never widening.
 *  - It does not treat the ceiling as an escalation path. Above the ceiling
 *    there is no higher authority modelled yet, so the approval is refused
 *    and says why, rather than being granted by whoever holds the role.
 */
export interface ClaimAuthority {
  readonly decisionRoles: readonly string[];
  /** `null` means no ceiling is configured. */
  readonly approvalCeilingMinor: bigint | null;
}

export function assertMayDecideClaim(authority: ClaimAuthority): void {
  const context = getContext();

  if (context.authType !== 'USER') {
    throw RastaError.forbidden('Only a signed-in user may decide an insurance claim');
  }

  // Honoured everywhere the platform checks a role (RolesGuard.SUPER_ROLE).
  if (context.roles.includes(RolesGuard.SUPER_ROLE)) return;

  const granted = authority.decisionRoles.some((role) => context.roles.includes(role));
  if (!granted) {
    throw RastaError.insufficientRole(authority.decisionRoles, context.roles);
  }
}

export function assertWithinApprovalCeiling(
  authority: ClaimAuthority,
  approvedAmountMinor: bigint | null,
): void {
  if (authority.approvalCeilingMinor === null || approvedAmountMinor === null) return;

  if (approvedAmountMinor > authority.approvalCeilingMinor) {
    throw RastaError.businessRule(
      'The approved amount is above the ceiling configured for the deciding roles; ' +
        'no higher approval authority is configured for this claim',
      {
        rule: 'CLAIM_APPROVAL_ABOVE_CEILING',
        approvedAmountMinor: approvedAmountMinor.toString(),
        ceilingMinor: authority.approvalCeilingMinor.toString(),
      },
    );
  }
}
