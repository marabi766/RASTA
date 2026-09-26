import { createHash } from 'node:crypto';
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

/**
 * The 64-bit key of one policy slot — the policy in force for one
 * (organization, workflow key) — for `pg_advisory_xact_lock`. Derived here,
 * from SHA-256, so it is stable across PostgreSQL versions and builds (it
 * does not depend on the server's internal hash functions), and namespaced so
 * it cannot collide with any other advisory lock this database may take.
 */
export function policySlotLockKey(organizationId: string, workflowKey: string): bigint {
  return createHash('sha256')
    .update(`construction.approval-policy-slot\u0000${organizationId}\u0000${workflowKey}`)
    .digest()
    .readBigInt64BE(0);
}

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

const POLICY_REASON =
  'an approval policy is written by a union for an organization beneath it and approved by the ' +
  'platform (Q-70 (7)); the predicate names the organization explicitly';

const AUTHORITY_REASON =
  'an approval is decided by its configured authority, which may be another organization; ' +
  'the predicate names the organization explicitly';

@Injectable()
export class ApprovalRepository {
  constructor(private readonly prisma: PrismaService) {}

  // -- policies ----------------------------------------------------------------
  //
  // A policy is written by a union for an organization beneath it, read by its
  // author, by the governed organization and by the platform administrator,
  // and approved by the platform (Q-70 (7), decided). None of those is "the
  // caller's own organization", so these queries cross the tenant guard — and
  // every one names the organization in its own predicate.

  async nextPolicyVersion(
    tx: ExtendedPrismaClient,
    organizationId: string,
    workflowKey: WorkflowKey,
  ): Promise<number> {
    const latest = await runUnscoped(POLICY_REASON, () =>
      tx.approvalPolicy.aggregate({
        where: { organizationId, workflowKey },
        _max: { policyVersion: true },
      }),
    );
    return (latest._max.policyVersion ?? 0) + 1;
  }

  async createPolicy(
    tx: ExtendedPrismaClient,
    policy: {
      id: string;
      organizationId: string;
      authorOrganizationId: string;
      authorRole: string;
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
    await runUnscoped(POLICY_REASON, async () => {
      await tx.approvalPolicy.create({
        data: {
          id: policy.id,
          organizationId: policy.organizationId,
          authorOrganizationId: policy.authorOrganizationId,
          authorRole: policy.authorRole,
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
    });
  }

  /** One policy by id, whoever's it is; the caller checks who may see it. */
  async findPolicy(
    client: ExtendedPrismaClient,
    policyId: string,
  ): Promise<PolicyWithSteps | null> {
    return runUnscoped(POLICY_REASON, () =>
      client.approvalPolicy.findFirst({ where: { id: policyId }, include: STEPS_IN_ORDER }),
    );
  }

  /**
   * The policy in force for the tenant in context — the project's
   * organization. Under the guard: only ACTIVE governs, never DRAFT, PENDING
   * or REJECTED.
   */
  async findActivePolicy(
    tx: ExtendedPrismaClient,
    workflowKey: WorkflowKey,
  ): Promise<PolicyWithSteps | null> {
    return tx.approvalPolicy.findFirst({
      where: { workflowKey, status: 'ACTIVE' },
      include: STEPS_IN_ORDER,
    });
  }

  /**
   * Serialises everything that reads the policy in force for one
   * (organization, workflow key) and then acts on that answer: opening an
   * approval round (`ApprovalService.openRound`), and putting a policy in
   * force or taking it out (`PolicyService.approve` / `retire`). Without it, a
   * round could be opened on "no policy" — or on a policy already replaced —
   * while an approval committed alongside (Codex review of #122, round 2).
   *
   * A transaction-scoped advisory lock, not a row lock: when no policy is in
   * force there is no row to lock. Released at commit or rollback. The caller
   * re-reads the policy in force **after** taking it (READ COMMITTED, so the
   * next statement sees every commit that preceded the lock).
   *
   * **Lock order, everywhere:** the project row (`ProjectRepository.lockProject`)
   * first, when the command has one, then this slot, then policy rows.
   * `approve`/`retire` take no project lock, so no cycle is possible.
   */
  async lockPolicySlot(
    tx: ExtendedPrismaClient,
    organizationId: string,
    workflowKey: WorkflowKey,
  ): Promise<void> {
    const key = policySlotLockKey(organizationId, workflowKey);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key})`;
  }

  /** The policy in force for a named organization (the platform approval swap). */
  async findActivePolicyOf(
    tx: ExtendedPrismaClient,
    organizationId: string,
    workflowKey: WorkflowKey,
  ): Promise<PolicyWithSteps | null> {
    return runUnscoped(POLICY_REASON, () =>
      tx.approvalPolicy.findFirst({
        where: { organizationId, workflowKey, status: 'ACTIVE' },
        include: STEPS_IN_ORDER,
      }),
    );
  }

  /**
   * Policies an organization governs by or wrote — or, with `organizationId`
   * null, every organization's (the platform administrator's queue).
   */
  async listPolicies(filter: {
    organizationId: string | null;
    workflowKey?: WorkflowKey;
    status?: PolicyStateName;
    cursor?: string;
    limit: number;
  }): Promise<PolicyWithSteps[]> {
    return runUnscoped(POLICY_REASON, () =>
      this.prisma.client.approvalPolicy.findMany({
        where: {
          ...(filter.organizationId !== null
            ? {
                OR: [
                  { organizationId: filter.organizationId },
                  { authorOrganizationId: filter.organizationId },
                ],
              }
            : {}),
          ...(filter.workflowKey ? { workflowKey: filter.workflowKey } : {}),
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.cursor ? { id: { lt: filter.cursor } } : {}),
        },
        include: STEPS_IN_ORDER,
        orderBy: { id: 'desc' },
        take: filter.limit + 1,
      }),
    );
  }

  /** Compare-and-set on a policy's status. Returns the rows matched: 0 or 1. */
  async transitionPolicy(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      policyId: string;
      from: PolicyStateName;
      expectedVersion?: number;
      data: Prisma.ApprovalPolicyUpdateManyMutationInput;
    },
  ): Promise<number> {
    const result = await runUnscoped(POLICY_REASON, () =>
      tx.approvalPolicy.updateMany({
        where: {
          organizationId: input.organizationId,
          id: input.policyId,
          status: input.from,
          ...(input.expectedVersion !== undefined ? { version: input.expectedVersion } : {}),
        },
        data: { ...input.data, version: { increment: 1 } },
      }),
    );
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
