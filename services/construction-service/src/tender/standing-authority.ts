import { Inject, Injectable } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import { STANDING_OF_SOURCE } from '../tokens';
import type { StandingOfOrganization, StandingOfSource } from './supplier-snapshot.client';

/** Whether a contractor may bid right now, from supplier-service's own record. */
export type AuthoritativeVerdict = 'ELIGIBLE' | 'NOT_QUALIFIED' | 'SUSPENDED';

/**
 * The verdict a standing gives: an open suspension episode wins, then the absence
 * of an approved CONTRACTING qualification; otherwise eligible. Pure.
 */
export function verdictOf(
  standing: Pick<StandingOfOrganization, 'contractingApprovedAt' | 'suspensions'>,
): AuthoritativeVerdict {
  if (standing.suspensions.some((episode) => episode.reinstatedAt === null)) return 'SUSPENDED';
  return standing.contractingApprovedAt === null ? 'NOT_QUALIFIED' : 'ELIGIBLE';
}

/**
 * Eligibility to bid is an **authoritative decision** (Codex on #170, ruled by the
 * project manager): it commits a contractor to a tender, so it is asked of the
 * service that owns the fact — supplier-service — at the moment of the bid, not of
 * a read model this service builds from a seven-day event log.
 *
 * The read model (`ContractorStandingRepository`, the consumer and the bootstrap)
 * is **advisory**: good for listing and for a UI, and wrong in two ways a decision
 * cannot tolerate. After construction-service has been down longer than the log
 * keeps, a suspension whose event expired is never seen. And a suspension committed
 * in supplier-service but not yet relayed when a snapshot page completes is not in
 * it either. Both make the read model say *eligible* when the owner says otherwise.
 * So the read model is never a source for this decision.
 *
 * Fail closed: if supplier-service cannot be reached, answers anything but a
 * well-formed 200, or answers about another organization, the decision is a 503/504
 * (`UPSTREAM_UNAVAILABLE` / `UPSTREAM_TIMEOUT`, the unavailable-standing case) and
 * nobody bids. An organization it knows nothing about is `NOT_QUALIFIED`.
 *
 * The call is made **outside** any database transaction or row lock (the caller
 * asks before it opens one): a network call under a tender lock would hold every
 * other bidder behind a slow supplier-service.
 */
@Injectable()
export class StandingAuthority {
  constructor(@Inject(STANDING_OF_SOURCE) private readonly source: StandingOfSource) {}

  async verdictFor(organizationId: string): Promise<AuthoritativeVerdict> {
    const standing = await this.source.fetchStanding(organizationId);
    if (standing.organizationId !== organizationId) {
      // An answer about somebody else is not an answer about this contractor.
      throw RastaError.upstreamUnavailable('supplier-service');
    }
    return verdictOf(standing);
  }
}
