import { Injectable } from '@nestjs/common';
import { RastaError, currentActor, getContext } from '@rasta/nest-common';
import { withFinancialSpan } from '@rasta/observability';
import type { CursorPage } from '@rasta/contracts';
import type { Prisma } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { storedIdentityOf } from '../shared/stable-actor';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { ProjectAccess, assertOwnTender } from '../access/access';
import { transactionNow } from '../shared/clock';
import { IdempotencyStore, targeted, type RecordCompletion } from '../shared/idempotency';
import { SERVICE_NAME } from '../config/env';
import { tenderTransitionsTotal, versionConflictsTotal } from '../observability/metrics';
import { ProjectRepository } from '../project/project.repository';
import { TenderRepository, type LockedTender } from './tender.repository';
import { assertTenderEditable, assertTenderTransition } from './tender.state-machine';
import { toTenderSummaryView, toTenderView } from './views';
import type {
  CancelTenderDto,
  CreateTenderDto,
  ListTendersQuery,
  TenderSummaryView,
  TenderView,
  UpdateTenderDto,
} from './dto';

/** The endpoint template idempotent tender creation is stored under (docs/06 § 6.8). */
export const CREATE_TENDER_ENDPOINT = 'POST /v1/projects/:id/tenders';

/**
 * CreateTender, GetTender, ListTenders, UpdateTender, CancelTender.
 *
 * Every command follows the shape ADR-063 fixed for projects, and ADR-065 keeps:
 *
 *   1. authorize against the configured roles, in the caller's organization;
 *   2. open a transaction and take the database's instant for it (D-5);
 *   3. lock the row — the project for `create`, the tender for the rest — scoped
 *      to that organization; not found is `404`;
 *   4. check `expectedVersion` (`409` if stale), then the state machine (`422`);
 *   5. compare-and-set the row, and write the event to the outbox, in the same
 *      transaction (A-08).
 *
 * A refusal at any step rolls back everything before it, event included.
 *
 * ## Who
 *
 * The owner side reuses the project roles (`CONSTRUCTION_PROJECT_ROLES` to
 * write, plus `…_READER_ROLES` to read; Q-69): a tender is a step of the
 * project's life, and no document names a separate tendering role. Bidders are
 * other organizations and arrive with bids (ADR-065 § 4).
 *
 * ## What a state change costs the trace
 *
 * Every command runs in an always-sampled span (`docs/13` § 13.6: a tender
 * transition is a trace an auditor will ask for). The span carries the command
 * name only — no identifier of a person, no title, no text.
 */
