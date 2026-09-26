import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import type { CursorPage } from '@rasta/contracts';
import type { Prisma } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { ProjectAccess, assertOwnProject } from '../access/access';
import { transactionNow } from '../shared/clock';
import { isCheckViolation } from '../shared/prisma-errors';
import { IdempotencyStore } from '../shared/idempotency';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';
import { projectTransitionsTotal, versionConflictsTotal } from '../observability/metrics';
import { ProjectRepository, type LockedProject } from './project.repository';
import { ApprovalRepository } from '../approval/approval.repository';
import { assertProjectCancellable, assertProjectEditable } from './project.state-machine';
import { toProjectSummaryView, toProjectView } from './views';
import type {
  CancelProjectDto,
  CreateProjectDto,
  ListProjectsQuery,
  ProjectSummaryView,
  ProjectView,
  UpdateProjectDto,
} from './dto';

/** The endpoint template idempotent creation is stored under (docs/06 § 6.8). */
export const CREATE_PROJECT_ENDPOINT = 'POST /v1/projects';

/**
 * CreateProject, GetProject, ListProjects, UpdateProject, CancelProject.
 *
 * Every command follows one shape, and the shape is the lifecycle guarantee
 * (ADR-063):
 *
 *   1. authorize against the configured roles, in the caller's organization;
 *   2. open a transaction and take the database's instant for it (D-5);
 *   3. lock the project row, scoped to that organization — not found is `404`;
 *   4. check `expectedVersion` (`409` if stale), then the state machine (`422`);
 *   5. compare-and-set the row, and write the event to the outbox, in the same
 *      transaction (A-08).
 *
 * A refusal at any step rolls back everything before it, event included.
 */
