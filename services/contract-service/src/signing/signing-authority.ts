import { Inject, Injectable } from '@nestjs/common';
import { getContext } from '@rasta/nest-common';
import { ContractAccess, type ContractSideName } from '../access/access';
import type { ContractEnv } from '../config/env';
import type { HierarchyEvidence } from '../contract/contract.repository';
import { OrganizationDirectory } from '../organization/organization-directory';
import { UNION_ROLE, signingRoleUnder } from '../policy/policy.access';
import { PolicyRepository } from '../policy/policy.repository';
import { SIGNATURE_WORKFLOW } from '../policy/policy.state-machine';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { databaseClock, transactionNow } from '../shared/clock';
import { ENV } from '../tokens';

/** The authority a signature is accepted under, and what it rested on. */
export interface SigningAuthorityResult {
  readonly role: string;
  /** The policy that authorised the employer's side (id and version); null for the contractor's. */
  readonly policy: { id: string; version: number } | null;
  /** What the hierarchy said under a union-written policy (D-050); null otherwise. */
  readonly evidence: HierarchyEvidence | null;
}

/**
 * The caller has no authority to sign for the employer, as the policies stand: the one reason a
 * signature (of the contract, or of one of its amendments) is refused for want of authority. Thrown
 * from inside the signing transaction — which rolls back — and turned by each caller into its own
 * refusal, because what the caller must answer and audit differs (`CONTRACT_SIGNATURE_REFUSED`
 * for the contract, `CONTRACT_AUTHORITY_REFUSED` for an amendment).
 */
export class SigningAuthorityDenied extends Error {
  constructor(
    readonly reason:
      'SIGNATURE_POLICY_REQUIRED' | 'POLICY_AUTHOR_NOT_GOVERNING' | 'ROLE_NOT_PERMITTED',
    /** The policy that was in force and, for the second reason, stranded; null when there was none. */
    readonly policyId: string | null,
    /** The roles the policy in force names — what `ROLE_NOT_PERMITTED` lacked. */
    readonly requiredRoles: readonly string[] = [],
  ) {
    super('The signature was refused for want of authority');
  }
}

/**
 * Who may sign for a side of a contract — the one place that answers it, for the contract itself
 * and for each of its amendments, so the two can never disagree (CON-003 PR 3: "the same machinery").
 *
 * The contractor's is its fixed role. The employer's is read from the `contract.signature` policy
 * **in force** for the employer's organization, under the policy slot's advisory lock (after the
 * contract's row lock — the one lock order, `PolicyRepository.lockPolicySlot`), so a policy approved
 * or retired at the same moment is either entirely before the signature or entirely after it. No
 * policy in force: `SIGNATURE_POLICY_REQUIRED` — the platform never defaults to granting that
 * authority. A union-written policy keeps no authority once its union has lost the employer
 * (Q-70 (7), Q-83): asked here, of organization-service, under the lock; "could not confirm" is an
 * upstream error that rolls the caller back (fail closed), and the answer's hierarchy version is
 * what a later move is ordered against (D-050).
 */
@Injectable()
export class SigningAuthority {
  constructor(
    private readonly policies: PolicyRepository,
    private readonly directory: OrganizationDirectory,
    private readonly access: ContractAccess,
    @Inject(ENV) private readonly env: ContractEnv,
  ) {}

  /** How long a signing transaction may run: the hierarchy question's deadline and some room. */
  transactionTimeoutMs(): number {
    return this.env.CONTRACT_ORGANIZATION_REQUEST_TIMEOUT_MS + 10_000;
  }

  /**
   * The authority `side` of `contract` is signed under, judged inside the signing transaction.
   * `contractorRole` is the role the caller was shown to hold before the transaction, when the
   * side is the contractor's.
   */
  async resolve(
    tx: ExtendedPrismaClient,
    contract: { id: string; organizationId: string },
    side: ContractSideName,
    contractorRole: string | undefined,
  ): Promise<SigningAuthorityResult> {
    if (side === 'CONTRACTOR') {
      return {
        role: contractorRole ?? this.access.contractorSigningRole(),
        policy: null,
        evidence: null,
      };
    }
    await this.policies.lockPolicySlot(tx, contract.organizationId, SIGNATURE_WORKFLOW);
    const policy = await this.policies.findActivePolicyOf(
      tx,
      contract.organizationId,
      SIGNATURE_WORKFLOW,
    );
    if (!policy) throw new SigningAuthorityDenied('SIGNATURE_POLICY_REQUIRED', null);

    let evidence: HierarchyEvidence | null = null;
    if (policy.authorRole === UNION_ROLE) {
      // The instants are kept beside the version: the question's, and the latest this signature
      // could commit at, bound which signatures a move can have raced at all.
      const askedAt = await databaseClock(tx);
      const within = await this.directory.withinVersion(
        policy.authorOrganizationId,
        contract.organizationId,
      );
      if (!within) throw new SigningAuthorityDenied('POLICY_AUTHOR_NOT_GOVERNING', policy.id);
      evidence = {
        authorOrganizationId: policy.authorOrganizationId,
        hierarchyVersion: within.hierarchyVersion,
        readAt: askedAt,
        commitDeadline: new Date(
          (await transactionNow(tx)).getTime() + this.transactionTimeoutMs(),
        ),
      };
    }
    const role = signingRoleUnder(policy, getContext().roles);
    if (!role) {
      throw new SigningAuthorityDenied(
        'ROLE_NOT_PERMITTED',
        policy.id,
        policy.steps.map((step) => step.authorityRole),
      );
    }
    return { role, policy: { id: policy.id, version: policy.policyVersion }, evidence };
  }
}
