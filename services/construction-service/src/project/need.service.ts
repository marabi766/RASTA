import { Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import type { CursorPage } from '@rasta/contracts';
import { Prisma, type ProjectNeed } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { ProjectAccess, assertOwnProject } from '../access/access';
import { transactionNow } from '../shared/clock';
import { IdempotencyStore, targeted } from '../shared/idempotency';
import { SERVICE_NAME } from '../config/env';
import { needTransitionsTotal, versionConflictsTotal } from '../observability/metrics';
import { ProjectRepository } from './project.repository';
import { assertProjectEditable } from './project.state-machine';
import { assertNeedEditable, assertNeedTransition, type NeedStateName } from './need.state-machine';
import { toNeedView } from './views';
import type {
  CreateNeedDto,
  ListNeedsQuery,
  NeedView,
  SubmitNeedDto,
  UpdateNeedDto,
  WithdrawNeedDto,
} from './dto';

/** The endpoint template idempotent need creation is stored under (docs/06 § 6.8). */
export const ADD_NEED_ENDPOINT = 'POST /v1/projects/:id/needs';

/**
 * SubmitNeed and the rest of the need lifecycle (`docs/04` § 4.12, Q-68).
 *
 * A need lives inside the project aggregate (`docs/03` § 3.3), so every command
 * here first **locks the project row** in the caller's organization and checks
 * that the project is still editable. That lock is what stops a need changing
 * under an approval request made at the same instant (PR 2), and under a
 * cancellation now. The need itself is then changed by compare-and-set on its
 * own `version`, and its event is written in the same transaction (A-08).
 *
 * A project of another organization is not found at the lock, so a need of
 * another organization is never reached: the caller gets `404` either way.
 */
@Injectable()
export class NeedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: ProjectRepository,
    private readonly events: EventPublisher,
    private readonly access: ProjectAccess,
    private readonly idempotency: IdempotencyStore,
  ) {}

  async add(projectId: string, dto: CreateNeedDto, idempotencyKey?: string): Promise<NeedView> {
    const { organizationId, actor } = this.access.assertCanWrite();

    const work = async (): Promise<NeedView> => {
      const needId = newId(ID_PREFIX.need);
      await this.prisma.transaction(async (tx) => {
        const at = await transactionNow(tx);
        await this.lockEditableProject(tx, organizationId, projectId);

        await this.repository.createNeed(tx, {
          id: needId,
          organizationId,
          projectId,
          title: dto.title,
          description: dto.description,
          quantity: dto.quantity ?? null,
          unit: dto.unit ?? null,
          estimatedCostMinor:
            dto.estimatedCostMinor === undefined ? null : BigInt(dto.estimatedCostMinor),
          actor,
          correlationId: getContext().correlationId,
          at,
        });

        await this.events.enqueue(tx, {
          eventName: 'PROJECT_NEED_ADDED',
          aggregateId: projectId,
          organizationId,
          payload: { projectId, needId, organizationId, addedBy: actor, addedAt: at.toISOString() },
          occurredAt: at,
        });
      });
      needTransitionsTotal.inc({ service: SERVICE_NAME, command: 'add' });
      return this.view(projectId, needId);
    };

    if (!idempotencyKey) return work();
    return this.idempotency.run(
      ADD_NEED_ENDPOINT,
      idempotencyKey,
      targeted(projectId, dto),
      201,
      work,
    );
  }

  async list(projectId: string, query: ListNeedsQuery): Promise<CursorPage<NeedView>> {
    const { organizationId } = this.access.assertCanRead();

    const project = await this.repository.findProject(projectId);
    if (!project) throw RastaError.notFound('Project', projectId);
    assertOwnProject(project, organizationId);

    const rows = await this.repository.listNeeds(projectId, {
      ...(query.status ? { status: query.status } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;

    return {
      items: visible.map(toNeedView),
      nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  /** UpdateNeed — a DRAFT need of an editable project. Unchanged fields publish nothing. */
  async update(projectId: string, needId: string, dto: UpdateNeedDto): Promise<NeedView> {
    const { organizationId, actor } = this.access.assertCanWrite();

    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      await this.lockEditableProject(tx, organizationId, projectId);
      const need = await this.needOrNotFound(tx, projectId, needId);
      this.assertVersion(need, dto.expectedVersion);
      assertNeedEditable(needId, need.status as NeedStateName);

      const data: Prisma.ProjectNeedUpdateManyMutationInput = {};
      const changed: string[] = [];

      if (dto.title !== undefined && dto.title !== need.title) {
        data.title = dto.title;
        changed.push('title');
      }
      if (dto.description !== undefined && dto.description !== need.description) {
        data.description = dto.description;
        changed.push('description');
      }
      if (dto.quantity !== undefined) {
        const next = dto.quantity === null ? null : new Prisma.Decimal(dto.quantity);
        const differs =
          next === null || need.quantity === null
            ? next !== need.quantity
            : !next.equals(need.quantity);
        if (differs) {
          data.quantity = next;
          changed.push('quantity');
        }
      }
      if (dto.unit !== undefined && dto.unit !== need.unit) {
        data.unit = dto.unit;
        changed.push('unit');
      }
      if (dto.estimatedCostMinor !== undefined) {
        const next = dto.estimatedCostMinor === null ? null : BigInt(dto.estimatedCostMinor);
        if (next !== need.estimatedCostMinor) {
          data.estimatedCostMinor = next;
          changed.push('estimatedCostMinor');
        }
      }

      if (changed.length === 0) return;

      const matched = await this.repository.updateNeed(tx, {
        needId,
        projectId,
        expectedVersion: dto.expectedVersion,
        from: need.status as NeedStateName,
        data: { ...data, updatedAt: at, updatedBy: actor },
      });
      if (matched === 0) throw this.conflict(needId);

      await this.events.enqueue(tx, {
        eventName: 'PROJECT_NEED_UPDATED',
        aggregateId: projectId,
        organizationId,
        payload: {
          projectId,
          needId,
          organizationId,
          changedFields: [...changed].sort(),
          updatedBy: actor,
          updatedAt: at.toISOString(),
        },
        occurredAt: at,
      });
      needTransitionsTotal.inc({ service: SERVICE_NAME, command: 'update' });
    });

    return this.view(projectId, needId);
  }

  /** SubmitNeed — DRAFT → SUBMITTED, into the project's scope. */
  async submit(projectId: string, needId: string, dto: SubmitNeedDto): Promise<NeedView> {
    const { organizationId, actor } = this.access.assertCanWrite();

    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      await this.lockEditableProject(tx, organizationId, projectId);
      const need = await this.needOrNotFound(tx, projectId, needId);
      this.assertVersion(need, dto.expectedVersion);
      assertNeedTransition(needId, need.status as NeedStateName, 'SUBMITTED');

      const matched = await this.repository.updateNeed(tx, {
        needId,
        projectId,
        expectedVersion: dto.expectedVersion,
        from: need.status as NeedStateName,
        data: {
          status: 'SUBMITTED',
          submittedAt: at,
          submittedBy: actor,
          updatedAt: at,
          updatedBy: actor,
        },
      });
      if (matched === 0) throw this.conflict(needId);

      await this.events.enqueue(tx, {
        eventName: 'PROJECT_NEED_SUBMITTED',
        aggregateId: projectId,
        organizationId,
        payload: {
          projectId,
          needId,
          organizationId,
          submittedBy: actor,
          submittedAt: at.toISOString(),
        },
        occurredAt: at,
      });
    });
    needTransitionsTotal.inc({ service: SERVICE_NAME, command: 'submit' });

    return this.view(projectId, needId);
  }

  /** WithdrawNeed — DRAFT or SUBMITTED → WITHDRAWN, with a stated reason. Terminal. */
  async withdraw(projectId: string, needId: string, dto: WithdrawNeedDto): Promise<NeedView> {
    const { organizationId, actor } = this.access.assertCanWrite();

    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      await this.lockEditableProject(tx, organizationId, projectId);
      const need = await this.needOrNotFound(tx, projectId, needId);
      this.assertVersion(need, dto.expectedVersion);
      assertNeedTransition(needId, need.status as NeedStateName, 'WITHDRAWN');

      const matched = await this.repository.updateNeed(tx, {
        needId,
        projectId,
        expectedVersion: dto.expectedVersion,
        from: need.status as NeedStateName,
        data: {
          status: 'WITHDRAWN',
          withdrawnAt: at,
          withdrawnBy: actor,
          withdrawalReason: dto.reason,
          updatedAt: at,
          updatedBy: actor,
        },
      });
      if (matched === 0) throw this.conflict(needId);

      await this.events.enqueue(tx, {
        eventName: 'PROJECT_NEED_WITHDRAWN',
        aggregateId: projectId,
        organizationId,
        payload: {
          projectId,
          needId,
          organizationId,
          reason: dto.reason,
          withdrawnBy: actor,
          withdrawnAt: at.toISOString(),
        },
        occurredAt: at,
      });
    });
    needTransitionsTotal.inc({ service: SERVICE_NAME, command: 'withdraw' });

    return this.view(projectId, needId);
  }

  // -- helpers ----------------------------------------------------------------

  private async lockEditableProject(
    tx: ExtendedPrismaClient,
    organizationId: string,
    projectId: string,
  ): Promise<void> {
    const locked = await this.repository.lockProject(tx, organizationId, projectId);
    if (!locked) throw RastaError.notFound('Project', projectId);
    assertOwnProject(locked, organizationId);
    assertProjectEditable(projectId, locked.status);
  }

  private async needOrNotFound(
    tx: ExtendedPrismaClient,
    projectId: string,
    needId: string,
  ): Promise<ProjectNeed> {
    const need = await this.repository.findNeed(tx, projectId, needId);
    if (!need) throw RastaError.notFound('ProjectNeed', needId);
    return need;
  }

  private assertVersion(need: ProjectNeed, expectedVersion: number): void {
    if (need.version !== expectedVersion) throw this.conflict(need.id);
  }

  private conflict(needId: string): RastaError {
    versionConflictsTotal.inc({ service: SERVICE_NAME, aggregate: 'ProjectNeed' });
    return RastaError.optimisticLockFailed('ProjectNeed', needId);
  }

  private async view(projectId: string, needId: string): Promise<NeedView> {
    const need = await this.repository.findNeed(this.prisma.client, projectId, needId);
    if (!need) throw RastaError.notFound('ProjectNeed', needId);
    return toNeedView(need);
  }
}
