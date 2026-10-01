import { TOTAL_WEIGHT_BP } from './criteria.dto';

/**
 * Whether a DRAFT tender may be published (ADR-065 § 1, docs/08 § 8.3 guards).
 *
 * A pure function of what the service has read under the tender's lock, so the
 * rule is testable without a database and every reason is a fixed code, not a
 * sentence — the response names the codes, and nothing about the tender's text
 * reaches an error. All reasons are reported at once: an owner fixing a draft
 * should not need one round trip per mistake.
 *
 * The approval gate (`tender.publication`, Q-84) is a fact like the rest and fails
 * **closed**: no active policy refuses with `APPROVAL_POLICY_REQUIRED`, and while
 * the approval round is not wired (PR 11) a policy in force still refuses with
 * `APPROVAL_REQUIRED` — publishing never goes ahead on an approval nobody gave.
 * Not here: who may publish (the service's authorization).
 */

export const PUBLICATION_REFUSALS = [
  /** `procurementNature` is the owner's to choose and is never defaulted (Q-03). */
  'NATURE_REQUIRED',
  'VISIBILITY_REQUIRED',
  'WINDOW_REQUIRED',
  /** The bidding period is shorter than the configured minimum (Q-84 (3); default 0). */
  'WINDOW_TOO_SHORT',
  /** `bid_closing_at` is not after the database's clock now: nobody could bid. */
  'WINDOW_ALREADY_CLOSED',
  'CRITERIA_REQUIRED',
  /** The weights must sum to exactly 10000 basis points (ADR-067 § 1). */
  'CRITERIA_WEIGHTS_INCOMPLETE',
  /** A restricted tender with nobody invited can receive no bid (Q-84 (2)). */
  'INVITATION_REQUIRED',
  /** No active `tender.publication` approval policy: nothing may be published (Q-84, fail closed). */
  'APPROVAL_POLICY_REQUIRED',
  /** A policy is in force but no approval round has granted this publication (round wiring: PR 11). */
  'APPROVAL_REQUIRED',
] as const;

export type PublicationRefusal = (typeof PUBLICATION_REFUSALS)[number];

export interface PublicationFacts {
  readonly procurementNature: string | null;
  readonly visibility: 'PUBLIC' | 'RESTRICTED' | null;
  readonly bidOpeningAt: Date | null;
  readonly bidClosingAt: Date | null;
  /** The database's clock, taken after the tender row was locked. */
  readonly now: Date;
  readonly minBiddingPeriodSeconds: number;
  readonly criteriaCount: number;
  readonly totalWeightBp: number;
  readonly invitationCount: number;
  /**
   * The approval gate: `NO_POLICY` (none in force), `NOT_GRANTED` (a policy is in
   * force and no round has approved this publication), or `GRANTED`. Until PR 11
   * only the internal `publishApproved` path says `GRANTED`.
   */
  readonly approval: 'NO_POLICY' | 'NOT_GRANTED' | 'GRANTED';
}

export function publicationRefusals(facts: PublicationFacts): PublicationRefusal[] {
  const refusals: PublicationRefusal[] = [];

  if (facts.procurementNature === null) refusals.push('NATURE_REQUIRED');
  if (facts.visibility === null) refusals.push('VISIBILITY_REQUIRED');

  if (facts.bidOpeningAt === null || facts.bidClosingAt === null) {
    refusals.push('WINDOW_REQUIRED');
  } else {
    const periodMs = facts.bidClosingAt.getTime() - facts.bidOpeningAt.getTime();
    if (periodMs < facts.minBiddingPeriodSeconds * 1000) refusals.push('WINDOW_TOO_SHORT');
    // Half-open, like the deadline itself (ADR-065 § 2): a window that closes at
    // this very instant has already closed.
    if (facts.bidClosingAt.getTime() <= facts.now.getTime()) refusals.push('WINDOW_ALREADY_CLOSED');
  }

  if (facts.criteriaCount === 0) {
    refusals.push('CRITERIA_REQUIRED');
  } else if (facts.totalWeightBp !== TOTAL_WEIGHT_BP) {
    refusals.push('CRITERIA_WEIGHTS_INCOMPLETE');
  }

  if (facts.visibility === 'RESTRICTED' && facts.invitationCount === 0) {
    refusals.push('INVITATION_REQUIRED');
  }

  if (facts.approval === 'NO_POLICY') refusals.push('APPROVAL_POLICY_REQUIRED');
  else if (facts.approval === 'NOT_GRANTED') refusals.push('APPROVAL_REQUIRED');

  return refusals;
}
