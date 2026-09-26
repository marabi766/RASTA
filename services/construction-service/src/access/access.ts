import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import { ENV } from '../tokens';
import type { ConstructionEnv } from '../config/env';

/**
 * Authorization for construction-service (AGENTS.md S-02, S-03).
 *
 * ## Who, from configuration (Q-69)
 *
 * The roles that may write projects and needs, and the extra roles that may
 * only read them, come from `CONSTRUCTION_PROJECT_ROLES` and
 * `CONSTRUCTION_PROJECT_READER_ROLES`. That is why no controller carries a
 * static `@Roles(...)`: a decorator is fixed at compile time and would either
 * ignore the configuration or silently disagree with it — the reasoning Q-64
 * applied to organization policies. The routes stay closed: `AuthGuard`
 * demands a token, `RolesGuard` refuses `AUDITOR` on any handler that does not
 * name it, and this class refuses every role the configuration did not grant.
 *
 * `SYSTEM_ADMIN` is always accepted, as `RolesGuard.SUPER_ROLE` is everywhere
 * on the platform — but only while acting for an organization it selected with
 * `X-Organization-Id`. A project always belongs to exactly one organization,
 * and "all organizations" is not one.
 *
 * ## Which rows: the caller's own organization, and nothing else
 *
 * Every read and write goes through the tenant guard, so a project of another
 * organization is simply not found: the caller gets `404`, never `403`, and
 * cannot tell "missing" from "not yours" (ADR-011). {@link assertOwnProject}
 * repeats that check against the row itself, so a future unscoped query would
 * still answer 404 rather than leak. There is no parent-organization visibility
 * (Q-69, provisional).
 *
 * ## The oversight role, three times
 *
 * `AUDITOR` has aggregate access only (`docs/09` § 9.3). It is refused by
 * `RolesGuard` (no handler here names it), again by {@link assertNotAuditor}
 * even if both configured lists were edited to include it, and the
 * configuration itself refuses to start with it listed (`config/env.ts`).
 *
 * ## Service callers get nothing
 *
 * No endpoint carries `@AllowService`, so `AuthGuard` refuses a service token
 * first; this class refuses one again rather than treating an internal token as
 * a wildcard role.
 */

export const SUPER_ROLE = 'SYSTEM_ADMIN';
const OVERSIGHT_ROLE = 'AUDITOR';

/**
 * Q-70 (7), decided 2026-09-26: the union administrator writes approval
 * policies for the organizations under its union; the platform administrator
 * may write one for any organization and is the only one who puts a policy in
 * force. An organization administrator never writes its own (conflict of
 * interest). Not configurable: the owner decided it.
 */
export const UNION_ROLE = 'UNION_ADMIN';
export type PolicyAuthorRole = typeof UNION_ROLE | typeof SUPER_ROLE;

/** What the policy checks need to know about a policy. */
export interface PolicyOwnership {
  readonly id: string;
  readonly organizationId: string;
  readonly authorOrganizationId: string;
}

/** The fields every object-level check needs. */
export interface ProjectOwnership {
  readonly id: string;
  readonly organizationId: string;
}

/** What an authority check needs to know about an approval. */
export interface ApprovalAuthority {
  readonly id: string;
  readonly organizationId: string;
  readonly authorityOrganizationId: string;
  readonly authorityRole: string;
}

@Injectable()
export class ProjectAccess {
  private readonly writers: readonly string[];
  private readonly readers: readonly string[];
  private readonly policyReaders: readonly string[];

  constructor(@Inject(ENV) env: ConstructionEnv) {
    this.writers = [SUPER_ROLE, ...env.CONSTRUCTION_PROJECT_ROLES];
    this.readers = [...this.writers, ...env.CONSTRUCTION_PROJECT_READER_ROLES];
    this.policyReaders = [...new Set([...this.readers, UNION_ROLE])];
  }

  // -- approval policies (Q-70 (7), decided) ---------------------------------

  /**
   * May the caller write an approval policy, and as whom? `SYSTEM_ADMIN` or
   * `UNION_ADMIN` acting for an organization; anyone else — an organization
   * administrator included — is refused. Whether the target organization is
   * within the union is organization-service's answer, asked by the caller of
   * this method.
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
   * The platform approval: `SYSTEM_ADMIN` only, for any organization. It needs
   * no selected organization — the policy names its own.
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
    const { organizationId } = this.assert(this.policyReaders, 'read approval policies');
    return { organizationId };
  }

  /**
   * Who may see a policy: the platform administrator; its author's
   * organization (union or platform administrator acting for it); and the
   * governed organization's project readers, who need to know who approves.
   * Anyone else gets 404.
   */
  canSeePolicy(policy: PolicyOwnership): boolean {
    const context = getContext();
    if (context.authType === 'SERVICE' || context.roles.includes(OVERSIGHT_ROLE)) return false;
    if (context.roles.includes(SUPER_ROLE)) return true;
    if (
      context.organizationId === policy.authorOrganizationId &&
      context.roles.includes(UNION_ROLE)
    ) {
      return true;
    }
    return this.canReadProjectsOf(policy.organizationId);
  }

  assertCanSeePolicy(policy: PolicyOwnership): void {
    assertNotAuditor();
    assertNotServiceCaller();
    if (!this.canSeePolicy(policy)) throw RastaError.notFound('ApprovalPolicy', policy.id);
  }

