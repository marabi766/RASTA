import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import { SUPER_ROLE, assertNotAuditor, assertNotServiceCaller } from '../access/access';
import type { ContractEnv } from '../config/env';
import type { Prisma } from '../generated/prisma';
import { ENV } from '../tokens';

/**
 * Who writes, submits, approves and reads an approval policy (Q-70 (7), decided 2026-09-26; ADR-063;
 * ADR-068 § 5) — the rules construction-service applies to its own policies, applied here to the
 * signing policy of a contract's employer.
 *
 * A union administrator writes policies for its own organization or one beneath it; the platform
 * administrator may write one for any organization and is the only one who puts a policy in force.
 * An organization administrator never writes its own (conflict of interest). **Not configurable:**
 * the owner decided it.
 */
export const UNION_ROLE = 'UNION_ADMIN';
export type PolicyAuthorRole = typeof UNION_ROLE | typeof SUPER_ROLE;

/** What the policy checks need to know about a policy. */
export interface PolicyOwnership {
  readonly id: string;
  readonly organizationId: string;
  readonly authorOrganizationId: string;
}

/**
 * The role, among those the caller holds, under which a `contract.signature` policy accepts the
 * caller's signature for the employer — or `undefined` when none of them is named. A step counts
 * only if its authority organization is the organization the policy governs (the employer): a
 * policy row that names another organization's role (the database and the service both refuse to
 * write one) would still sign for nobody.
 */
export function signingRoleUnder(
  policy: {
    organizationId: string;
    steps: readonly { authorityOrganizationId: string; authorityRole: string }[];
  },
  heldRoles: readonly string[],
): string | undefined {
  return policy.steps.find(
    (step) =>
      step.authorityOrganizationId === policy.organizationId &&
      heldRoles.includes(step.authorityRole),
  )?.authorityRole;
}

@Injectable()
export class PolicyAccess {
  private readonly readers: readonly string[];

  constructor(@Inject(ENV) env: ContractEnv) {
    // The governed organization's own contract readers need to know who signs for it.
    this.readers = [SUPER_ROLE, ...env.CONTRACT_READER_ROLES];
  }

  /**
   * May the caller write an approval policy, and as whom? `SYSTEM_ADMIN` or `UNION_ADMIN` acting
   * for an organization; anyone else — an organization administrator included — is refused.
   * Whether the target organization is within the union is organization-service's answer, asked by
   * the caller of this method.
   */
  assertPolicyAuthor(): { organizationId: string; actor: string; role: PolicyAuthorRole } {
    const { organizationId, actor } = this.assert(
      [SUPER_ROLE, UNION_ROLE],
      'write approval policies',
    );
    const role: PolicyAuthorRole = getContext().roles.includes(SUPER_ROLE)
      ? SUPER_ROLE
      : UNION_ROLE;
    return { organizationId, actor, role };
  }

  /**
   * The platform approval: `SYSTEM_ADMIN` only, for any organization. It needs no selected
   * organization — the policy names its own.
   */
  assertPlatformAdministrator(): { actor: string } {
    assertNotAuditor();
    assertNotServiceCaller();
    const context = getContext();
    if (!context.roles.includes(SUPER_ROLE)) {
      throw RastaError.insufficientRole([SUPER_ROLE], context.roles);
    }
    if (!context.userId) {
      throw RastaError.forbidden('This operation records an actor and the request names none');
    }
    return { actor: context.userId };
  }

  /** The organization whose policies (governed or authored) a listing shows. */
  assertCanListPolicies(): { organizationId: string } {
    const { organizationId } = this.assert(
      [...new Set([...this.readers, UNION_ROLE])],
      'read approval policies',
    );
    return { organizationId };
  }

  /**
   * Who may see a policy: the platform administrator; its author's organization (union or
   * platform administrator acting for it); and the governed organization's contract readers, who
   * need to know who signs for it. Anyone else gets 404.
   */
  canSeePolicy(policy: PolicyOwnership): boolean {
    const context = getContext();
    if (context.authType === 'SERVICE' || context.roles.includes('AUDITOR')) return false;
    if (context.roles.includes(SUPER_ROLE)) return true;
    if (
      context.organizationId === policy.authorOrganizationId &&
      context.roles.includes(UNION_ROLE)
    ) {
      return true;
    }
    return (
      context.organizationId === policy.organizationId &&
      this.readers.some((role) => context.roles.includes(role))
    );
  }

