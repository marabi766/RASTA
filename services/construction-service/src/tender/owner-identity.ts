import { Inject, Injectable } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import { ProjectAccess } from '../access/access';
import { SERVICE_NAME } from '../config/env';
import { bidOpeningRefusalsTotal } from '../observability/metrics';
import { MEMBERSHIP_SOURCE } from '../tokens';
import type { LiveAnswer, MembershipSource } from './membership.client';

/** The caller as the token names them: the organization they act for, who they are, every organization they belong to. */
export interface Principal {
  organizationId: string;
  actor: string;
  organizationIds: readonly string[];
}

/** A caller identity-service has been asked about: and when (its clock) it answered. */
export interface LivePrincipal extends Principal {
  identityReadAt: Date;
}

/** Which of the owner's duties a caller is being judged for: they share every refusal but the roles. */
export type OwnerDuty = 'OPEN_BIDS' | 'EVALUATE_BIDS' | 'AWARD_TENDER';

/**
 * The owner side's judgement of who a caller is **now** (ADR-066 § 4, ADR-067 § 4), shared by
 * opening and reading bids and by evaluating them, so the two cannot drift apart.
 *
 * Identity-service's answer is authoritative for what the caller may do, and the token may only
 * narrow it, never widen it: the caller must hold a live membership of the organization they act
 * for with a role that does the duty, or they are refused — a revoked or demoted administrator
 * with a still-valid token does nothing. For the conflict of interest the two are added (the
 * stricter, a narrowing): a caller who joined a bidding organization after the token was issued
 * is a member of it here, and an organization the token claims still counts. Fails closed:
 * identity-service unreachable or answering something else is 502/504 and nothing is shown.
 */
@Injectable()
export class OwnerIdentity {
  constructor(
    private readonly access: ProjectAccess,
    @Inject(MEMBERSHIP_SOURCE) private readonly memberships: MembershipSource,
  ) {}

  /** Identity-service's word on whom a user belongs to now; anything less is a refusal, counted (a warning alert). */
  async fetchMemberships(userId: string): Promise<LiveAnswer> {
    try {
      return await this.memberships.fetchMemberships(userId);
    } catch (error) {
      bidOpeningRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'identity_unavailable' });
      throw error instanceof RastaError
        ? error
        : RastaError.upstreamUnavailable('identity-service', error);
    }
  }

  async live(principal: Principal, duty: OwnerDuty): Promise<LivePrincipal> {
    const { memberships: live, asOf } = await this.fetchMemberships(principal.actor);
    const owner = live.find((membership) => membership.organizationId === principal.organizationId);
    if (!owner) {
      throw RastaError.forbidden(
        'The caller is not a member of the organization they act for, as of now',
      );
    }
    if (duty === 'OPEN_BIDS') this.access.assertLiveRolesMayOpenBids(owner.roles);
    else if (duty === 'AWARD_TENDER') this.access.assertLiveRolesMayAward(owner.roles);
    else this.access.assertLiveRolesMayEvaluate(owner.roles);
    return {
      ...principal,
      identityReadAt: asOf,
      organizationIds: [
        ...new Set([
          ...live.map((membership) => membership.organizationId),
          ...principal.organizationIds,
        ]),
      ],
    };
  }

  /** Refuses a member of any organization that bid (withdrawn bids included) on the tender. */
  assertNoConflict(
    memberOf: readonly string[],
    bidderOrganizationIds: readonly string[],
    message = 'A member of an organization that bid on this tender does not open or read its bids',
  ): void {
    const bidders = new Set(bidderOrganizationIds);
    if (memberOf.some((organization) => bidders.has(organization))) {
      bidOpeningRefusalsTotal.inc({ service: SERVICE_NAME, reason: 'conflict_of_interest' });
      throw RastaError.forbidden(message);
    }
  }
}