@Injectable()
export class TenderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: TenderRepository,
    private readonly projects: ProjectRepository,
    private readonly events: EventPublisher,
    private readonly access: ProjectAccess,
    private readonly idempotency: IdempotencyStore,
  ) {}

  /**
   * CreateTender under an `APPROVED` project of the caller's organization.
   * Takes the project lock, so it serialises with cancelling the project: a
   * tender cannot appear under a project that is being cancelled.
   */
  async create(
    projectId: string,
    dto: CreateTenderDto,
    idempotencyKey?: string,
  ): Promise<TenderView> {
    const { organizationId, actor } = this.access.assertCanWrite();

    const work = async (record: RecordCompletion<TenderView>): Promise<TenderView> => {
      const tenderId = newId(ID_PREFIX.tender);
      const view = await withFinancialSpan(
        'construction.tender.create',
        () =>
          this.prisma.transaction(async (tx) => {
            const at = await transactionNow(tx);
            const project = await this.projects.lockProject(tx, organizationId, projectId);
            if (!project) throw RastaError.notFound('Project', projectId);
            if (project.status !== 'APPROVED') {
              throw RastaError.businessRule(
                `Project ${projectId} is ${project.status}; a tender is created only under an APPROVED project`,
                { projectId, status: project.status },
              );
            }

            await this.repository.createTender(tx, {
              id: tenderId,
              organizationId,
              projectId,
              title: dto.title,
              scopeOfWork: dto.scopeOfWork,
              procurementNature: dto.procurementNature ?? null,
              visibility: dto.visibility ?? null,
              bidOpeningAt: dto.bidOpeningAt ? new Date(dto.bidOpeningAt) : null,
              bidClosingAt: dto.bidClosingAt ? new Date(dto.bidClosingAt) : null,
              actor,
              actorIdentity: storedIdentityOf(currentActor()),
              correlationId: getContext().correlationId,
              at,
            });

            await this.events.enqueue(tx, {
              eventName: 'TENDER_CREATED',
              aggregateId: tenderId,
              organizationId,
              payload: {
                tenderId,
                projectId,
                organizationId,
                procurementNature: dto.procurementNature ?? null,
                createdBy: actor,
                createdAt: at.toISOString(),
              },
              occurredAt: at,
            });

            // The response, read in the same transaction, and the key's
            // completion with it: the tender and its key commit together.
            const created = await this.view(organizationId, tenderId, tx);
            await record(tx, tenderId, created);
            return created;
          }),
        { 'rasta.tender.command': 'create' },
      );
      tenderTransitionsTotal.inc({ service: SERVICE_NAME, command: 'create' });
      return view;
    };

    return this.idempotency.run(
      CREATE_TENDER_ENDPOINT,
      idempotencyKey,
      targeted(projectId, dto),
      201,
      work,
    );
  }

  /** GetTender — the caller's own organization only; any other answers 404. */
  async get(tenderId: string): Promise<TenderView> {
    const { organizationId } = this.access.assertCanRead();
    return this.view(organizationId, tenderId);
  }

  /** ListTenders — the caller's own organization, newest first. */
  async list(query: ListTendersQuery): Promise<CursorPage<TenderSummaryView>> {
    const { organizationId } = this.access.assertCanRead();

    const rows = await this.repository.listTenders({
      ...(query.status ? { status: query.status } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    visible.forEach((row) => assertOwnTender(row, organizationId));

    return {
      items: visible.map(toTenderSummaryView),
      nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  /**
   * UpdateTender — only while the tender is a DRAFT. A request that changes
   * nothing commits nothing and publishes nothing; it still has to name the
   * current version.
   */
  async update(tenderId: string, dto: UpdateTenderDto): Promise<TenderView> {
    const { organizationId, actor } = this.access.assertCanWrite();

    // The response is read **inside** the transaction, while the tender row is
    // still locked: read after the commit, a second edit could land in between
    // and this one would report the other's fields and version (Codex review of
    // #162). What a caller is told is the state their own change produced.
    return withFinancialSpan(
      'construction.tender.update',
      () =>
        this.prisma.transaction(async (tx) => {
          const at = await transactionNow(tx);
          const locked = await this.lockOrNotFound(tx, organizationId, tenderId);
          this.assertVersion(locked, dto.expectedVersion);
          assertTenderEditable(tenderId, locked.status);

          const current = await tx.tender.findFirst({ where: { id: tenderId } });
          if (!current) throw RastaError.notFound('Tender', tenderId);

          const data: Prisma.TenderUpdateManyMutationInput = {};
          const changed: string[] = [];
          const set = <K extends keyof Prisma.TenderUpdateManyMutationInput>(
            field: K,
            value: Prisma.TenderUpdateManyMutationInput[K],
            differs: boolean,
          ): void => {
            if (!differs) return;
            data[field] = value;
            changed.push(field);
          };
          const sameInstant = (a: Date | null, b: string | null | undefined): boolean =>
            (a?.getTime() ?? null) === (b ? Date.parse(b) : null);

          if (dto.title !== undefined) set('title', dto.title, dto.title !== current.title);
          if (dto.scopeOfWork !== undefined) {
            set('scopeOfWork', dto.scopeOfWork, dto.scopeOfWork !== current.scopeOfWork);
          }
          if (dto.procurementNature !== undefined) {
            set(
              'procurementNature',
              dto.procurementNature,
              dto.procurementNature !== current.procurementNature,
            );
          }
          if (dto.visibility !== undefined) {
            set('visibility', dto.visibility, dto.visibility !== current.visibility);
          }
          if (dto.bidOpeningAt !== undefined) {
            set(
              'bidOpeningAt',
              dto.bidOpeningAt === null ? null : new Date(dto.bidOpeningAt),
              !sameInstant(current.bidOpeningAt, dto.bidOpeningAt),
            );
          }
          if (dto.bidClosingAt !== undefined) {
            set(
              'bidClosingAt',
              dto.bidClosingAt === null ? null : new Date(dto.bidClosingAt),
              !sameInstant(current.bidClosingAt, dto.bidClosingAt),
            );
          }

          // Nothing to write: the tender as it stands, at the version just checked.
          if (changed.length === 0) return this.view(organizationId, tenderId, tx);

          const matched = await this.repository.updateTenderContent(
            tx,
            tenderId,
            dto.expectedVersion,
            { ...data, updatedAt: at, updatedBy: actor },
          );
          if (matched === 0) throw this.conflict(tenderId);

          await this.events.enqueue(tx, {
            eventName: 'TENDER_UPDATED',
            aggregateId: tenderId,
            organizationId,
            payload: {
              tenderId,
              projectId: locked.projectId,
              organizationId,
              changedFields: [...changed].sort(),
              updatedBy: actor,
              updatedAt: at.toISOString(),
            },
            occurredAt: at,
          });
          tenderTransitionsTotal.inc({ service: SERVICE_NAME, command: 'update' });
          return this.view(organizationId, tenderId, tx);
        }),
      { 'rasta.tender.command': 'update' },
    );
  }

  /**
   * CancelTender — terminal, with a stated reason. PR 2 can cancel only a DRAFT
   * (later steps have live tenders to cancel, and approval gates); the
   * transition table already allows every live state. The prose reason stays
   * in the database; the event carries the closed code `OWNER_REQUEST`.
   */
  async cancel(tenderId: string, dto: CancelTenderDto): Promise<TenderView> {
    const { organizationId, actor } = this.access.assertCanWrite();

    // Read inside the transaction, like `update`, so the answer is the state this
    // cancellation produced.
    const view = await withFinancialSpan(
      'construction.tender.cancel',
      () =>
        this.prisma.transaction(async (tx) => {
          const at = await transactionNow(tx);
          const locked = await this.lockOrNotFound(tx, organizationId, tenderId);
          this.assertVersion(locked, dto.expectedVersion);
          assertTenderTransition(tenderId, locked.status, 'CANCELLED');

          const matched = await this.repository.transitionTender(tx, {
            tenderId,
            from: locked.status,
            to: 'CANCELLED',
            expectedVersion: dto.expectedVersion,
            reason: dto.reason,
            reasonCode: 'OWNER_REQUEST',
            actor,
            at,
          });
          if (matched === 0) throw this.conflict(tenderId);

          await this.events.enqueue(tx, {
            eventName: 'TENDER_CANCELLED',
            aggregateId: tenderId,
            organizationId,
            payload: {
              tenderId,
              projectId: locked.projectId,
              organizationId,
              from: locked.status,
              reasonCode: 'OWNER_REQUEST',
              cancelledBy: actor,
              cancelledAt: at.toISOString(),
            },
            occurredAt: at,
          });
          return this.view(organizationId, tenderId, tx);
        }),
      { 'rasta.tender.command': 'cancel' },
    );
    tenderTransitionsTotal.inc({ service: SERVICE_NAME, command: 'cancel' });

    return view;
  }

  // -- helpers ----------------------------------------------------------------

  private async view(
    organizationId: string,
    tenderId: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<TenderView> {
    const row = await this.repository.findTender(tenderId, client);
    if (!row) throw RastaError.notFound('Tender', tenderId);
    assertOwnTender(row, organizationId);
    return toTenderView(row);
  }

  private async lockOrNotFound(
    tx: ExtendedPrismaClient,
    organizationId: string,
    tenderId: string,
  ): Promise<LockedTender> {
    const locked = await this.repository.lockTender(tx, organizationId, tenderId);
    if (!locked) throw RastaError.notFound('Tender', tenderId);
    assertOwnTender(locked, organizationId);
    return locked;
  }

  private assertVersion(locked: LockedTender, expectedVersion: number): void {
    if (locked.version !== expectedVersion) throw this.conflict(locked.id);
  }

  private conflict(tenderId: string): RastaError {
    versionConflictsTotal.inc({ service: SERVICE_NAME, aggregate: 'Tender' });
    return RastaError.optimisticLockFailed('Tender', tenderId);
  }
}
