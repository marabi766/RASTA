import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import { ENV } from '../tokens';
import type { ContractEnv } from '../config/env';

/**
 * Authorization for contract-service (AGENTS.md S-02, S-03; ADR-068 § 7).
 *
 * ## Two parties, nobody else
 *
 * A contract is read by **the employer's organization** (the tender's owner — the
 * contract's tenant) and by **the winning contractor's organization**. Any other
 * organization finds it `404`, never `403`, and cannot tell "missing" from "not yours"
 * (ADR-011). There is no parent-organization visibility and no service caller.
 *
 * ## Who, from configuration
 *
 * The employer's readers come from `CONTRACT_READER_ROLES` (Q-95), so no controller
 * carries a static `@Roles(...)`: a decorator is fixed at compile time and would
 * either ignore the configuration or silently disagree with it — the reasoning Q-64
 * applied to organization policies. The routes stay closed: `AuthGuard` demands a
 * token, `RolesGuard` refuses `AUDITOR` on any handler that does not name it, and this
 * class refuses every role the configuration did not grant.
 *
 * `SYSTEM_ADMIN` is accepted on the employer's side, as `RolesGuard.SUPER_ROLE` is
 * everywhere on the platform — but only while acting for an organization it selected
 * with `X-Organization-Id`: a contract has exactly one employer, and "all
 * organizations" is not one. It never acts as a contractor.
 *
 * ## The oversight role, three times
 *
 * `AUDITOR` has aggregate access only (`docs/09` § 9.3). It is refused by `RolesGuard`
 * (no handler here names it), again by {@link assertNotAuditor} even if the
 * configuration were edited to include it, and the configuration refuses to start
 * with it listed (`config/env.ts`).
 */

export const SUPER_ROLE = 'SYSTEM_ADMIN';
/** The winning contractor's role in its own organization (ADR-060, ADR-068 § 7). */
export const CONTRACTOR_ROLE = 'CONTRACTOR';
const OVERSIGHT_ROLE = 'AUDITOR';

/** Which of the two parties the caller acts as, for the organization the request is for. */
export interface ReadingParties {
  /** The organization the request acts for (the token's, signed). */
  readonly organizationId: string;
  /** May read the contracts this organization is the employer of. */
  readonly employer: boolean;
  /** May read the contracts this organization is the winning contractor of. */
  readonly contractor: boolean;
}

export type ContractSideName = 'EMPLOYER' | 'CONTRACTOR';

/** Who is acting on a contract: the organization the signed token names, and nothing else. */
export interface Acting {
  readonly organizationId: string;
}

/**
 * Which side of `contract` the organization is, or `null` when it is neither. The two are never
 * one organization (`ck_contract_parties_distinct`).
 */
export function sideOf(
  contract: { organizationId: string; contractorOrganizationId: string },
  organizationId: string,
): ContractSideName | null {
  if (contract.organizationId === organizationId) return 'EMPLOYER';
  if (contract.contractorOrganizationId === organizationId) return 'CONTRACTOR';
  return null;
}

@Injectable()
export class ContractAccess {
  private readonly employerReaders: readonly string[];
  private readonly cancellers: readonly string[];
  private readonly amenders: readonly string[];
  private readonly planners: readonly string[];

  constructor(@Inject(ENV) env: ContractEnv) {
    this.employerReaders = [SUPER_ROLE, ...env.CONTRACT_READER_ROLES];
    this.cancellers = env.CONTRACT_CANCEL_ROLES;
    this.amenders = env.CONTRACT_AMENDMENT_ROLES;
    this.planners = env.CONTRACT_MILESTONE_ROLES;
  }

  /**
   * The caller of a command (`sign`, `cancel`): a signed-in person acting for an organization.
   * Not the oversight role, not a service, and **never the platform administrator** — whatever
   * else the token holds, the operator does not accept or end a contract for a party (Q-95 (1)).
   * Which party, and whether that party's roles suffice, is judged after the contract is found
   * and the caller shown to be a party to it: another organization's caller is told `404`, not
   * which roles it lacked.
   */
  assertCanCommand(): Acting {
    assertNotAuditor();
    assertNotServiceCaller();
    const context = getContext();
    if (context.roles.includes(SUPER_ROLE)) {
      throw RastaError.forbidden(
        'The platform administrator does not sign or cancel a contract for a party',
      );
    }
    if (!context.organizationId) {
      throw RastaError.forbidden('A contract is signed or cancelled for an organization');
    }
    return { organizationId: context.organizationId };
  }

  /**
   * The caller of a command on a contract's amendments and milestones (CON-003 PR 3): the same
   * person-for-an-organization as {@link assertCanCommand}, and never the platform administrator —
   * the operator neither proposes, signs nor plans for a party.
   */
  assertCanCommandAmendments(): Acting {
    assertNotAuditor();
    assertNotServiceCaller();
    const context = getContext();
    if (context.roles.includes(SUPER_ROLE)) {
      throw RastaError.forbidden(
        'The platform administrator does not amend a contract or plan its milestones for a party',
      );
    }
    if (!context.organizationId) {
      throw RastaError.forbidden('A contract is amended for an organization');
    }
    return { organizationId: context.organizationId };
  }

