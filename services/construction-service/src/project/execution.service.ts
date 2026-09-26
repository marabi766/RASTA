import { Inject, Injectable } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher } from '../events/publisher';
import { ProjectAccess, assertOwnProject } from '../access/access';
import { transactionNow } from '../shared/clock';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';
import { projectTransitionsTotal, versionConflictsTotal } from '../observability/metrics';
import { ApprovalService } from '../approval/approval.service';
import { ApprovalRepository } from '../approval/approval.repository';
import { FULL_PROGRESS_BASIS_POINTS } from '../progress/progress.state-machine';
import { ProjectRepository, type LockedProject } from './project.repository';
import { ProjectService } from './project.service';
import { assertProjectTransition } from './project.state-machine';
import type { ProjectView } from './dto';
import type { ProjectCommandDto } from '../approval/dto';

/**
 * StartProject and CompleteProject (Q-71, provisional).
 *
 * **Start** moves an APPROVED project to IN_PROGRESS. No contract boundary
 * exists yet (CON-003), so `PROJECT_STARTED.contractId` is `null`; a
 * deployment that must not start without a contract sets
 * `CONSTRUCTION_START_REQUIRES_CONTRACT=true`, and every start is refused
 * until that boundary exists.
 *
 * **Complete** requires the latest submitted progress report to say 100%.
 * If the tenant configured `project.completion` steps that apply to this
 * project, completing opens a round for them — the "final technical approval"
 * of `docs/08` § 8.3 — and the project completes only on the last grant. If
 * none are configured, the project completes now: no approval is claimed,
 * because none was asked for.
 */
@Injectable()
export class ExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectRepository,
    private readonly projectService: ProjectService,
    private readonly approvals: ApprovalService,
    private readonly approvalRepository: ApprovalRepository,
    private readonly events: EventPublisher,
    private readonly access: ProjectAccess,
    @Inject(ENV) private readonly env: ConstructionEnv,
  ) {}

  async start(projectId: string, dto: ProjectCommandDto): Promise<ProjectView> {
    const { organizationId, actor } = this.access.assertCanWrite();

    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      const locked = await this.lockOrNotFound(tx, organizationId, projectId);
      if (locked.version !== dto.expectedVersion) throw this.conflict(projectId);
      assertProjectTransition(projectId, locked.status, 'IN_PROGRESS');

      if (this.env.CONSTRUCTION_START_REQUIRES_CONTRACT) {
        throw RastaError.businessRule(
          'This deployment starts a project only under a signed contract, and the contract ' +
            'boundary does not exist yet (CONSTRUCTION_START_REQUIRES_CONTRACT, CON-003)',
          { projectId },
        );
      }

      const matched = await this.projects.transitionProject(tx, {
        projectId,
        from: locked.status,
        to: 'IN_PROGRESS',
        expectedVersion: dto.expectedVersion,
        reason: null,
        actor,
        at,
      });
      if (matched === 0) throw this.conflict(projectId);

      await this.events.enqueue(tx, {
        eventName: 'PROJECT_STARTED',
        aggregateId: projectId,
        organizationId,
        payload: {
          projectId,
          organizationId,
          contractId: null,
          startedBy: actor,
          startedAt: at.toISOString(),
        },
        occurredAt: at,
      });
    });
    projectTransitionsTotal.inc({ service: SERVICE_NAME, command: 'start' });

    return this.projectService.get(projectId);
  }

  async complete(projectId: string, dto: ProjectCommandDto): Promise<ProjectView> {
    const { organizationId, actor } = this.access.assertCanWrite();

    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      const locked = await this.lockOrNotFound(tx, organizationId, projectId);
      if (locked.version !== dto.expectedVersion) throw this.conflict(projectId);
      assertProjectTransition(projectId, locked.status, 'COMPLETED');

      const latest = await tx.progressReport.findFirst({
        where: { projectId, status: 'SUBMITTED' },
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
      });
      if (!latest || latest.progressBasisPoints < FULL_PROGRESS_BASIS_POINTS) {
        throw RastaError.businessRule(
          'A project completes only when its latest submitted progress report says 100%',
          { projectId, latestProgressBasisPoints: latest?.progressBasisPoints ?? null },
        );
      }

      const scope = { organizationId, projectId, workflowKey: 'project.completion' };
      if (await this.approvalRepository.hasPending(tx, scope)) {
        throw RastaError.businessRule(
          'A completion approval round is already open for this project',
          { projectId },
        );
      }

      const project = await tx.project.findFirst({ where: { id: projectId } });
      if (!project) throw RastaError.notFound('Project', projectId);

      const outcome = await this.approvals.openRound(tx, {
        organizationId,
        projectId,
        workflowKey: 'project.completion',
        estimate: project.estimatedCostMinor,
        round: project.approvalRound + 1,
        at,
      });

      if (outcome.opened) {
        // The final technical approval is configured: the project stays
        // IN_PROGRESS and completes on the last grant.
        const matched = await this.projects.updateProjectContent(
          tx,
          projectId,
          dto.expectedVersion,
          {
            approvalRound: outcome.round,
            updatedAt: at,
            updatedBy: actor,
          },
        );
        if (matched === 0) throw this.conflict(projectId);
        await this.approvals.announceRequested(tx, outcome.first.id, at);
        return;
      }

      const matched = await this.projects.transitionProject(tx, {
        projectId,
        from: locked.status,
        to: 'COMPLETED',
        expectedVersion: dto.expectedVersion,
        reason: null,
        actor,
        at,
      });
      if (matched === 0) throw this.conflict(projectId);

      await this.events.enqueue(tx, {
        eventName: 'PROJECT_COMPLETED',
        aggregateId: projectId,
        organizationId,
        payload: { projectId, organizationId, completedBy: actor, completedAt: at.toISOString() },
        occurredAt: at,
      });
    });
    projectTransitionsTotal.inc({ service: SERVICE_NAME, command: 'complete' });

    return this.projectService.get(projectId);
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

  private conflict(projectId: string): RastaError {
    versionConflictsTotal.inc({ service: SERVICE_NAME, aggregate: 'Project' });
    return RastaError.optimisticLockFailed('Project', projectId);
  }
}
