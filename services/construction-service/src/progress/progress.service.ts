import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import type { CursorPage } from '@rasta/contracts';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import type { ProgressReport } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher } from '../events/publisher';
import { ProjectAccess, assertOwnProject } from '../access/access';
import { transactionNow } from '../shared/clock';
import { IdempotencyStore, targeted, type RecordCompletion } from '../shared/idempotency';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ConstructionEnv } from '../config/env';
import { versionConflictsTotal } from '../observability/metrics';
import { ProjectRepository, type LockedProject } from '../project/project.repository';
import { assertProgressTransition, type ProgressStateName } from './progress.state-machine';
import type {
  CreateProgressDto,
  ListProgressQuery,
  ProgressTransitionDto,
  ProgressView,
} from './dto';

export const DRAFT_PROGRESS_ENDPOINT = 'POST /v1/projects/:id/progress';

/**
 * The project's latest submitted report: the highest submission sequence,
 * assigned under the project row lock — never `submittedAt`, which two
 * submissions in one millisecond share. Callers hold the project lock.
 */
export function latestSubmitted(
  tx: ExtendedPrismaClient,
  projectId: string,
): Promise<ProgressReport | null> {
  return tx.progressReport.findFirst({
    where: { projectId, status: 'SUBMITTED' },
    orderBy: { submissionSequence: 'desc' },
  });
}

/**
 * SubmitProgressReport and its draft lifecycle (`docs/04` § 4.12, Q-72).
 *
 * A report is drafted, then submitted (immutable) or discarded. Drafting and
 * submitting need the project IN_PROGRESS; a submitted report may not report
 * less than the last one unless `CONSTRUCTION_PROGRESS_ALLOW_DECREASE` is on.
 * Every command locks the project row, so a report cannot be submitted while
 * the project is being completed.
 */
