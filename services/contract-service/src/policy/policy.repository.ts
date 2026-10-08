import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import type { ApprovalPolicy, ApprovalPolicyStep, Prisma } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { StoredIdentity } from '../shared/stable-actor';
import type { PolicyStateName, WorkflowKey } from './policy.state-machine';

/**
 * Reads and writes of approval policies.
 *
 * ## Where the tenant guard is crossed
 *
 * A policy is written by a union for an organization beneath it, read by its author, by the
 * governed organization and by the platform administrator, and approved by the platform
 * (Q-70 (7), decided). None of those is "the caller's own organization", so every query here
 * crosses the tenant guard under `runUnscoped` with a written reason — **and every one names the
 * organization in its own predicate**. What contains the crossing is the object-level check the
 * service makes first (`PolicyAccess`), not the query.
 */

export type PolicyWithSteps = ApprovalPolicy & { steps: ApprovalPolicyStep[] };

/**
 * The 64-bit key of one policy slot — the policy in force for one (organization, workflow key) —
 * for `pg_advisory_xact_lock`. Derived here, from SHA-256, so it is stable across PostgreSQL
 * versions and builds, and namespaced so it cannot collide with any other advisory lock this
 * database may take.
 */
export function policySlotLockKey(organizationId: string, workflowKey: string): bigint {
  return createHash('sha256')
    .update(`contract.approval-policy-slot\u0000${organizationId}\u0000${workflowKey}`)
    .digest()
    .readBigInt64BE(0);
}

export interface StepInput {
  id: string;
  stepOrder: number;
  authorityOrganizationId: string;
  authorityRole: string;
  authorityLabel: string;
}

const STEPS_IN_ORDER = {
  steps: { orderBy: { stepOrder: 'asc' } },
} satisfies Prisma.ApprovalPolicyInclude;

const POLICY_REASON =
  'an approval policy is written by a union for an organization beneath it and approved by the ' +
  'platform (Q-70 (7)); the predicate names the organization explicitly';

@Injectable()
export class PolicyRepository {
  constructor(private readonly prisma: PrismaService) {}

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
      /** The author's stable identity (#188), both or neither: what the four-eyes check compares. */
      actorIdentity: StoredIdentity;
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
          createdByIssuer: policy.actorIdentity.issuer,
          createdBySubject: policy.actorIdentity.subject,
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
   * Serialises everything that reads the policy in force for one (organization, workflow key) and
   * then acts on that answer: a signature (`ContractService.sign`), and putting a policy in force
   * or taking it out (`PolicyService.approve` / `retire`). Without it, a signature could be
   * recorded under a policy already replaced while the replacement committed alongside.
   *
   * A transaction-scoped advisory lock, not a row lock: when no policy is in force there is no
   * row to lock. Released at commit or rollback. The caller re-reads the policy in force **after**
   * taking it (READ COMMITTED, so the next statement sees every commit that preceded the lock).
   *
   * **Lock order, everywhere:** the contract row (`ContractRepository.lockContract`) first, when
   * the command has one, then this slot, then policy rows. `approve`/`retire` take no contract
   * lock, so no cycle is possible.
   */
  async lockPolicySlot(
    tx: ExtendedPrismaClient,
    organizationId: string,
    workflowKey: WorkflowKey,
  ): Promise<void> {
    const key = policySlotLockKey(organizationId, workflowKey);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key})`;
  }

  /** The policy in force for a named organization (a signature, and the platform approval swap). */
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
   * Every ACTIVE, PENDING_PLATFORM_APPROVAL or SUSPENDED policy a union wrote for an organization
   * other than its own, across all tenants — the ones an ORGANIZATION_MOVED can strand (Q-83). A
   * pending one is listed because approval can activate it after the move (see
   * `PolicySuspensionService`). A suspended one is listed because a signing-time check may have
   * suspended it before the move's event arrived, and a signature that raced that very move still
   * rests on it: the task reaches `suspend`, which flags those signatures (D-050) and changes
   * nothing else about a policy already out of force.
   * Nothing but identifiers is read, and the caller acts on each in the tenant that row names. A
   * union's policy for itself needs no hierarchy, and a platform administrator's is never stranded
   * by a move.
   */
  async listUnionPoliciesToReconfirm(): Promise<
    {
      id: string;
      organizationId: string;
      authorOrganizationId: string;
      workflowKey: WorkflowKey;
      policyVersion: number;
    }[]
  > {
    const rows = await runUnscoped(
      'an organization move re-confirms every union-written policy in force, in any tenant (Q-83)',
      () =>
        this.prisma.client.approvalPolicy.findMany({
          where: {
            status: { in: ['ACTIVE', 'PENDING_PLATFORM_APPROVAL', 'SUSPENDED'] },
            authorRole: 'UNION_ADMIN',
          },
          select: {
            id: true,
            organizationId: true,
            authorOrganizationId: true,
            workflowKey: true,
            policyVersion: true,
          },
          orderBy: { id: 'asc' },
        }),
    );
    return rows
      .filter((row) => row.authorOrganizationId !== row.organizationId)
      .map((row) => ({ ...row, workflowKey: row.workflowKey as WorkflowKey }));
  }

  /**
   * Policies an organization governs by or wrote — or, with `organizationId` null, every
   * organization's (the platform administrator's queue). `visibleTo` is the object-level read rule
   * (`PolicyAccess.listVisibility`) as a predicate, applied **in the query**, so a page holds only
   * what the caller may read one by one — never a page filtered afterwards.
   */
  async listPolicies(filter: {
    organizationId: string | null;
    visibleTo: Prisma.ApprovalPolicyWhereInput | null;
    workflowKey?: WorkflowKey;
    status?: PolicyStateName;
    cursor?: string;
    limit: number;
  }): Promise<PolicyWithSteps[]> {
    return runUnscoped(POLICY_REASON, () =>
      this.prisma.client.approvalPolicy.findMany({
        where: {
          AND: [
            ...(filter.organizationId !== null
              ? [
                  {
                    OR: [
                      { organizationId: filter.organizationId },
                      { authorOrganizationId: filter.organizationId },
                    ],
                  },
                ]
              : []),
            ...(filter.visibleTo ? [filter.visibleTo] : []),
          ],
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
}