@Injectable()
export class ProjectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: ProjectRepository,
    private readonly events: EventPublisher,
    private readonly access: ProjectAccess,
    private readonly idempotency: IdempotencyStore,
    @Inject(ENV) private readonly env: ConstructionEnv,
    private readonly approvals: ApprovalRepository,
  ) {}

  /**
   * CreateProject. With an `Idempotency-Key`, a retry of the same request
   * returns the first response instead of creating a second project.
   */
  async create(dto: CreateProjectDto, idempotencyKey?: string): Promise<ProjectView> {
    const { organizationId, actor } = this.access.assertCanWrite();
    this.assertOperationTypeAllowed(dto.operationType);

    const work = async (): Promise<ProjectView> => {
      const projectId = newId(ID_PREFIX.project);
      await this.withCheckMapping(() =>
        this.prisma.transaction(async (tx) => {
          const at = await transactionNow(tx);
          await this.repository.createProject(tx, {
            id: projectId,
            organizationId,
            title: dto.title,
            operationType: dto.operationType,
            scopeOfWork: dto.scopeOfWork,
            locationDescription: dto.locationDescription,
            estimatedCostMinor:
              dto.estimatedCostMinor === undefined ? null : BigInt(dto.estimatedCostMinor),
            actor,
            correlationId: getContext().correlationId,
            at,
          });
          if (dto.area) {
            await this.repository.setArea(tx, organizationId, projectId, dto.area);
          }

          await this.events.enqueue(tx, {
            eventName: 'PROJECT_CREATED',
            aggregateId: projectId,
            organizationId,
            payload: {
              projectId,
              organizationId,
              title: dto.title,
              operationType: dto.operationType,
              estimatedCostMinor: dto.estimatedCostMinor ?? null,
              hasArea: dto.area !== undefined,
              createdBy: actor,
              createdAt: at.toISOString(),
            },
            occurredAt: at,
          });
        }),
      );
      projectTransitionsTotal.inc({ service: SERVICE_NAME, command: 'create' });
      return this.view(organizationId, projectId);
    };

    if (!idempotencyKey) return work();
    return this.idempotency.run(CREATE_PROJECT_ENDPOINT, idempotencyKey, dto, 201, work);
  }

  /** GetProject — the caller's own organization only; any other answers 404. */
  async get(projectId: string): Promise<ProjectView> {
    const { organizationId } = this.access.assertCanRead();
    return this.view(organizationId, projectId);
  }

  /** ListProjects — the caller's own organization, newest first. */
  async list(query: ListProjectsQuery): Promise<CursorPage<ProjectSummaryView>> {
    const { organizationId } = this.access.assertCanRead();

    const rows = await this.repository.listProjects({
      ...(query.status ? { status: query.status } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    visible.forEach((row) => assertOwnProject(row, organizationId));

    const withArea = await this.repository.projectsWithArea(
      organizationId,
      visible.map((row) => row.id),
    );

    return {
      items: visible.map((row) => toProjectSummaryView(row, withArea.has(row.id))),
      nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  /**
   * UpdateProject — only while the project is editable (DRAFT or
   * CHANGES_REQUESTED). A request that changes nothing commits nothing and
   * publishes nothing; it still has to name the current version.
   */
  async update(projectId: string, dto: UpdateProjectDto): Promise<ProjectView> {
    const { organizationId, actor } = this.access.assertCanWrite();
    if (dto.operationType !== undefined) this.assertOperationTypeAllowed(dto.operationType);

    await this.withCheckMapping(() =>
      this.prisma.transaction(async (tx) => {
        const at = await transactionNow(tx);
        const locked = await this.lockOrNotFound(tx, organizationId, projectId);
        this.assertVersion(locked, dto.expectedVersion);
        assertProjectEditable(projectId, locked.status);

        const current = await tx.project.findFirst({ where: { id: projectId } });
        if (!current) throw RastaError.notFound('Project', projectId);

        const data: Prisma.ProjectUpdateManyMutationInput = {};
        const changed: string[] = [];
        const set = <K extends keyof Prisma.ProjectUpdateManyMutationInput>(
          field: K,
          value: Prisma.ProjectUpdateManyMutationInput[K],
          differs: boolean,
        ): void => {
          if (!differs) return;
          data[field] = value;
          changed.push(field);
        };

        if (dto.title !== undefined) set('title', dto.title, dto.title !== current.title);
        if (dto.operationType !== undefined) {
          set('operationType', dto.operationType, dto.operationType !== current.operationType);
        }
        if (dto.scopeOfWork !== undefined) {
          set('scopeOfWork', dto.scopeOfWork, dto.scopeOfWork !== current.scopeOfWork);
        }
        if (dto.locationDescription !== undefined) {
          set(
            'locationDescription',
            dto.locationDescription,
            dto.locationDescription !== current.locationDescription,
          );
        }
        if (dto.estimatedCostMinor !== undefined) {
          const next = dto.estimatedCostMinor === null ? null : BigInt(dto.estimatedCostMinor);
          set('estimatedCostMinor', next, next !== current.estimatedCostMinor);
        }
        // The area cannot be compared cheaply and exactly (PostGIS re-renders
        // coordinates), so sending it counts as changing it.
        if (dto.area !== undefined) changed.push('area');

        if (changed.length === 0) return;

        const matched = await this.repository.updateProjectContent(
          tx,
          projectId,
          dto.expectedVersion,
          { ...data, updatedAt: at, updatedBy: actor },
        );
        if (matched === 0) throw this.conflict('Project', projectId);

        if (dto.area !== undefined) {
          await this.repository.setArea(tx, organizationId, projectId, dto.area);
        }

        await this.events.enqueue(tx, {
          eventName: 'PROJECT_UPDATED',
          aggregateId: projectId,
          organizationId,
          payload: {
            projectId,
            organizationId,
            changedFields: [...changed].sort(),
            updatedBy: actor,
            updatedAt: at.toISOString(),
          },
          occurredAt: at,
        });
        projectTransitionsTotal.inc({ service: SERVICE_NAME, command: 'update' });
      }),
    );

    return this.view(organizationId, projectId);
  }

  /**
   * CancelProject — terminal, with a stated reason, from the states this
   * deployment allows (`CONSTRUCTION_CANCELLABLE_STATES`, Q-69). No
   * cancellation approval is required (Q-69). Any open approval round ends
   * with it.
   */
  async cancel(projectId: string, dto: CancelProjectDto): Promise<ProjectView> {
    const { organizationId, actor } = this.access.assertCanWrite();

    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      const locked = await this.lockOrNotFound(tx, organizationId, projectId);
      this.assertVersion(locked, dto.expectedVersion);
      assertProjectCancellable(projectId, locked.status, this.env.CONSTRUCTION_CANCELLABLE_STATES);

      const matched = await this.repository.transitionProject(tx, {
        projectId,
        from: locked.status,
        to: 'CANCELLED',
        expectedVersion: dto.expectedVersion,
        reason: dto.reason,
        actor,
        at,
      });
      if (matched === 0) throw this.conflict('Project', projectId);

      // A cancelled project has no round left to decide: every undecided step
      // ends here, in the same transaction, so no authority can decide a step
      // of a project that no longer exists as a proposal.
      await this.approvals.supersedeOpen(tx, { organizationId, projectId }, at);

      await this.events.enqueue(tx, {
        eventName: 'PROJECT_STATUS_CHANGED',
        aggregateId: projectId,
        organizationId,
        payload: {
          projectId,
          organizationId,
          from: locked.status,
          to: 'CANCELLED',
          reason: dto.reason,
          changedBy: actor,
          changedAt: at.toISOString(),
        },
        occurredAt: at,
      });
    });
    projectTransitionsTotal.inc({ service: SERVICE_NAME, command: 'cancel' });

    return this.view(organizationId, projectId);
  }

  // -- helpers ----------------------------------------------------------------

  private async view(organizationId: string, projectId: string): Promise<ProjectView> {
    const row = await this.repository.findProject(projectId);
    if (!row) throw RastaError.notFound('Project', projectId);
    assertOwnProject(row, organizationId);

    const [area, needsSummary] = await Promise.all([
      this.repository.readArea(organizationId, projectId),
      this.repository.needsSummary(projectId),
    ]);
    return toProjectView(row, area, needsSummary);
  }

  private async lockOrNotFound(
    tx: ExtendedPrismaClient,
    organizationId: string,
    projectId: string,
  ): Promise<LockedProject> {
    const locked = await this.repository.lockProject(tx, organizationId, projectId);
    if (!locked) throw RastaError.notFound('Project', projectId);
    assertOwnProject(locked, organizationId);
    return locked;
  }

  private assertVersion(locked: LockedProject, expectedVersion: number): void {
    if (locked.version !== expectedVersion) throw this.conflict('Project', locked.id);
  }

  private conflict(aggregate: string, id: string): RastaError {
    versionConflictsTotal.inc({ service: SERVICE_NAME, aggregate });
    return RastaError.optimisticLockFailed(aggregate, id);
  }

  /** Q-68: free text unless the deployment configures a list. */
  private assertOperationTypeAllowed(operationType: string): void {
    const allowed = this.env.CONSTRUCTION_OPERATION_TYPES;
    if (allowed.length === 0 || allowed.includes(operationType)) return;

    throw RastaError.validation([
      {
        path: 'operationType',
        code: 'NOT_ALLOWED',
        message: `operationType must be one of the configured values: ${allowed.join(', ')}`,
      },
    ]);
  }

  /**
   * A CHECK refusal is almost always `ck_project_area_valid` — the DTO has
   * already enforced every other rule — so it is reported as a 400 on `area`
   * rather than as a 500.
   */
  private async withCheckMapping<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (
        isCheckViolation(error) &&
        String((error as Error).message).includes('ck_project_area_valid')
      ) {
        throw RastaError.validation([
          {
            path: 'area',
            code: 'INVALID_GEOMETRY',
            message:
              'The operating area is not a valid polygon (for example, a ring crosses itself)',
          },
        ]);
      }
      throw error;
    }
  }
}
