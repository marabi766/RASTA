import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import type { CursorPage } from '@rasta/contracts';
import { ulid } from 'ulid';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher } from '../events/publisher';
import { ProjectAccess, SUPER_ROLE, UNION_ROLE, type PolicyAuthorRole } from '../access/access';
import { OrganizationDirectory } from '../organization/organization-directory';
import { transactionNow } from '../shared/clock';
import { isUniqueViolation } from '../shared/prisma-errors';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';
import { versionConflictsTotal } from '../observability/metrics';
import { ApprovalRepository, type PolicyWithSteps } from './approval.repository';
import {
  assertPolicyTransition,
  type PolicyStateName,
  type WorkflowKey,
} from './approval.state-machine';
import { toPolicyView } from './views';
import type {
  CreatePolicyDto,
  ListPoliciesQuery,
  PolicyRejectionDto,
  PolicyTransitionDto,
  PolicyView,
} from './dto';

export const POLICY_ID_PREFIX = 'APL';
export const POLICY_STEP_ID_PREFIX = 'APS';

/**
 * Approval policies: who writes them, who puts them in force (ADR-023,
 * ADR-063, Q-70 (7) decided 2026-09-26).
 *
 * ```
 *   create        submit                           approve (SYSTEM_ADMIN)
 *   ────► DRAFT ─────────► PENDING_PLATFORM_APPROVAL ──────────────────► ACTIVE ──retire──► RETIRED
 *                                   └──reject(reason)──► REJECTED
 * ```
 *
 * - **Writers.** A `UNION_ADMIN` writes for its own organization or one
 *   beneath it; organization-service confirms which, at create and again at
 *   submit and approval, and "could not confirm" refuses the write. A
 *   `SYSTEM_ADMIN` may write for any organization organization-service knows.
 *   An `ORGANIZATION_ADMIN` never writes its own policy (conflict of interest).
 * - **Platform approval.** Only a `SYSTEM_ADMIN` approves or rejects. With
 *   `CONSTRUCTION_POLICY_FOUR_EYES` (default on), the approver must be neither
 *   the policy's author nor its submitter. Approval puts the policy in force and
 *   retires the one it replaces, in one transaction.
 * - **Governing.** Only an ACTIVE policy governs a project; a DRAFT, PENDING or
 *   REJECTED one never does (`ApprovalRepository.findActivePolicy`).
 *
 * Nothing here decides whether an authority a policy names is legitimate: the
 * union wrote it and the platform approved it; this service stores it. Every
 * transition writes its event in the same transaction.
 */