  /**
   * The contractor's signing role: the `CONTRACTOR` role of its own organization, which is not
   * configurable (Q-95 (1)). The employer's side has no role here: who signs for it is the
   * `contract.signature` policy of the employer's organization (`employerSigningRole`), read
   * under the contract's lock — never a service-wide list, which would let one role sign for
   * every employer.
   */
  contractorSigningRole(): string {
    const roles = getContext().roles;
    if (!roles.includes(CONTRACTOR_ROLE)) {
      throw RastaError.insufficientRole([CONTRACTOR_ROLE], roles);
    }
    return CONTRACTOR_ROLE;
  }

  /** Only the employer cancels, with a role `CONTRACT_CANCEL_ROLES` names (Q-95 (4)). */
  assertMayCancel(side: ContractSideName): void {
    if (side !== 'EMPLOYER') {
      throw RastaError.forbidden('Only the employer cancels a draft contract');
    }
    const roles = getContext().roles;
    if (!this.cancellers.some((role) => roles.includes(role))) {
      throw RastaError.insufficientRole(this.cancellers, roles);
    }
  }

  /**
   * Whether the caller holds a role `CONTRACT_AMENDMENT_ROLES` names — the employer's people who
   * propose an amendment (CON-003 PR 3). Only the employer proposes; whether the caller acts for
   * the employer is judged by the caller, after the contract is found.
   */
  mayProposeAmendment(): boolean {
    const roles = getContext().roles;
    return this.amenders.some((role) => roles.includes(role));
  }

  /** The roles that propose an amendment, for the refusal that names what was lacking. */
  amendmentRoles(): readonly string[] {
    return this.amenders;
  }

  /** Whether the caller holds a role `CONTRACT_MILESTONE_ROLES` names (plans and edits milestones). */
  mayPlanMilestones(): boolean {
    const roles = getContext().roles;
    return this.planners.some((role) => roles.includes(role));
  }

  milestoneRoles(): readonly string[] {
    return this.planners;
  }

  /**
   * Whether the caller is a member of the employer's **and** the contractor's organization: one
   * person is never both parties, so the service refuses such a caller whichever side they act
   * for. Judged on the memberships the identity provider signed, never on the tenant the caller
   * selects.
   */
  isMemberOfBothParties(contract: {
    organizationId: string;
    contractorOrganizationId: string;
  }): boolean {
    const memberships = getContext().organizationIds;
    return (
      memberships.includes(contract.organizationId) &&
      memberships.includes(contract.contractorOrganizationId)
    );
  }

  /**
   * May the caller read contracts, and as which party? The answer is the organization
   * the request acts for and the sides it may read; a caller who qualifies as neither is
   * refused (`403`), one who qualifies as both reads both.
   */
  assertCanRead(): ReadingParties {
    assertNotAuditor();
    assertNotServiceCaller();

    const context = getContext();
    const roles = context.roles;
    const employer = this.employerReaders.some((role) => roles.includes(role));
    // The platform administrator is not a contractor, whatever else the token says
    // (the bidder-side rule of construction-service).
    const contractor = roles.includes(CONTRACTOR_ROLE) && !roles.includes(SUPER_ROLE);

    if (!employer && !contractor) {
      throw RastaError.insufficientRole([...this.employerReaders, CONTRACTOR_ROLE], roles);
    }
    if (!context.organizationId) {
      // Reached by a SYSTEM_ADMIN token with no active tenant. Refused with a reason
      // rather than left to the tenant guard's 500.
      throw RastaError.forbidden(
        'Select an organization with X-Organization-Id to read contracts; a contract has exactly one employer',
      );
    }
    return { organizationId: context.organizationId, employer, contractor };
  }
}

export function assertNotAuditor(): void {
  if (getContext().roles.includes(OVERSIGHT_ROLE)) {
    throw RastaError.forbidden(
      'The oversight role has aggregate access only and no access to individual contracts',
    );
  }
}

export function assertNotServiceCaller(): void {
  if (getContext().authType === 'SERVICE') {
    throw RastaError.forbidden('No service-to-service access to contracts is granted');
  }
}

/**
 * The row-level half of tenant isolation: `404` for any contract the caller is neither
 * the employer nor the winning contractor of, whatever query produced it.
 */
export function assertPartyOf(
  contract: { id: string; organizationId: string; contractorOrganizationId: string },
  parties: ReadingParties,
): void {
  const asEmployer = parties.employer && contract.organizationId === parties.organizationId;
  const asContractor =
    parties.contractor && contract.contractorOrganizationId === parties.organizationId;
  if (!asEmployer && !asContractor) {
    throw RastaError.notFound('Contract', contract.id);
  }
}
