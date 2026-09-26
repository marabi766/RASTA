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
  private readonly policySetters: readonly string[];
  private readonly policyReaders: readonly string[];

  constructor(@Inject(ENV) env: ConstructionEnv) {
    this.writers = [SUPER_ROLE, ...env.CONSTRUCTION_PROJECT_ROLES];
    this.readers = [...this.writers, ...env.CONSTRUCTION_PROJECT_READER_ROLES];
    this.policySetters = [SUPER_ROLE, ...env.CONSTRUCTION_POLICY_SETTER_ROLES];
    this.policyReaders = [...new Set([...this.readers, ...this.policySetters])];
  }

  /**
   * May the caller write approval policies for the organization they act for?
   * (`CONSTRUCTION_POLICY_SETTER_ROLES`, Q-70 reusing Q-64.) A setter writes
   * only its own organization's policies — `UNION_ADMIN` included (ADR-060).
   */
  assertCanWritePolicy(): { organizationId: string; actor: string } {
    return this.assert(this.policySetters, 'change approval policies');
  }

  assertCanReadPolicy(): { organizationId: string } {
    const { organizationId } = this.assert(this.policyReaders, 'read approval policies');
    return { organizationId };
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
      if (this.canReadProjectsOf(approval.organizationId)) {
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
    const context = getContext();
    const authority =
      context.organizationId === approval.authorityOrganizationId &&
      (context.roles.includes(approval.authorityRole) || context.roles.includes(SUPER_ROLE));
    if (authority || this.canReadProjectsOf(approval.organizationId)) return;
    throw RastaError.notFound('Approval', approval.id);
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
