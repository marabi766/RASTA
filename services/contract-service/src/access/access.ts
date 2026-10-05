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

@Injectable()
export class ContractAccess {
  private readonly employerReaders: readonly string[];

  constructor(@Inject(ENV) env: ContractEnv) {
    this.employerReaders = [SUPER_ROLE, ...env.CONTRACT_READER_ROLES];
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