@Injectable()
export class PolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: ApprovalRepository,
    private readonly events: EventPublisher,
    private readonly access: ProjectAccess,
    private readonly directory: OrganizationDirectory,
    @Inject(ENV) private readonly env: ConstructionEnv,
  ) {}

  async create(dto: CreatePolicyDto): Promise<PolicyView> {
    const author = this.access.assertPolicyAuthor();
    await this.assertMayGovern(author.role, author.organizationId, dto.organizationId);

    const policyId = `${POLICY_ID_PREFIX}_${ulid()}`;
    try {
      await this.prisma.transaction(async (tx) => {
        const at = await transactionNow(tx);
        const policyVersion = await this.repository.nextPolicyVersion(
          tx,
          dto.organizationId,
          dto.workflowKey,
        );

        await this.repository.createPolicy(
          tx,
          {
            id: policyId,
            organizationId: dto.organizationId,
            authorOrganizationId: author.organizationId,
            authorRole: author.role,
            workflowKey: dto.workflowKey,
            policyVersion,
            label: dto.label,
            rationale: dto.rationale,
            isSample: dto.isSample,
            actor: author.actor,
            correlationId: getContext().correlationId,
            at,
          },
          dto.steps.map((step, index) => ({
            id: `${POLICY_STEP_ID_PREFIX}_${ulid()}`,
            stepOrder: index + 1,
            approvalType: step.approvalType,
            authorityOrganizationId: step.authorityOrganizationId,
            authorityRole: step.authorityRole,
            authorityLabel: step.authorityLabel,
            minAmountMinor: step.minAmountMinor === undefined ? null : BigInt(step.minAmountMinor),
            maxAmountMinor: step.maxAmountMinor === undefined ? null : BigInt(step.maxAmountMinor),
          })),
        );

        await this.events.enqueue(tx, {
          eventName: 'APPROVAL_POLICY_CREATED',
          aggregateId: policyId,
          organizationId: dto.organizationId,
          payload: {
            policyId,
            organizationId: dto.organizationId,
            authorOrganizationId: author.organizationId,
            authorRole: author.role,
            workflowKey: dto.workflowKey,
            policyVersion,
            stepCount: dto.steps.length,
            isSample: dto.isSample,
            createdBy: author.actor,
            createdAt: at.toISOString(),
          },
          occurredAt: at,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Two policies of one workflow created at the same instant drew the
        // same version number. Nothing was written; the caller retries.
        throw new RastaError(
          'CONFLICT',
          'Another policy version was created at the same time; retry',
          { internalContext: { workflowKey: dto.workflowKey } },
        );
      }
      throw error;
    }

    return this.view(policyId);
  }

  /** DRAFT → PENDING_PLATFORM_APPROVAL, by the organization that wrote it. */
  async submit(policyId: string, dto: PolicyTransitionDto): Promise<PolicyView> {
    const found = await this.policyOrNotFound(this.prisma.client, policyId);
    const { actor, role } = this.access.assertCanSubmitPolicy(found);
    // The hierarchy may have changed since the policy was written.
    await this.assertMayGovern(role, found.authorOrganizationId, found.organizationId);

    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      const policy = await this.policyOrNotFound(tx, policyId);
      this.assertVersion(policy.id, policy.version, dto.expectedVersion);
      assertPolicyTransition(
        policyId,
        policy.status as PolicyStateName,
        'PENDING_PLATFORM_APPROVAL',
      );

      const matched = await this.repository.transitionPolicy(tx, {
        organizationId: policy.organizationId,
        policyId,
        from: 'DRAFT',
        expectedVersion: dto.expectedVersion,
        data: { status: 'PENDING_PLATFORM_APPROVAL', submittedAt: at, submittedBy: actor },
      });
      if (matched === 0) throw this.conflict(policyId);

      await this.events.enqueue(tx, {
        eventName: 'APPROVAL_POLICY_SUBMITTED',
        aggregateId: policyId,
        organizationId: policy.organizationId,
        payload: {
          policyId,
          organizationId: policy.organizationId,
          workflowKey: policy.workflowKey,
          policyVersion: policy.policyVersion,
          submittedBy: actor,
          submittedAt: at.toISOString(),
        },
        occurredAt: at,
      });
    });

    return this.view(policyId);
  }

  /**
   * The platform approval: PENDING_PLATFORM_APPROVAL → ACTIVE, retiring the
   * policy it replaces in the same transaction. Rounds already open keep the
   * steps they copied (`docs/08` § 8.9).
   */
  async approve(policyId: string, dto: PolicyTransitionDto): Promise<PolicyView> {
    const { actor } = this.access.assertPlatformAdministrator();
    const found = await this.policyOrNotFound(this.prisma.client, policyId);
    this.assertFourEyes(found, actor);
    await this.assertMayGovern(
      found.authorRole as PolicyAuthorRole,
      found.authorOrganizationId,
      found.organizationId,
    );

    await this.prisma
      .transaction(async (tx) => {
        const at = await transactionNow(tx);
        const policy = await this.policyOrNotFound(tx, policyId);
        this.assertVersion(policy.id, policy.version, dto.expectedVersion);
        assertPolicyTransition(policyId, policy.status as PolicyStateName, 'ACTIVE');
        this.assertFourEyes(policy, actor);

        const workflowKey = policy.workflowKey as WorkflowKey;
        const current = await this.repository.findActivePolicyOf(
          tx,
          policy.organizationId,
          workflowKey,
        );
        if (current) {
          const retired = await this.repository.transitionPolicy(tx, {
            organizationId: policy.organizationId,
            policyId: current.id,
            from: 'ACTIVE',
            data: { status: 'RETIRED', retiredAt: at, retiredBy: actor },
          });
          if (retired === 0) throw this.conflict(current.id);
        }

        const matched = await this.repository.transitionPolicy(tx, {
          organizationId: policy.organizationId,
          policyId,
          from: 'PENDING_PLATFORM_APPROVAL',
          expectedVersion: dto.expectedVersion,
          data: { status: 'ACTIVE', activatedAt: at, activatedBy: actor },
        });
        if (matched === 0) throw this.conflict(policyId);

        if (current) await this.announceRetired(tx, current, actor, at);
        await this.events.enqueue(tx, {
          eventName: 'APPROVAL_POLICY_ACTIVATED',
          aggregateId: policyId,
          organizationId: policy.organizationId,
          payload: {
            policyId,
            organizationId: policy.organizationId,
            workflowKey,
            policyVersion: policy.policyVersion,
            retiredPolicyId: current?.id ?? null,
            activatedBy: actor,
            activatedAt: at.toISOString(),
          },
          occurredAt: at,
        });
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw this.conflict(policyId);
        throw error;
      });

    return this.view(policyId);
  }

  /** The platform refusal: PENDING_PLATFORM_APPROVAL → REJECTED, with a reason. */
  async reject(policyId: string, dto: PolicyRejectionDto): Promise<PolicyView> {
    const { actor } = this.access.assertPlatformAdministrator();

    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      const policy = await this.policyOrNotFound(tx, policyId);
      this.assertVersion(policy.id, policy.version, dto.expectedVersion);
      assertPolicyTransition(policyId, policy.status as PolicyStateName, 'REJECTED');

      const matched = await this.repository.transitionPolicy(tx, {
        organizationId: policy.organizationId,
        policyId,
        from: 'PENDING_PLATFORM_APPROVAL',
        expectedVersion: dto.expectedVersion,
        data: {
          status: 'REJECTED',
          rejectedAt: at,
          rejectedBy: actor,
          rejectionReason: dto.reason,
        },
      });
      if (matched === 0) throw this.conflict(policyId);

      await this.events.enqueue(tx, {
        eventName: 'APPROVAL_POLICY_REJECTED',
        aggregateId: policyId,
        organizationId: policy.organizationId,
        payload: {
          policyId,
          organizationId: policy.organizationId,
          workflowKey: policy.workflowKey,
          policyVersion: policy.policyVersion,
          rejectedBy: actor,
          rejectedAt: at.toISOString(),
        },
        occurredAt: at,
      });
    });

    return this.view(policyId);
  }

  /**
   * Takes an ACTIVE policy out of force with no replacement. From then on a
   * request for that workflow is refused — no policy never means "no approval
   * needed" for execution (Q-70).
   */
  async retire(policyId: string, dto: PolicyTransitionDto): Promise<PolicyView> {
    const found = await this.policyOrNotFound(this.prisma.client, policyId);
    const { actor } = this.access.assertCanRetirePolicy(found);

    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      const policy = await this.policyOrNotFound(tx, policyId);
      this.assertVersion(policy.id, policy.version, dto.expectedVersion);
      assertPolicyTransition(policyId, policy.status as PolicyStateName, 'RETIRED');

      const matched = await this.repository.transitionPolicy(tx, {
        organizationId: policy.organizationId,
        policyId,
        from: 'ACTIVE',
        expectedVersion: dto.expectedVersion,
        data: { status: 'RETIRED', retiredAt: at, retiredBy: actor },
      });
      if (matched === 0) throw this.conflict(policyId);
      await this.announceRetired(tx, policy, actor, at);
    });

    return this.view(policyId);
  }

  async get(policyId: string): Promise<PolicyView> {
    const policy = await this.policyOrNotFound(this.prisma.client, policyId);
    this.access.assertCanSeePolicy(policy);
    return toPolicyView(policy);
  }

  /** Policies the caller's organization is governed by or wrote. */
  async list(query: ListPoliciesQuery): Promise<CursorPage<PolicyView>> {
    const { organizationId } = this.access.assertCanListPolicies();
    return this.page(organizationId, query);
  }

  /** The platform administrator's queue: every organization's pending policies. */
  async platformQueue(query: ListPoliciesQuery): Promise<CursorPage<PolicyView>> {
    this.access.assertPlatformAdministrator();
    return this.page(null, { ...query, status: 'PENDING_PLATFORM_APPROVAL' });
  }

  // -------------------------------------------------------------------------

  /**
   * Whether `author` may make a policy govern `target` (Q-70 (7)): a union
   * for itself or an organization beneath it, the platform for any
   * organization that exists — both answered by organization-service. A
   * refusal names no hierarchy; an unconfirmable answer is an upstream error
   * and refuses too (fail closed).
   */
  private async assertMayGovern(
    role: PolicyAuthorRole,
    authorOrganizationId: string,
    target: string,
  ): Promise<void> {
    const confirmed =
      role === SUPER_ROLE
        ? await this.directory.isWithin(target, target)
        : await this.directory.isWithin(authorOrganizationId, target);
    if (!confirmed) {
      throw RastaError.forbidden(
        role === UNION_ROLE
          ? 'A union writes approval policies only for its own organization or one beneath it'
          : 'Approval policies can be written only for an organization that exists',
      );
    }
  }

  /**
   * Four eyes (Q-70 (7)): with `CONSTRUCTION_POLICY_FOUR_EYES`, the platform
   * administrator who approves is neither the author nor the submitter.
   */
  private assertFourEyes(policy: PolicyWithSteps, approver: string): void {
    if (!this.env.CONSTRUCTION_POLICY_FOUR_EYES) return;
    if (policy.createdBy === approver || policy.submittedBy === approver) {
      throw RastaError.forbidden(
        'A different platform administrator must approve this policy (CONSTRUCTION_POLICY_FOUR_EYES)',
      );
    }
  }

  private async announceRetired(
    tx: ExtendedPrismaClient,
    policy: PolicyWithSteps,
    actor: string,
    at: Date,
  ): Promise<void> {
    await this.events.enqueue(tx, {
      eventName: 'APPROVAL_POLICY_RETIRED',
      aggregateId: policy.id,
      organizationId: policy.organizationId,
      payload: {
        policyId: policy.id,
        organizationId: policy.organizationId,
        workflowKey: policy.workflowKey,
        policyVersion: policy.policyVersion,
        retiredBy: actor,
        retiredAt: at.toISOString(),
      },
      occurredAt: at,
    });
  }

  private async page(
    organizationId: string | null,
    query: ListPoliciesQuery,
  ): Promise<CursorPage<PolicyView>> {
    const rows = await this.repository.listPolicies({
      organizationId,
      ...(query.workflowKey ? { workflowKey: query.workflowKey } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items: visible.map(toPolicyView),
      nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  private async policyOrNotFound(
    client: ExtendedPrismaClient,
    policyId: string,
  ): Promise<PolicyWithSteps> {
    const policy = await this.repository.findPolicy(client, policyId);
    if (!policy) throw RastaError.notFound('ApprovalPolicy', policyId);
    return policy;
  }

  private async view(policyId: string): Promise<PolicyView> {
    return toPolicyView(await this.policyOrNotFound(this.prisma.client, policyId));
  }

  private assertVersion(policyId: string, actual: number, expected: number): void {
    if (actual !== expected) throw this.conflict(policyId);
  }

  private conflict(policyId: string): RastaError {
    versionConflictsTotal.inc({ service: SERVICE_NAME, aggregate: 'ApprovalPolicy' });
    return RastaError.optimisticLockFailed('ApprovalPolicy', policyId);
  }
}
