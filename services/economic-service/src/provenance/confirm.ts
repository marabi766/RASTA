import type { MaintenanceRequestFact, UsageRecordFact } from './source-facts.client';

/**
 * Whether the owning service confirms what an event claims (ADR-061 § 4).
 *
 * Pure functions, so every branch that decides whether money is made can be
 * proved without a network or a database.
 *
 * ## What is compared, and what is simply taken from the source
 *
 * An **obligation** is recorded from the event, so every field it records is
 * compared: organization, asset, status, amount, currency, the workshop that
 * gets paid, and the approval itself (who and when). Any difference is a
 * refusal.
 *
 * A **reward** is granted from the source's values, not the event's: the
 * organization, the subject and every field a rule can read come from the
 * fact. So only the fact's identity is compared (the organization and the
 * asset), plus, for a completion, that the work really was completed. A
 * lying quantity in the payload changes nothing, because nothing reads it.
 */

export type Mismatch =
  | 'not_found'
  | 'organization_mismatch'
  | 'asset_mismatch'
  | 'status_mismatch'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'workshop_mismatch'
  | 'approval_mismatch';

export type Verdict = { confirmed: true } | { confirmed: false; mismatch: Mismatch };

const CONFIRMED: Verdict = { confirmed: true };
const refuted = (mismatch: Mismatch): Verdict => ({ confirmed: false, mismatch });

/** The approval as `MAINTENANCE_APPROVED` states it. */
export interface ApprovalClaim {
  requestId: string;
  organizationId: string;
  assetId: string;
  approvedBy: string;
  approvedAt: string;
  workshopOrganizationId?: string | null;
  totalCostMinor: string;
  currency: string;
}

export function confirmApproval(
  claim: ApprovalClaim,
  fact: MaintenanceRequestFact | null,
): Verdict {
  if (!fact) return refuted('not_found');
  if (fact.organizationId !== claim.organizationId) return refuted('organization_mismatch');
  if (fact.assetId !== claim.assetId) return refuted('asset_mismatch');
  // Approval is terminal, so an approved request stays APPROVED. Anything else
  // means the approval this event announces never happened.
  if (fact.status !== 'APPROVED') return refuted('status_mismatch');
  if (BigInt(fact.totalCostMinor) !== BigInt(claim.totalCostMinor)) {
    return refuted('amount_mismatch');
  }
  if (fact.currency !== claim.currency) return refuted('currency_mismatch');
  if ((fact.workshopOrganizationId ?? null) !== (claim.workshopOrganizationId ?? null)) {
    return refuted('workshop_mismatch');
  }
  if (fact.approvedBy !== claim.approvedBy || !sameInstant(fact.approvedAt, claim.approvedAt)) {
    return refuted('approval_mismatch');
  }
  return CONFIRMED;
}

/** Statuses in which a request's work has been completed. */
const COMPLETED_STATUSES = new Set(['COMPLETED', 'APPROVED']);

export function confirmCompletion(
  claim: { organizationId: string; assetId: string },
  fact: MaintenanceRequestFact | null,
): Verdict {
  if (!fact) return refuted('not_found');
  if (fact.organizationId !== claim.organizationId) return refuted('organization_mismatch');
  if (fact.assetId !== claim.assetId) return refuted('asset_mismatch');
  // APPROVED as well: the owner may have approved the bill before this
  // consumer caught up, and the work was completed either way.
  if (!COMPLETED_STATUSES.has(fact.status) || !fact.completedAt) {
    return refuted('status_mismatch');
  }
  return CONFIRMED;
}

export function confirmUsage(
  claim: { organizationId: string; assetId: string },
  fact: UsageRecordFact | null,
): Verdict {
  if (!fact) return refuted('not_found');
  if (fact.organizationId !== claim.organizationId) return refuted('organization_mismatch');
  if (fact.assetId !== claim.assetId) return refuted('asset_mismatch');
  return CONFIRMED;
}

/**
 * The subject a reward goes to, as the source records it.
 *
 * `SYSTEM` is what both owners write when no user acted (an import, a
 * scheduled job). Crediting "the system" would invent a subject.
 */
export function rewardSubject(recordedBy: string | null): string | null {
  if (!recordedBy || recordedBy === 'SYSTEM') return null;
  return recordedBy;
}

function sameInstant(left: string | null, right: string): boolean {
  if (!left) return false;
  const a = Date.parse(left);
  const b = Date.parse(right);
  return Number.isFinite(a) && a === b;
}
