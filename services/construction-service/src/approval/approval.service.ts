import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import type { CursorPage } from '@rasta/contracts';
import { ulid } from 'ulid';
import type { Approval } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher } from '../events/publisher';
import { ProjectAccess, assertOwnProject } from '../access/access';
import { transactionNow } from '../shared/clock';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';
import { projectTransitionsTotal, versionConflictsTotal } from '../observability/metrics';
import { ProjectRepository, type LockedProject } from '../project/project.repository';
import { assertProjectTransition, type ProjectStateName } from '../project/project.state-machine';
import { ProjectService } from '../project/project.service';
import type { ProjectView } from '../project/dto';
import { ApprovalRepository } from './approval.repository';
import {
  assertDecidable,
  stepApplies,
  type ApprovalStateName,
  type WorkflowKey,
} from './approval.state-machine';
import { toApprovalView } from './views';
import type {
  ApprovalView,
  DecisionDto,
  InboxQuery,
  ProjectApprovalsQuery,
  ProjectCommandDto,
} from './dto';

export const APPROVAL_ID_PREFIX = 'APR';

/** What opening a round decided. */
export type RoundOutcome =
  | { opened: true; round: number; first: { id: string } }
  | { opened: false; reason: 'NO_POLICY' | 'NO_APPLICABLE_STEP' };

/**
 * RequestApproval, the authority's decision, and the reads (ADR-063, Q-70).
 *
 * ## The one rule this file exists for
 *
 * **The platform never approves.** A project reaches APPROVED only in the
 * transaction of the last GRANT a named authority made. No active policy, a
 * policy with no step for this estimate, a timeout, silence — none of them
 * approves anything; each is a refusal (Q-70, Q-73).
 *
 * ## A round
 *
 * RequestApproval copies the steps of the active `project.execution` policy
 * that apply to the project's estimate into `approval` rows: the first
 * PENDING, the rest QUEUED. Each GRANT asks the next step; the last GRANT
 * approves the project. A REJECT ends the round — the rest become SUPERSEDED —
 * and sends the project to CHANGES_REQUESTED; resubmitting opens a new round
 * against whatever policy is in force then.
 *
 * Every command locks the project row first, so a decision, a resubmission and
 * a cancellation of one project serialise.
 */