  /**
   * Submitting a policy for platform approval: its author's organization
   * only, by a union or platform administrator acting for it. A caller who
   * may see the policy is told why (403); anyone else learns nothing (404).
   */
  assertCanSubmitPolicy(policy: PolicyOwnership): { actor: string; role: PolicyAuthorRole } {
    const author = this.refuseUnlessPolicyVisible(policy, () => this.assertPolicyAuthor());
    if (author.organizationId !== policy.authorOrganizationId) {
      throw RastaError.forbidden('Only the organization that wrote this policy may submit it');
    }
    return { actor: author.actor, role: author.role };
  }

  /**
   * Retiring: any platform administrator — who, like approving, needs no
   * selected organization (the policy names its own) — or a union
   * administrator acting for the organization that wrote it.
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

  /** Whether the caller reads projects of the organization they act for. */
  canReadProjectsOf(organizationId: string): boolean {
    const context = getContext();
    return (
      context.authType !== 'SERVICE' &&
      !context.roles.includes(OVERSIGHT_ROLE) &&
      context.organizationId === organizationId &&
      this.readers.some((role) => context.roles.includes(role))
    );
  }

  /**
   * The rule that keeps the platform from becoming an authority (ADR-023).
   *
   * Only a caller acting for the approval's `authorityOrganizationId` **and**
   * holding its `authorityRole` there may decide. There is no super-role
   * bypass: `SYSTEM_ADMIN` decides only if the policy named `SYSTEM_ADMIN` —
   * otherwise the platform operator would be a decision-maker nobody
   * configured.
   *
   * A caller who can already see the project is told `403` (they know it
   * exists; the decision is not theirs). Anyone else gets `404`.
   */
  assertIsAuthority(approval: ApprovalAuthority): { actor: string } {
    assertNotAuditor();
    assertNotServiceCaller();
    const context = getContext();

    const isAuthority =
      context.organizationId === approval.authorityOrganizationId &&
      context.roles.includes(approval.authorityRole);
    if (!isAuthority) {
      // A caller who may see the approval learns why; anyone else learns nothing.
      if (this.canSeeApproval(approval)) {
        throw RastaError.forbidden(
          'Only the authority this approval names may decide it; the platform decides nothing',
        );
      }
      throw RastaError.notFound('Approval', approval.id);
    }
    if (!context.userId) {
      throw RastaError.forbidden('This operation records an actor and the request names none');
    }
    return { actor: context.userId };
  }

  /** May the caller see this approval: its project's readers, or its authority. */
  assertCanSeeApproval(approval: ApprovalAuthority): void {
    assertNotAuditor();
    assertNotServiceCaller();
    if (this.canSeeApproval(approval)) return;
    throw RastaError.notFound('Approval', approval.id);
  }

  private canSeeApproval(approval: ApprovalAuthority): boolean {
    const context = getContext();
    const authority =
      context.organizationId === approval.authorityOrganizationId &&
      (context.roles.includes(approval.authorityRole) || context.roles.includes(SUPER_ROLE));
    return authority || this.canReadProjectsOf(approval.organizationId);
  }

  /** The caller's organization and roles, for the authority inbox. */
  inboxScope(): { organizationId: string; roles: readonly string[] } {
    assertNotAuditor();
    assertNotServiceCaller();
    const context = getContext();
    if (!context.organizationId) {
      throw RastaError.forbidden(
        'Select an organization with X-Organization-Id to read its approvals',
      );
    }
    return { organizationId: context.organizationId, roles: context.roles };
  }

  /**
   * May the caller create or change projects and needs in the organization
   * they act for? Returns that organization and the acting user.
   */
  assertCanWrite(): { organizationId: string; actor: string } {
    return this.assert(this.writers, 'change construction projects');
  }

  /** May the caller read projects and needs in the organization they act for? */
  assertCanRead(): { organizationId: string } {
    const { organizationId } = this.assert(this.readers, 'read construction projects');
    return { organizationId };
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
      // Reached by a SYSTEM_ADMIN token with no active tenant. Refused with a
      // reason rather than left to the tenant guard's 500.
      throw RastaError.forbidden(
        `Select an organization with X-Organization-Id to ${what}; a project belongs to exactly one`,
      );
    }

    if (!context.userId) {
      // Every change records an actor (AGENTS.md S-06) and the database refuses
      // a blank one.
      throw RastaError.forbidden('This operation records an actor and the request names none');
    }

    return { organizationId: context.organizationId, actor: context.userId };
  }
}

export function assertNotAuditor(): void {
  if (getContext().roles.includes(OVERSIGHT_ROLE)) {
    throw RastaError.forbidden(
      'The oversight role has aggregate access only and no access to individual projects',
    );
  }
}

export function assertNotServiceCaller(): void {
  if (getContext().authType === 'SERVICE') {
    throw RastaError.forbidden('No service-to-service access to construction projects is granted');
  }
}

/**
 * The row-level half of tenant isolation: `404` for any project that is not
 * the caller's organization's, whatever query produced it.
 */
export function assertOwnProject(project: ProjectOwnership, organizationId: string): void {
  if (project.organizationId !== organizationId) {
    throw RastaError.notFound('Project', project.id);
  }
}
