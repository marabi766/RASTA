import { z } from 'zod';

/**
 * Whether the owner of an award confirms what `TENDER_AWARDED` claims (ADR-061 § 4,
 * AGENTS.md A-13, ADR-068 § 3).
 *
 * Pure functions, so every branch that decides whether a contract is made can be proved
 * without a network or a database.
 *
 * ## What is compared, and what is simply taken from the owner
 *
 * A contract is recorded from the **owner's answer**, so every field the event also
 * states is compared: the tender, `AWARDED`, the winning bid, the winning contractor,
 * the digest of the evaluation it was awarded on, and who awarded it and when. Any
 * difference is a refusal. The amount exists only in the answer — the event never
 * carries one — and is taken from it after it has been checked to be a positive amount
 * that fits a `bigint` column.
 *
 * The project is compared like the rest: the owner's award view carries the stored
 * tender's `projectId` (construction-service #229), it is a **required** field of the
 * answer, and the contract keeps the owner's, never the event's.
 */

/** The largest value of a PostgreSQL `bigint`: a column cannot hold more. */
export const MAX_AMOUNT_MINOR = 9_223_372_036_854_775_807n;

const digest = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * What construction-service answers to `GET /v1/tenders/{id}/award`, as this service
 * reads it: declared here (no cross-service imports), required fields only. An extra
 * field is not this service's business — which is why this is not `.strict()` — while a
 * missing or malformed one makes the answer unusable (fail closed).
 */
export const awardFactSchema = z.object({
  tenderId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  status: z.string().min(1).max(64),
  bidId: z.string().min(1).max(128),
  bidderOrganizationId: z.string().min(1).max(128),
  amountMinor: z.string().regex(/^\d{1,19}$/),
  matrixDigest: digest,
  awardedAt: z.string().datetime({ offset: true }),
  awardedBy: z.string().min(1).max(128),
});

export type AwardFact = z.infer<typeof awardFactSchema>;

export type Mismatch =
  | 'tenant_mismatch'
  | 'not_found'
  | 'tender_mismatch'
  | 'project_mismatch'
  | 'status_mismatch'
  | 'bid_mismatch'
  | 'contractor_mismatch'
  | 'digest_mismatch'
  | 'awarded_by_mismatch'
  | 'awarded_at_mismatch'
  | 'amount_invalid';

export type Verdict = { confirmed: true } | { confirmed: false; mismatch: Mismatch };

const CONFIRMED: Verdict = { confirmed: true };
const refuted = (mismatch: Mismatch): Verdict => ({ confirmed: false, mismatch });

/** The award as `TENDER_AWARDED` states it (the fields this service compares). */
export interface AwardClaim {
  readonly tenderId: string;
  readonly projectId: string;
  readonly organizationId: string;
  readonly winningBidId: string;
  readonly winnerOrganizationId: string;
  readonly matrixDigest: string;
  readonly awardedBy: string;
  readonly awardedAt: string;
}

/**
 * The envelope's tenant and the payload's organization must be one and the same,
 * before anything else is asked (ADR-061 § 5).
 *
 * Both are the publisher's claim. An envelope for A whose payload names a tender in B
 * would otherwise be handled as B's: a B token minted, B's award read, and a contract
 * drafted outside the tenant the event was published for. A missing tenant is a
 * mismatch too, never a pass.
 */
export function confirmTenant(
  envelopeTenantId: string | undefined,
  claimedOrganizationId: string,
): Verdict {
  if (!envelopeTenantId || envelopeTenantId !== claimedOrganizationId) {
    return refuted('tenant_mismatch');
  }
  return CONFIRMED;
}

export function confirmAward(claim: AwardClaim, fact: AwardFact | null): Verdict {
  if (!fact) return refuted('not_found');
  if (fact.tenderId !== claim.tenderId) return refuted('tender_mismatch');
  if (fact.projectId !== claim.projectId) return refuted('project_mismatch');
  // An award is terminal: an awarded tender stays AWARDED. Anything else means the
  // award this event announces never happened.
  if (fact.status !== 'AWARDED') return refuted('status_mismatch');
  if (fact.bidId !== claim.winningBidId) return refuted('bid_mismatch');
  if (fact.bidderOrganizationId !== claim.winnerOrganizationId) {
    return refuted('contractor_mismatch');
  }
  // The winner is another organization than the owner: a contract with oneself is no contract.
  if (fact.bidderOrganizationId === claim.organizationId) return refuted('contractor_mismatch');
  if (fact.matrixDigest !== claim.matrixDigest) return refuted('digest_mismatch');
  if (fact.awardedBy !== claim.awardedBy) return refuted('awarded_by_mismatch');
  if (!sameInstant(fact.awardedAt, claim.awardedAt)) return refuted('awarded_at_mismatch');
  if (amountOf(fact) === null) return refuted('amount_invalid');
  return CONFIRMED;
}

/** The award claims a contract persists: what a redelivery is compared with (EVERY one of them). */
export interface PersistedAward {
  readonly tenderId: string;
  readonly projectId: string;
  readonly winningBidId: string;
  readonly contractorOrganizationId: string;
  readonly matrixDigest: string;
  readonly awardedBy: string;
  readonly awardedAt: Date;
}

/**
 * The claims of a redelivered `TENDER_AWARDED` that contradict the contract already drafted
 * for the tender — every persisted award claim, never a subset. Empty means the same award.
 */
export function contradictions(
  existing: PersistedAward,
  claim: Omit<AwardClaim, 'organizationId'>,
): string[] {
  const differing: string[] = [];
  if (existing.tenderId !== claim.tenderId) differing.push('tenderId');
  if (existing.projectId !== claim.projectId) differing.push('projectId');
  if (existing.winningBidId !== claim.winningBidId) differing.push('winningBidId');
  if (existing.contractorOrganizationId !== claim.winnerOrganizationId) {
    differing.push('winnerOrganizationId');
  }
  if (existing.matrixDigest !== claim.matrixDigest) differing.push('matrixDigest');
  if (existing.awardedBy !== claim.awardedBy) differing.push('awardedBy');
  if (!sameInstant(existing.awardedAt, claim.awardedAt)) differing.push('awardedAt');
  return differing;
}

/**
 * The contract amount: the owner's `amountMinor`, as a `bigint`, or `null` when it is not a
 * positive amount a `bigint` column holds. Never defaulted, rounded or guessed.
 */
export function amountOf(fact: Pick<AwardFact, 'amountMinor'>): bigint | null {
  if (!/^\d{1,19}$/.test(fact.amountMinor)) return null;
  const amount = BigInt(fact.amountMinor);
  return amount > 0n && amount <= MAX_AMOUNT_MINOR ? amount : null;
}

/** Two instants, each a date or an ISO string, are the same moment; an unparseable one is never. */
export function sameInstant(left: string | Date, right: string | Date): boolean {
  const a = typeof left === 'string' ? Date.parse(left) : left.getTime();
  const b = typeof right === 'string' ? Date.parse(right) : right.getTime();
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}
