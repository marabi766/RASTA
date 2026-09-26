import { Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import type { CursorPage } from '@rasta/contracts';
import { ulid } from 'ulid';
import { PrismaService } from '../prisma/prisma.service';
import { EventPublisher } from '../events/publisher';
import { ProjectAccess } from '../access/access';
import { transactionNow } from '../shared/clock';
import { isUniqueViolation } from '../shared/prisma-errors';
import { SERVICE_NAME } from '../config/env';
import { versionConflictsTotal } from '../observability/metrics';
import { ApprovalRepository } from './approval.repository';
import { assertPolicyTransition, type PolicyStateName } from './approval.state-machine';
import { toPolicyView } from './views';
import type { CreatePolicyDto, ListPoliciesQuery, PolicyTransitionDto, PolicyView } from './dto';

export const POLICY_ID_PREFIX = 'APL';
export const POLICY_STEP_ID_PREFIX = 'APS';

/**
 * CreateApprovalPolicy, ActivateApprovalPolicy, RetireApprovalPolicy and the
 * reads (ADR-023, ADR-063, Q-70).
 *
 * A policy is data the tenant writes: which approvals a lifecycle point
 * needs, from which (organization, role), above which estimate. Nothing here
 * decides whether an authority is legitimate — the policy writer did, and the
 * platform only stores it. A policy is never edited; a change is a new
 * version, and activating it retires the one in force in the same
 * transaction.
 */
@Injectable()
export class PolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: ApprovalRepository,
    private readonly events: EventPublisher,
    private readonly access: ProjectAccess,
  ) {}

  async create(dto: CreatePolicyDto): Promise<PolicyView> {
    const { organizationId, actor } = this.access.assertCanWritePolicy();
    const policyId = `${POLICY_ID_PREFIX}_${ulid()}`;

    try {
      await this.prisma.transaction(async (tx) => {
        const at = await transactionNow(tx);
        const policyVersion = await this.repository.nextPolicyVersion(tx, dto.workflowKey);

        await this.repository.createPolicy(
          tx,
          {
            id: policyId,
            organizationId,
            workflowKey: dto.workflowKey,
            policyVersion,
            label: dto.label,
            rationale: dto.rationale,
            isSample: dto.isSample,
            actor,
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
          organizationId,
          payload: {
            policyId,
            organizationId,
            workflowKey: dto.workflowKey,
            policyVersion,
            stepCount: dto.steps.length,
            isSample: dto.isSample,
            createdBy: actor,
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
          {
            internalContext: { workflowKey: dto.workflowKey },
          },
        );
      }
      throw error;
    }

    return this.get(policyId);
  }

  async get(policyId: string): Promise<PolicyView> {
    const { organizationId } = this.access.assertCanReadPolicy();
    const policy = await this.repository.findPolicy(this.prisma.client, policyId);
    if (!policy || policy.organizationId !== organizationId) {
      throw RastaError.notFound('ApprovalPolicy', policyId);
    }
    return toPolicyView(policy);
  }

  async list(query: ListPoliciesQuery): Promise<CursorPage<PolicyView>> {
    this.access.assertCanReadPolicy();
    const rows = await this.repository.listPolicies({
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

  /**
   * Puts a DRAFT policy in force and retires the one it replaces, together.
   * Rounds already open keep the steps they copied (`docs/08` § 8.9).
   */
  async activate(policyId: string, dto: PolicyTransitionDto): Promise<PolicyView> {
    const { organizationId, actor } = this.access.assertCanWritePolicy();

    await this.prisma
      .transaction(async (tx) => {
        const at = await transactionNow(tx);
        const policy = await this.repository.findPolicy(tx, policyId);
        if (!policy || policy.organizationId !== organizationId) {
          throw RastaError.notFound('ApprovalPolicy', policyId);
        }
        this.assertVersion(policy.id, policy.version, dto.expectedVersion);
        assertPolicyTransition(policyId, policy.status as PolicyStateName, 'ACTIVE');

        const workflowKey = policy.workflowKey as CreatePolicyDto['workflowKey'];
        const current = await this.repository.findActivePolicy(tx, workflowKey);
        if (current) {
          const retired = await this.repository.transitionPolicy(tx, {
            policyId: current.id,
            from: 'ACTIVE',
            data: { status: 'RETIRED', retiredAt: at, retiredBy: actor },
          });
          if (retired === 0) throw this.conflict(current.id);
        }

        const matched = await this.repository.transitionPolicy(tx, {
          policyId,
          from: 'DRAFT',
          expectedVersion: dto.expectedVersion,
          data: { status: 'ACTIVE', activatedAt: at, activatedBy: actor },
        });
        if (matched === 0) throw this.conflict(policyId);

        await this.events.enqueue(tx, {
          eventName: 'APPROVAL_POLICY_ACTIVATED',
          aggregateId: policyId,
          organizationId,
          payload: {
            policyId,
            organizationId,
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

    return this.get(policyId);
  }

  /**
   * Takes the policy out of force with no replacement. From then on, a request
   * for that workflow is refused — no policy never means "no approval needed"
   * for execution (Q-70).
   */
  async retire(policyId: string, dto: PolicyTransitionDto): Promise<PolicyView> {
    const { organizationId, actor } = this.access.assertCanWritePolicy();

    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      const policy = await this.repository.findPolicy(tx, policyId);
      if (!policy || policy.organizationId !== organizationId) {
        throw RastaError.notFound('ApprovalPolicy', policyId);
      }
      this.assertVersion(policy.id, policy.version, dto.expectedVersion);
      assertPolicyTransition(policyId, policy.status as PolicyStateName, 'RETIRED');

      const matched = await this.repository.transitionPolicy(tx, {
        policyId,
        from: 'ACTIVE',
        expectedVersion: dto.expectedVersion,
        data: { status: 'RETIRED', retiredAt: at, retiredBy: actor },
      });
      if (matched === 0) throw this.conflict(policyId);

      await this.events.enqueue(tx, {
        eventName: 'APPROVAL_POLICY_RETIRED',
        aggregateId: policyId,
        organizationId,
        payload: {
          policyId,
          organizationId,
          workflowKey: policy.workflowKey,
          policyVersion: policy.policyVersion,
          retiredBy: actor,
          retiredAt: at.toISOString(),
        },
        occurredAt: at,
      });
    });

    return this.get(policyId);
  }

  private assertVersion(policyId: string, actual: number, expected: number): void {
    if (actual !== expected) throw this.conflict(policyId);
  }

  private conflict(policyId: string): RastaError {
    versionConflictsTotal.inc({ service: SERVICE_NAME, aggregate: 'ApprovalPolicy' });
    return RastaError.optimisticLockFailed('ApprovalPolicy', policyId);
  }
}
