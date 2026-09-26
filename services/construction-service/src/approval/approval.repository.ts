import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import type { Approval, ApprovalPolicy, ApprovalPolicyStep, Prisma } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { ApprovalStateName, PolicyStateName, WorkflowKey } from './approval.state-machine';
import type { ProjectStateName } from '../project/project.state-machine';

/**
 * Reads and writes of approval policies and approvals.
 *
 * ## Two populations, and where the tenant guard is crossed
 *
 * The **project's organization** writes policies and opens rounds; those
 * queries stay under the tenant guard like every other in this service.
 *
 * The **authority** that decides a step may belong to another organization —
 * the policy writer chose it (Q-70). Its queries cannot run under the guard,
 * which would rewrite every predicate with the authority's organization and
 * find nothing. So each authority-side method runs under `runUnscoped` with a
 * written reason **and names the organization explicitly in its own
 * predicate**: the approval's own `organization_id` for a write, and
 * `authority_organization_id = <the caller's organization>` for the inbox.
 * No method here reads or writes a row without an organization predicate.
 *
 * What contains the crossing is the object-level check the service makes
 * first (`assertIsAuthority`), not the query.
 */

export type PolicyWithSteps = ApprovalPolicy & { steps: ApprovalPolicyStep[] };

export interface StepInput {
  id: string;
  stepOrder: number;
  approvalType: string;
  authorityOrganizationId: string;
  authorityRole: string;
  authorityLabel: string;
  minAmountMinor: bigint | null;
  maxAmountMinor: bigint | null;
}

export interface ApprovalInput {
  id: string;
  organizationId: string;
  projectId: string;
  workflowKey: WorkflowKey;
  round: number;
  stepOrder: number;
  policyId: string;
  policyVersion: number;
  approvalType: string;
  authorityOrganizationId: string;
  authorityRole: string;
  authorityLabel: string;
  status: 'PENDING' | 'QUEUED';
  requestedAt: Date | null;
  createdAt: Date;
  createdCorrelationId: string;
}

export interface ProjectBrief {
  title: string;
  operationType: string;
  estimatedCostMinor: bigint | null;
  status: string;
}

const STEPS_IN_ORDER = {
  steps: { orderBy: { stepOrder: 'asc' } },
} satisfies Prisma.ApprovalPolicyInclude;

const AUTHORITY_REASON =
  'an approval is decided by its configured authority, which may be another organization; ' +
  'the predicate names the organization explicitly';

@Injectable()
export class ApprovalRepository {
  constructor(private readonly prisma: PrismaService) {}

  // -- policies (the writer's own organization, under the guard) -------------

  async nextPolicyVersion(tx: ExtendedPrismaClient, workflowKey: WorkflowKey): Promise<number> {
    const latest = await tx.approvalPolicy.aggregate({
      where: { workflowKey },
      _max: { policyVersion: true },
    });
    return (latest._max.policyVersion ?? 0) + 1;
  }

  async createPolicy(
    tx: ExtendedPrismaClient,
    policy: {
      id: string;
      organizationId: string;
      workflowKey: WorkflowKey;
      policyVersion: number;
      label: string;
      rationale: string;
      isSample: boolean;
      actor: string;
      correlationId: string;
      at: Date;
    },
    steps: StepInput[],
  ): Promise<void> {
    await tx.approvalPolicy.create({
      data: {
        id: policy.id,
        organizationId: policy.organizationId,
        workflowKey: policy.workflowKey,
        policyVersion: policy.policyVersion,
        status: 'DRAFT',
        label: policy.label,
        rationale: policy.rationale,
        isSample: policy.isSample,
        createdAt: policy.at,
        createdBy: policy.actor,
        createdCorrelationId: policy.correlationId,
      },
    });
    await tx.approvalPolicyStep.createMany({
      data: steps.map((step) => ({
        ...step,
        organizationId: policy.organizationId,
        policyId: policy.id,
      })),
    });
  }

  async findPolicy(
    client: ExtendedPrismaClient,
    policyId: string,
  ): Promise<PolicyWithSteps | null> {
    return client.approvalPolicy.findFirst({ where: { id: policyId }, include: STEPS_IN_ORDER });
  }

  async findActivePolicy(
    tx: ExtendedPrismaClient,
    workflowKey: WorkflowKey,
  ): Promise<PolicyWithSteps | null> {
    return tx.approvalPolicy.findFirst({
      where: { workflowKey, status: 'ACTIVE' },
      include: STEPS_IN_ORDER,
    });
  }

  async listPolicies(filter: {
    workflowKey?: WorkflowKey;
    status?: PolicyStateName;
    cursor?: string;
    limit: number;
  }): Promise<PolicyWithSteps[]> {
    return this.prisma.client.approvalPolicy.findMany({
      where: {
        ...(filter.workflowKey ? { workflowKey: filter.workflowKey } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.cursor ? { id: { lt: filter.cursor } } : {}),
      },
      include: STEPS_IN_ORDER,
      orderBy: { id: 'desc' },
      take: filter.limit + 1,
    });
  }

  /** Compare-and-set on a policy's status. Returns the rows matched: 0 or 1. */
  async transitionPolicy(
    tx: ExtendedPrismaClient,
    input: {
      policyId: string;
      from: PolicyStateName;
      expectedVersion?: number;
      data: Prisma.ApprovalPolicyUpdateManyMutationInput;
    },
  ): Promise<number> {
    const result = await tx.approvalPolicy.updateMany({
      where: {
        id: input.policyId,
        status: input.from,
        ...(input.expectedVersion !== undefined ? { version: input.expectedVersion } : {}),
      },
      data: { ...input.data, version: { increment: 1 } },
    });
    return result.count;
  }

