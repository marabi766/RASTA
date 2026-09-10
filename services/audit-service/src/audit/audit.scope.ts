import { RastaError } from '@rasta/nest-common';
import type { AuditCallerAuthority } from '../access/access';
import { auditSubtreeDecisionsTotal, SUBTREE_DECISIONS } from '../observability/metrics';

/**
 * Turning a subtree caller's authority and their requested target into exactly
 * one organization — or into a refusal.
 *
 * Extracted from `AuditQueryService` when AUD-003 added a third endpoint that
 * has to make the identical decision. Two copies of an authorization rule is
 * two places for it to drift, and the direction it drifts in matters: the
 * fail-closed half of this rule is a single `if` that a well-meaning edit could
 * remove from one copy while the tests for the other keep passing.
 *
 * ## The rule, and why it always resolves to one organization
 *
 *   no `organizationId`       the caller's own organization, exactly. Not the
 *                             subtree — the token names one organization, and
 *                             widening a silent default is how a convenience
 *                             becomes a disclosure.
 *   `organizationId` = own    the same, without consulting the projection.
 *   `organizationId` = other  allowed only if the local hierarchy projection
 *                             proves it is a descendant; otherwise `403`.
 *
 * Authority over the caller's **own** organization comes from the verified
 * token and never from the projection, so an empty or lagging projection
 * degrades a union administrator to their own organization — a missing result,
 * never an extra one. The projection is consulted only to *extend* authority,
 * and it extends nothing it cannot prove (ADR-053 § 10).
 */

/** The one repository capability this decision needs. */
export interface SubtreeOracle {
  isWithinProjectedSubtree(
    rootOrganizationId: string,
    targetOrganizationId: string,
  ): Promise<boolean>;
}

export async function resolveSubtreeTarget(
  oracle: SubtreeOracle,
  authority: AuditCallerAuthority,
  requestedOrganizationId: string | undefined,
): Promise<string> {
  const root = authority.rootOrganizationId as string;
  const target = requestedOrganizationId ?? root;

  if (target === root) {
    auditSubtreeDecisionsTotal.inc({ decision: SUBTREE_DECISIONS.OWN_ORGANIZATION });
    return root;
  }

  if (await oracle.isWithinProjectedSubtree(root, target)) {
    auditSubtreeDecisionsTotal.inc({ decision: SUBTREE_DECISIONS.DESCENDANT });
    return target;
  }

  auditSubtreeDecisionsTotal.inc({ decision: SUBTREE_DECISIONS.REFUSED });
  // The same refusal whether the organization is a sibling, a stranger, one
  // that has moved out, or one this service holds no projection for. Telling
  // them apart would let a caller map the hierarchy by probing identifiers.
  throw RastaError.forbidden(
    'That organization is not within the subtree this request is authorised for',
  );
}