@Injectable()
export class ProgressService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectRepository,
    private readonly events: EventPublisher,
    private readonly access: ProjectAccess,
    @Inject(ENV) private readonly env: ConstructionEnv,
    private readonly idempotency: IdempotencyStore,
  ) {}

  /**
   * Drafts a progress report. With an `Idempotency-Key`, a retry of the same
   * request returns the first draft instead of a second one; the same key with
   * a different body or project is `409 IDEMPOTENCY_KEY_REUSED`.
   */
  async draft(
    projectId: string,
    dto: CreateProgressDto,
    idempotencyKey?: string,
  ): Promise<ProgressView> {
    const { organizationId, actor } = this.access.assertCanWrite();
    return this.idempotency.run(
      DRAFT_PROGRESS_ENDPOINT,
      idempotencyKey,
      targeted(projectId, dto),
      201,
      (record) => this.writeDraft(organizationId, actor, projectId, dto, record),
    );
  }

  private async writeDraft(
    organizationId: string,
    actor: string,
    projectId: string,
    dto: CreateProgressDto,
    record: RecordCompletion<ProgressView>,
  ): Promise<ProgressView> {
    const reportId = `${ID_PREFIXES.progressReport}_${ulid()}`;

    return this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      await this.lockExecutingProject(tx, organizationId, projectId);

      await tx.progressReport.create({
        data: {
          id: reportId,
          organizationId,
          projectId,
          progressBasisPoints: dto.progressBasisPoints,
          materials: dto.materials ?? null,
          machinery: dto.machinery ?? null,
          labor: dto.labor ?? null,
          obstacles: dto.obstacles ?? null,
          assetsUsed: dto.assetsUsed,
          status: 'DRAFT',
          createdAt: at,
          createdBy: actor,
          createdCorrelationId: getContext().correlationId,
          updatedAt: at,
          updatedBy: actor,
        },
      });

      await this.events.enqueue(tx, {
        eventName: 'PROJECT_PROGRESS_REPORT_DRAFTED',
        aggregateId: projectId,
        organizationId,
        payload: {
          projectId,
          reportId,
          organizationId,
          draftedBy: actor,
          draftedAt: at.toISOString(),
        },
        occurredAt: at,
      });

      // The draft and its key's completion commit together.
      const created = await this.view(projectId, reportId, tx);
      await record(tx, reportId, created);
      return created;
    });
  }

  async submit(
    projectId: string,
    reportId: string,
    dto: ProgressTransitionDto,
  ): Promise<ProgressView> {
    const { organizationId, actor } = this.access.assertCanWrite();

    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      await this.lockExecutingProject(tx, organizationId, projectId);
      const report = await this.reportOrNotFound(tx, projectId, reportId);
      if (report.version !== dto.expectedVersion) throw this.conflict(reportId);
      assertProgressTransition(reportId, report.status as ProgressStateName, 'SUBMITTED');

      // The project row is locked, so this is the latest submission and the
      // next sequence number is ours alone: order never depends on the clock.
      const last = await latestSubmitted(tx, projectId);
      const submissionSequence = (last?.submissionSequence ?? 0) + 1;

      if (!this.env.CONSTRUCTION_PROGRESS_ALLOW_DECREASE) {
        if (last && report.progressBasisPoints < last.progressBasisPoints) {
          throw RastaError.businessRule(
            `Progress may not go down: the last submitted report says ${last.progressBasisPoints} ` +
              `basis points (CONSTRUCTION_PROGRESS_ALLOW_DECREASE)`,
            {
              projectId,
              reportId,
              last: last.progressBasisPoints,
              submitted: report.progressBasisPoints,
            },
          );
        }
      }

      const matched = await this.transition(tx, report, dto.expectedVersion, {
        status: 'SUBMITTED',
        submittedAt: at,
        submittedBy: actor,
        submissionSequence,
        updatedAt: at,
        updatedBy: actor,
      });
      if (matched === 0) throw this.conflict(reportId);

      await this.events.enqueue(tx, {
        eventName: 'PROJECT_PROGRESS_UPDATED',
        aggregateId: projectId,
        organizationId,
        payload: {
          projectId,
          reportId,
          organizationId,
          progressBasisPoints: report.progressBasisPoints,
          submittedBy: actor,
          submittedAt: at.toISOString(),
        },
        occurredAt: at,
      });
    });

    return this.view(projectId, reportId);
  }

  /** Discards a draft, in any project state: it is the author's unsubmitted work. */
  async discard(
    projectId: string,
    reportId: string,
    dto: ProgressTransitionDto,
  ): Promise<ProgressView> {
    const { organizationId, actor } = this.access.assertCanWrite();

    await this.prisma.transaction(async (tx) => {
      const at = await transactionNow(tx);
      await this.lockOrNotFound(tx, organizationId, projectId);
      const report = await this.reportOrNotFound(tx, projectId, reportId);
      if (report.version !== dto.expectedVersion) throw this.conflict(reportId);
      assertProgressTransition(reportId, report.status as ProgressStateName, 'DISCARDED');

      const matched = await this.transition(tx, report, dto.expectedVersion, {
        status: 'DISCARDED',
        discardedAt: at,
        discardedBy: actor,
        updatedAt: at,
        updatedBy: actor,
      });
      if (matched === 0) throw this.conflict(reportId);

      await this.events.enqueue(tx, {
        eventName: 'PROJECT_PROGRESS_REPORT_DISCARDED',
        aggregateId: projectId,
        organizationId,
        payload: {
          projectId,
          reportId,
          organizationId,
          discardedBy: actor,
          discardedAt: at.toISOString(),
        },
        occurredAt: at,
      });
    });

    return this.view(projectId, reportId);
  }

  async list(projectId: string, query: ListProgressQuery): Promise<CursorPage<ProgressView>> {
    const { organizationId } = this.access.assertCanRead();
    const project = await this.projects.findProject(projectId);
    if (!project) throw RastaError.notFound('Project', projectId);
    assertOwnProject(project, organizationId);

    const rows = await this.prisma.client.progressReport.findMany({
      where: {
        projectId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      items: visible.map(toProgressView),
      nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  private async transition(
    tx: ExtendedPrismaClient,
    report: ProgressReport,
    expectedVersion: number,
    data: Record<string, unknown>,
  ): Promise<number> {
    const result = await tx.progressReport.updateMany({
      where: {
        id: report.id,
        projectId: report.projectId,
        status: 'DRAFT',
        version: expectedVersion,
      },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count;
  }

  private async lockExecutingProject(
    tx: ExtendedPrismaClient,
    organizationId: string,
    projectId: string,
  ): Promise<void> {
    const locked = await this.lockOrNotFound(tx, organizationId, projectId);
    if (locked.status !== 'IN_PROGRESS') {
      throw RastaError.businessRule(
        `Project ${projectId} is ${locked.status}; progress is reported only while it is IN_PROGRESS`,
        { projectId, status: locked.status },
      );
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

  private async reportOrNotFound(
    tx: ExtendedPrismaClient,
    projectId: string,
    reportId: string,
  ): Promise<ProgressReport> {
    const report = await tx.progressReport.findFirst({ where: { id: reportId, projectId } });
    if (!report) throw RastaError.notFound('ProgressReport', reportId);
    return report;
  }

  private async view(
    projectId: string,
    reportId: string,
    db: ExtendedPrismaClient = this.prisma.client,
  ): Promise<ProgressView> {
    const report = await db.progressReport.findFirst({
      where: { id: reportId, projectId },
    });
    if (!report) throw RastaError.notFound('ProgressReport', reportId);
    return toProgressView(report);
  }

  private conflict(reportId: string): RastaError {
    versionConflictsTotal.inc({ service: SERVICE_NAME, aggregate: 'ProgressReport' });
    return RastaError.optimisticLockFailed('ProgressReport', reportId);
  }
}

export function toProgressView(row: ProgressReport): ProgressView {
  return {
    id: row.id,
    projectId: row.projectId,
    progressBasisPoints: row.progressBasisPoints,
    materials: row.materials,
    machinery: row.machinery,
    labor: row.labor,
    obstacles: row.obstacles,
    assetsUsed: row.assetsUsed,
    status: row.status as ProgressStateName,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    submittedBy: row.submittedBy,
    submissionSequence: row.submissionSequence,
    discardedAt: row.discardedAt?.toISOString() ?? null,
    discardedBy: row.discardedBy,
    version: row.version,
  };
}