  // -- approvals: the project's organization, under the guard ----------------

  async createApprovals(tx: ExtendedPrismaClient, rows: ApprovalInput[]): Promise<void> {
    await tx.approval.createMany({ data: rows });
  }

  async listForProject(
    projectId: string,
    filter: { workflowKey?: WorkflowKey; round?: number },
  ): Promise<Approval[]> {
    return this.prisma.client.approval.findMany({
      where: {
        projectId,
        ...(filter.workflowKey ? { workflowKey: filter.workflowKey } : {}),
        ...(filter.round ? { round: filter.round } : {}),
      },
      orderBy: [{ round: 'asc' }, { stepOrder: 'asc' }],
    });
  }

  // -- approvals: the authority side, explicit organization predicates -------

  /** Locates an approval by id alone, so the caller can be checked against it. */
  async findApproval(client: ExtendedPrismaClient, approvalId: string): Promise<Approval | null> {
    return runUnscoped(
      'an approval is located before deciding whether the caller is its authority or its project',
      () => client.approval.findUnique({ where: { id: approvalId } }),
    );
  }

  /** The authority's inbox: steps addressed to its organization and one of its roles. */
  async inbox(filter: {
    authorityOrganizationId: string;
    roles: readonly string[];
    status: ApprovalStateName;
    cursor?: string;
    limit: number;
  }): Promise<Approval[]> {
    return runUnscoped(AUTHORITY_REASON, () =>
      this.prisma.client.approval.findMany({
        where: {
          authorityOrganizationId: filter.authorityOrganizationId,
          authorityRole: { in: [...filter.roles] },
          status: filter.status,
          ...(filter.cursor ? { id: { lt: filter.cursor } } : {}),
        },
        orderBy: { id: 'desc' },
        take: filter.limit + 1,
      }),
    );
  }

  /** Compare-and-set on one approval, within the organization that owns it. */
  async transitionApproval(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      approvalId: string;
      from: ApprovalStateName;
      expectedVersion?: number;
      data: Prisma.ApprovalUpdateManyMutationInput;
    },
  ): Promise<number> {
    const result = await runUnscoped(AUTHORITY_REASON, () =>
      tx.approval.updateMany({
        where: {
          organizationId: input.organizationId,
          id: input.approvalId,
          status: input.from,
          ...(input.expectedVersion !== undefined ? { version: input.expectedVersion } : {}),
        },
        data: { ...input.data, version: { increment: 1 } },
      }),
    );
    return result.count;
  }

  /** The next undecided step of a round, if any. */
  async nextQueued(
    tx: ExtendedPrismaClient,
    scope: { organizationId: string; projectId: string; workflowKey: string; round: number },
  ): Promise<Approval | null> {
    return runUnscoped(AUTHORITY_REASON, () =>
      tx.approval.findFirst({
        where: { ...scope, status: 'QUEUED' },
        orderBy: { stepOrder: 'asc' },
      }),
    );
  }

  /** Ends a round: every undecided step of it becomes SUPERSEDED. */
  async supersedeOpen(
    tx: ExtendedPrismaClient,
    scope: { organizationId: string; projectId: string; workflowKey?: string },
    at: Date,
  ): Promise<number> {
    const result = await runUnscoped(AUTHORITY_REASON, () =>
      tx.approval.updateMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          ...(scope.workflowKey ? { workflowKey: scope.workflowKey } : {}),
          status: { in: ['QUEUED', 'PENDING'] },
        },
        data: { status: 'SUPERSEDED', supersededAt: at, version: { increment: 1 } },
      }),
    );
    return result.count;
  }

  async hasPending(
    tx: ExtendedPrismaClient,
    scope: { organizationId: string; projectId: string; workflowKey: string },
  ): Promise<boolean> {
    const count = await runUnscoped(AUTHORITY_REASON, () =>
      tx.approval.count({ where: { ...scope, status: 'PENDING' } }),
    );
    return count > 0;
  }

  /** What an authority sees of the project it is asked about. */
  async projectBrief(
    client: ExtendedPrismaClient,
    organizationId: string,
    projectId: string,
  ): Promise<ProjectBrief | null> {
    return runUnscoped(AUTHORITY_REASON, () =>
      client.project.findFirst({
        where: { organizationId, id: projectId },
        select: { title: true, operationType: true, estimatedCostMinor: true, status: true },
      }),
    );
  }

  /**
   * Moves the project when a round ends, on behalf of the authority that ended
   * it. The project row is already locked by the caller; the compare-and-set
   * still names the organization, the expected status and the version.
   */
  async transitionProjectForRound(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      projectId: string;
      from: ProjectStateName;
      to: ProjectStateName;
      expectedVersion: number;
      reason: string | null;
      actor: string;
      at: Date;
    },
  ): Promise<number> {
    const result = await runUnscoped(AUTHORITY_REASON, () =>
      tx.project.updateMany({
        where: {
          organizationId: input.organizationId,
          id: input.projectId,
          status: input.from,
          version: input.expectedVersion,
        },
        data: {
          status: input.to,
          statusReason: input.reason,
          statusChangedAt: input.at,
          statusChangedBy: input.actor,
          updatedAt: input.at,
          updatedBy: input.actor,
          version: { increment: 1 },
        },
      }),
    );
    return result.count;
  }
}