  /**
   * `canSeePolicy` as a predicate on the table, for the caller: what a listing applies **in its
   * query** so that it returns exactly what a read of each row would not answer 404 to. `null`: no
   * restriction (the platform administrator). Otherwise a union administrator sees the policies its
   * own organization **wrote**, and a contract reader the policies that **govern** its own
   * organization — and nothing else: an organization administrator of the author's organization
   * who is not a `UNION_ADMIN` sees none of the policies it wrote, as the single read says. No
   * clause means no row (`OR: []` matches nothing).
   *
   * Callers have passed `assertCanListPolicies`, which refuses the oversight role and a service
   * caller, as `canSeePolicy` does.
   */
  listVisibility(): Prisma.ApprovalPolicyWhereInput | null {
    const context = getContext();
    if (context.roles.includes(SUPER_ROLE)) return null;
    const own = context.organizationId;
    const clauses: Prisma.ApprovalPolicyWhereInput[] = [];
    if (own && context.roles.includes(UNION_ROLE)) clauses.push({ authorOrganizationId: own });
    if (own && this.readers.some((role) => context.roles.includes(role))) {
      clauses.push({ organizationId: own });
    }
    return { OR: clauses };
  }

  assertCanSeePolicy(policy: PolicyOwnership): void {
    assertNotAuditor();
    assertNotServiceCaller();
    if (!this.canSeePolicy(policy)) throw RastaError.notFound('ApprovalPolicy', policy.id);
  }

  /**
   * Submitting a policy for platform approval: its author's organization only, by a union or
   * platform administrator acting for it. A caller who may see the policy is told why (403);
   * anyone else learns nothing (404).
   */
  assertCanSubmitPolicy(policy: PolicyOwnership): { actor: string; role: PolicyAuthorRole } {
    const author = this.refuseUnlessPolicyVisible(policy, () => this.assertPolicyAuthor());
    if (author.organizationId !== policy.authorOrganizationId) {
      throw RastaError.forbidden('Only the organization that wrote this policy may submit it');
    }
    return { actor: author.actor, role: author.role };
  }

  /**
   * Retiring: any platform administrator — who, like approving, needs no selected organization
   * (the policy names its own) — or a union administrator acting for the organization that wrote it.
   */
  assertCanRetirePolicy(policy: PolicyOwnership): { actor: string } {
    if (getContext().roles.includes(SUPER_ROLE)) return this.assertPlatformAdministrator();
    const author = this.refuseUnlessPolicyVisible(policy, () => this.assertPolicyAuthor());
    if (author.organizationId !== policy.authorOrganizationId) {
      throw RastaError.forbidden('Only the organization that wrote this policy may retire it');
    }
    return { actor: author.actor };
  }

  private refuseUnlessPolicyVisible<T>(policy: PolicyOwnership, check: () => T): T {
    assertNotAuditor();
    assertNotServiceCaller();
    if (!this.canSeePolicy(policy)) throw RastaError.notFound('ApprovalPolicy', policy.id);
    return check();
  }

  private assert(
    roles: readonly string[],
    what: string,
  ): { organizationId: string; actor: string } {
    assertNotAuditor();
    assertNotServiceCaller();

    const context = getContext();
    if (!roles.some((role) => context.roles.includes(role))) {
      throw RastaError.insufficientRole(roles, context.roles);
    }
    if (!context.organizationId) {
      // Reached by a SYSTEM_ADMIN token with no active tenant. Refused with a reason rather than
      // left to the tenant guard's 500.
      throw RastaError.forbidden(
        `Select an organization with X-Organization-Id to ${what}; a policy is written by exactly one`,
      );
    }
    if (!context.userId) {
      // Every change records an actor (AGENTS.md S-06) and the database refuses a blank one.
      throw RastaError.forbidden('This operation records an actor and the request names none');
    }
    return { organizationId: context.organizationId, actor: context.userId };
  }
}