@Injectable()
export class ApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalRepository,
    private readonly projects: ProjectRepository,
    private readonly projectService: ProjectService,
    private readonly events: EventPublisher,
    private readonly access: ProjectAccess,
    @Inject(ENV) private readonly env: ConstructionEnv,
  ) {}

  /** RequestApproval: DRAFT | CHANGES_REQUESTED → PENDING_APPROVAL. */
  async request(projectId: string, dto: ProjectCommandDto): Promise<ProjectView> {
    const { organizationId, actor } = this.access.assertCanWrite();

    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      const locked = await this.lockOrNotFound(tx, organizationId, projectId);
      if (locked.version !== dto.expectedVersion) throw this.conflict('Project', projectId);
      assertProjectTransition(projectId, locked.status, 'PENDING_APPROVAL');

      const project = await tx.project.findFirst({ where: { id: projectId } });
      if (!project) throw RastaError.notFound('Project', projectId);
      await this.assertReadyForApproval(tx, projectId, project.estimatedCostMinor);

      const outcome = await this.openRound(tx, {
        organizationId,
        projectId,
        workflowKey: 'project.execution',
        estimate: project.estimatedCostMinor,
        round: project.approvalRound + 1,
        at,
      });
      if (!outcome.opened) throw this.noApprovalPath('project.execution', outcome.reason);

      const matched = await this.projects.updateProjectContent(tx, projectId, dto.expectedVersion, {
        status: 'PENDING_APPROVAL',
        statusReason: null,
        statusChangedAt: at,
        statusChangedBy: actor,
        approvalRound: outcome.round,
        updatedAt: at,
        updatedBy: actor,
      });
      if (matched === 0) throw this.conflict('Project', projectId);

      await this.events.enqueue(tx, {
        eventName: 'PROJECT_STATUS_CHANGED',
        aggregateId: projectId,
        organizationId,
        payload: {
          projectId,
          organizationId,
          from: locked.status,
          to: 'PENDING_APPROVAL',
          reason: null,
          changedBy: actor,
          changedAt: at.toISOString(),
        },
        occurredAt: at,
      });
      await this.announceRequested(tx, outcome.first.id, at);
    });
    projectTransitionsTotal.inc({ service: SERVICE_NAME, command: 'request-approval' });

    return this.projectService.get(projectId);
  }

  /**
   * The authority's decision on one PENDING step. Only the (organization,
   * role) the step names may make it (`ProjectAccess.assertIsAuthority`).
   */
  async decide(approvalId: string, dto: DecisionDto): Promise<ApprovalView> {
    const located = await this.approvals.findApproval(this.prisma.client, approvalId);
    if (!located) throw RastaError.notFound('Approval', approvalId);
    const { actor } = this.access.assertIsAuthority(located);
    const organizationId = located.organizationId;

    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      const locked = await this.projects.lockProject(tx, organizationId, located.projectId);
      if (!locked) throw RastaError.notFound('Approval', approvalId);

      const approval = await this.approvals.findApproval(tx, approvalId);
      if (!approval) throw RastaError.notFound('Approval', approvalId);
      if (approval.version !== dto.expectedVersion) throw this.conflict('Approval', approvalId);
      assertDecidable(approvalId, approval.status as ApprovalStateName);

      const workflowKey = approval.workflowKey as WorkflowKey;
      const expectedProjectState: ProjectStateName =
        workflowKey === 'project.execution' ? 'PENDING_APPROVAL' : 'IN_PROGRESS';
      if (locked.status !== expectedProjectState) {
        throw RastaError.businessRule(
          `Project ${approval.projectId} is ${locked.status}; this approval can no longer be decided`,
          { approvalId, projectStatus: locked.status },
        );
      }

      const granted = dto.decision === 'GRANT';
      const matched = await this.approvals.transitionApproval(tx, {
        organizationId,
        approvalId,
        from: 'PENDING',
        expectedVersion: dto.expectedVersion,
        data: {
          status: granted ? 'GRANTED' : 'REJECTED',
          decidedAt: at,
          decidedBy: actor,
          decisionNumber: dto.decisionNumber ?? null,
          conditions: granted ? (dto.conditions ?? null) : null,
          reason: granted ? null : (dto.reason ?? null),
        },
      });
      if (matched === 0) throw this.conflict('Approval', approvalId);

      const step = {
        approvalId,
        projectId: approval.projectId,
        organizationId,
        workflowKey,
        round: approval.round,
        stepOrder: approval.stepOrder,
      };

      if (granted) {
        await this.events.enqueue(tx, {
          eventName: 'APPROVAL_GRANTED',
          aggregateId: approval.projectId,
          organizationId,
          payload: {
            ...step,
            decidedBy: actor,
            decidedAt: at.toISOString(),
            decisionNumber: dto.decisionNumber ?? null,
            conditions: dto.conditions ?? null,
          },
          occurredAt: at,
        });
        await this.afterGrant(tx, { approval, locked, actor, at });
      } else {
        await this.events.enqueue(tx, {
          eventName: 'APPROVAL_REJECTED',
          aggregateId: approval.projectId,
          organizationId,
          payload: {
            ...step,
            decidedBy: actor,
            decidedAt: at.toISOString(),
            decisionNumber: dto.decisionNumber ?? null,
            reason: dto.reason as string,
          },
          occurredAt: at,
        });
        await this.afterReject(tx, { approval, locked, actor, at, reason: dto.reason as string });
      }
    });

    return this.view(approvalId);
  }

  /** Every approval of one project, in round and step order. */
  async listForProject(projectId: string, query: ProjectApprovalsQuery): Promise<ApprovalView[]> {
    const { organizationId } = this.access.assertCanRead();
    const project = await this.projects.findProject(projectId);
    if (!project) throw RastaError.notFound('Project', projectId);
    assertOwnProject(project, organizationId);

    const rows = await this.approvals.listForProject(projectId, {
      ...(query.workflowKey ? { workflowKey: query.workflowKey } : {}),
      ...(query.round ? { round: query.round } : {}),
    });
    return rows.map((row) => toApprovalView(row, project));
  }

  async get(approvalId: string): Promise<ApprovalView> {
    const approval = await this.approvals.findApproval(this.prisma.client, approvalId);
    if (!approval) throw RastaError.notFound('Approval', approvalId);
    this.access.assertCanSeeApproval(approval);
    return this.view(approvalId);
  }

  /** The authority's inbox: steps addressed to its organization and roles. */
  async inbox(query: InboxQuery): Promise<CursorPage<ApprovalView>> {
    const scope = this.access.inboxScope();
    const rows = await this.approvals.inbox({
      authorityOrganizationId: scope.organizationId,
      roles: scope.roles,
      status: query.status,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    const items: ApprovalView[] = [];
    for (const row of visible) {
      const brief = await this.approvals.projectBrief(
        this.prisma.client,
        row.organizationId,
        row.projectId,
      );
      if (brief) items.push(toApprovalView(row, brief));
    }
    return {
      items,
      nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  // -- the round machinery, shared with completion ---------------------------

  /**
   * Copies the applicable steps of the active policy into a new round.
   *
   * Returns `opened: false` when there is no active policy or no step applies
   * to this estimate. What that means is the caller's decision: for execution
   * it is a refusal, for completion it means no approval was configured
   * (Q-71). It never means "approved".
   */
  async openRound(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      projectId: string;
      workflowKey: WorkflowKey;
      estimate: bigint | null;
      round: number;
      at: Date;
    },
  ): Promise<RoundOutcome> {
    const policy = await this.approvals.findActivePolicy(tx, input.workflowKey);
    if (!policy) return { opened: false, reason: 'NO_POLICY' };

    const steps = policy.steps.filter((step) => stepApplies(step, input.estimate));
    if (steps.length === 0) return { opened: false, reason: 'NO_APPLICABLE_STEP' };

    const correlationId = getContext().correlationId;
    const rows = steps.map((step, index) => ({
      id: `${APPROVAL_ID_PREFIX}_${ulid()}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      workflowKey: input.workflowKey,
      round: input.round,
      stepOrder: step.stepOrder,
      policyId: policy.id,
      policyVersion: policy.policyVersion,
      approvalType: step.approvalType,
      authorityOrganizationId: step.authorityOrganizationId,
      authorityRole: step.authorityRole,
      authorityLabel: step.authorityLabel,
      status: index === 0 ? ('PENDING' as const) : ('QUEUED' as const),
      requestedAt: index === 0 ? input.at : null,
      createdAt: input.at,
      createdCorrelationId: correlationId,
    }));
    const [first] = rows;
    if (!first) return { opened: false, reason: 'NO_APPLICABLE_STEP' };
    await this.approvals.createApprovals(tx, rows);
    return { opened: true, round: input.round, first: { id: first.id } };
  }

  /** Publishes APPROVAL_REQUESTED for a step that has just become PENDING. */
  async announceRequested(tx: ExtendedPrismaClient, approvalId: string, at: Date): Promise<void> {
    const approval = await this.approvals.findApproval(tx, approvalId);
    if (!approval)
      throw RastaError.internal(`Approval ${approvalId} vanished inside its own transaction`);
    await this.events.enqueue(tx, {
      eventName: 'APPROVAL_REQUESTED',
      aggregateId: approval.projectId,
      organizationId: approval.organizationId,
      payload: {
        approvalId: approval.id,
        projectId: approval.projectId,
        organizationId: approval.organizationId,
        workflowKey: approval.workflowKey,
        round: approval.round,
        stepOrder: approval.stepOrder,
        approvalType: approval.approvalType,
        authorityOrganizationId: approval.authorityOrganizationId,
        authorityRole: approval.authorityRole,
        policyId: approval.policyId,
        policyVersion: approval.policyVersion,
        requestedAt: at.toISOString(),
      },
      occurredAt: at,
    });
  }

  /** The refusal when no approval path exists: never a default approval. */
  noApprovalPath(workflowKey: WorkflowKey, reason: 'NO_POLICY' | 'NO_APPLICABLE_STEP'): RastaError {
    return RastaError.businessRule(
      reason === 'NO_POLICY'
        ? `There is no active approval policy for ${workflowKey} in this organization. ` +
            'The platform never approves by default; a policy setter must activate one first.'
        : `The active approval policy for ${workflowKey} has no step for this project's estimate. ` +
            'The platform never approves by default.',
      { workflowKey, reason },
    );
  }

  private async afterGrant(
    tx: ExtendedPrismaClient,
    input: { approval: Approval; locked: LockedProject; actor: string; at: Date },
  ): Promise<void> {
    const { approval, locked, actor, at } = input;
    const next = await this.approvals.nextQueued(tx, {
      organizationId: approval.organizationId,
      projectId: approval.projectId,
      workflowKey: approval.workflowKey,
      round: approval.round,
    });

    if (next) {
      const asked = await this.approvals.transitionApproval(tx, {
        organizationId: approval.organizationId,
        approvalId: next.id,
        from: 'QUEUED',
        data: { status: 'PENDING', requestedAt: at },
      });
      if (asked === 0) throw this.conflict('Approval', next.id);
      await this.announceRequested(tx, next.id, at);
      return;
    }

    // The last required step was granted: the round succeeds.
    if (approval.workflowKey === 'project.execution') {
      await this.moveProject(tx, { approval, locked, to: 'APPROVED', reason: null, actor, at });
      await this.events.enqueue(tx, {
        eventName: 'PROJECT_STATUS_CHANGED',
        aggregateId: approval.projectId,
        organizationId: approval.organizationId,
        payload: {
          projectId: approval.projectId,
          organizationId: approval.organizationId,
          from: 'PENDING_APPROVAL',
          to: 'APPROVED',
          reason: null,
          changedBy: actor,
          changedAt: at.toISOString(),
        },
        occurredAt: at,
      });
    } else {
      await this.moveProject(tx, { approval, locked, to: 'COMPLETED', reason: null, actor, at });
      await this.events.enqueue(tx, {
        eventName: 'PROJECT_COMPLETED',
        aggregateId: approval.projectId,
        organizationId: approval.organizationId,
        payload: {
          projectId: approval.projectId,
          organizationId: approval.organizationId,
          completedBy: actor,
          completedAt: at.toISOString(),
        },
        occurredAt: at,
      });
    }
  }

  private async afterReject(
    tx: ExtendedPrismaClient,
    input: { approval: Approval; locked: LockedProject; actor: string; at: Date; reason: string },
  ): Promise<void> {
    const { approval, locked, actor, at, reason } = input;
    await this.approvals.supersedeOpen(
      tx,
      {
        organizationId: approval.organizationId,
        projectId: approval.projectId,
        workflowKey: approval.workflowKey,
      },
      at,
    );

    // A rejected completion leaves the project executing; a rejected
    // execution approval sends it back for changes (Q-70, Q-71).
    if (approval.workflowKey !== 'project.execution') return;

    await this.moveProject(tx, { approval, locked, to: 'CHANGES_REQUESTED', reason, actor, at });
    await this.events.enqueue(tx, {
      eventName: 'PROJECT_STATUS_CHANGED',
      aggregateId: approval.projectId,
      organizationId: approval.organizationId,
      payload: {
        projectId: approval.projectId,
        organizationId: approval.organizationId,
        from: 'PENDING_APPROVAL',
        to: 'CHANGES_REQUESTED',
        reason,
        changedBy: actor,
        changedAt: at.toISOString(),
      },
      occurredAt: at,
    });
  }

  private async moveProject(
    tx: ExtendedPrismaClient,
    input: {
      approval: Approval;
      locked: LockedProject;
      to: ProjectStateName;
      reason: string | null;
      actor: string;
      at: Date;
    },
  ): Promise<void> {
    assertProjectTransition(input.approval.projectId, input.locked.status, input.to);
    const matched = await this.approvals.transitionProjectForRound(tx, {
      organizationId: input.approval.organizationId,
      projectId: input.approval.projectId,
      from: input.locked.status,
      to: input.to,
      expectedVersion: input.locked.version,
      reason: input.reason,
      actor: input.actor,
      at: input.at,
    });
    if (matched === 0) throw this.conflict('Project', input.approval.projectId);
  }

  private async assertReadyForApproval(
    tx: ExtendedPrismaClient,
    projectId: string,
    estimate: bigint | null,
  ): Promise<void> {
    if (this.env.CONSTRUCTION_APPROVAL_REQUIRES_ESTIMATE && estimate === null) {
      throw RastaError.businessRule(
        'A project needs an estimate before it may request approval (CONSTRUCTION_APPROVAL_REQUIRES_ESTIMATE)',
        { projectId },
      );
    }
    const minimum = this.env.CONSTRUCTION_APPROVAL_MIN_SUBMITTED_NEEDS;
    if (minimum > 0) {
      const submitted = await tx.projectNeed.count({ where: { projectId, status: 'SUBMITTED' } });
      if (submitted < minimum) {
        throw RastaError.businessRule(
          `A project needs at least ${minimum} submitted need(s) before it may request approval ` +
            '(CONSTRUCTION_APPROVAL_MIN_SUBMITTED_NEEDS)',
          { projectId, submitted, minimum },
        );
      }
    }
  }

  private async lockOrNotFound(
    tx: ExtendedPrismaClient,
    organizationId: string,
    projectId: string,
  ): Promise<LockedProject> {
    const locked = await this.projects.lockProject(tx, organizationId, projectId);
    if (!locked) throw RastaError.notFound('Project', projectId);
    assertOwnProject(locked, organizationId);
    return locked;
  }

  private async view(approvalId: string): Promise<ApprovalView> {
    const approval = await this.approvals.findApproval(this.prisma.client, approvalId);
    if (!approval) throw RastaError.notFound('Approval', approvalId);
    const brief = await this.approvals.projectBrief(
      this.prisma.client,
      approval.organizationId,
      approval.projectId,
    );
    if (!brief) throw RastaError.notFound('Approval', approvalId);
    return toApprovalView(approval, brief);
  }

  private conflict(aggregate: string, id: string): RastaError {
    versionConflictsTotal.inc({ service: SERVICE_NAME, aggregate });
    return RastaError.optimisticLockFailed(aggregate, id);
  }
}
