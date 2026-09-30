import { Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import { withFinancialSpan } from '@rasta/observability';
import type { CursorPage } from '@rasta/contracts';
import type { CriteriaTemplate, TenderCriterion } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { ProjectAccess, assertOwnTender } from '../access/access';
import { transactionNow } from '../shared/clock';
import { isCheckViolation, isUniqueViolation } from '../shared/prisma-errors';
import { IdempotencyStore, type RecordCompletion } from '../shared/idempotency';
import { SERVICE_NAME } from '../config/env';
import { tenderTransitionsTotal, versionConflictsTotal } from '../observability/metrics';
import { CriteriaRepository } from './criteria.repository';
import { TenderRepository } from './tender.repository';
import { assertTenderEditable } from './tender.state-machine';
import {
  TOTAL_WEIGHT_BP,
  criteriaListSchema,
  type CreateCriteriaTemplateDto,
  type CriteriaTemplateView,
  type CriteriaView,
  type CriterionInput,
  type ListCriteriaTemplatesQuery,
  type SetCriteriaDto,
} from './criteria.dto';

/** The endpoint template idempotent template creation is stored under (docs/06 § 6.8). */
export const CREATE_TEMPLATE_ENDPOINT = 'POST /v1/criteria-templates';

const totalOf = (criteria: readonly { weightBp: number }[]): number =>
  criteria.reduce((sum, criterion) => sum + criterion.weightBp, 0);

/**
 * Criteria templates and a DRAFT tender's criteria (ADR-067 § 1).
 *
 * Setting a tender's criteria is a change to the tender: it locks the tender row,
 * checks `expectedVersion`, and bumps the version by compare-and-set, so it
 * serialises with every other command on that tender (publishing included). The
 * list is replaced whole; the database refuses it once the tender is not a DRAFT.
 */
@Injectable()
export class CriteriaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: CriteriaRepository,
    private readonly tenders: TenderRepository,
    private readonly events: EventPublisher,
    private readonly access: ProjectAccess,
    private readonly idempotency: IdempotencyStore,
  ) {}

  // -- templates --------------------------------------------------------------

  /** CreateCriteriaTemplate: the next version of a label. A template is never edited. */
  async createTemplate(
    dto: CreateCriteriaTemplateDto,
    idempotencyKey?: string,
  ): Promise<CriteriaTemplateView> {
    const { organizationId, actor } = this.access.assertCanWrite();

    const work = async (
      record: RecordCompletion<CriteriaTemplateView>,
    ): Promise<CriteriaTemplateView> => {
      const templateId = newId(ID_PREFIX.criteriaTemplate);
      try {
        return await this.prisma.transaction(async (tx) => {
          const at = await transactionNow(tx);
          const version = await this.repository.nextTemplateVersion(tx, dto.label);
          await this.repository.createTemplate(tx, {
            id: templateId,
            organizationId,
            label: dto.label,
            criteria: dto.criteria,
            version,
            actor,
            correlationId: getContext().correlationId,
            at,
          });
          await this.events.enqueue(tx, {
            eventName: 'CRITERIA_TEMPLATE_CREATED',
            aggregateId: templateId,
            organizationId,
            payload: {
              templateId,
              organizationId,
              version,
              criteriaCount: dto.criteria.length,
              totalWeightBp: totalOf(dto.criteria),
              createdBy: actor,
              createdAt: at.toISOString(),
            },
            occurredAt: at,
          });
          const created = await this.templateView(organizationId, templateId, tx);
          await record(tx, templateId, created);
          return created;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Two versions of one label drew the same number. Nothing was written.
          throw new RastaError(
            'CONFLICT',
            'Another version of this template was created at the same time; retry',
            { internalContext: { label: dto.label } },
          );
        }
        throw error;
      }
    };

    return this.idempotency.run(CREATE_TEMPLATE_ENDPOINT, idempotencyKey, dto, 201, work);
  }

  async getTemplate(templateId: string): Promise<CriteriaTemplateView> {
    const { organizationId } = this.access.assertCanRead();
    return this.templateView(organizationId, templateId);
  }

  async listTemplates(
    query: ListCriteriaTemplatesQuery,
  ): Promise<CursorPage<CriteriaTemplateView>> {
    const { organizationId } = this.access.assertCanRead();
    const rows = await this.repository.listTemplates({
      ...(query.label ? { label: query.label } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    const hasMore = rows.length > query.limit;
    const visible = hasMore ? rows.slice(0, query.limit) : rows;
    visible.forEach((row) => this.assertOwnTemplate(row, organizationId));
    return {
      items: visible.map((row) => toTemplateView(row)),
      nextCursor: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
      hasMore,
    };
  }

  // -- a tender's criteria ----------------------------------------------------

  /**
   * SetCriteria: replace the criteria of a DRAFT tender with a template's or with
   * the ones given. Publishing later requires the weights to sum to exactly
   * 10000; setting only refuses more than that.
   */
  async setCriteria(tenderId: string, dto: SetCriteriaDto): Promise<CriteriaView> {
    const { organizationId, actor } = this.access.assertCanWrite();

    // The answer is read inside the transaction, with the tender still locked: read
    // after the commit, a second change could land in between and this one would
    // report its state and version (the class of defect Codex found in #162).
    let view: CriteriaView;
    try {
      view = await withFinancialSpan(
        'construction.tender.set-criteria',
        () =>
          this.prisma.transaction(async (tx) => {
            const at = await transactionNow(tx);
            const locked = await this.tenders.lockTender(tx, organizationId, tenderId);
            if (!locked) throw RastaError.notFound('Tender', tenderId);
            assertOwnTender(locked, organizationId);
            if (locked.version !== dto.expectedVersion) throw this.conflict(tenderId);
            assertTenderEditable(tenderId, locked.status);

            let criteria: CriterionInput[];
            let templateId: string | null = null;
            if (dto.templateId !== undefined) {
              const template = await this.repository.findTemplate(dto.templateId, tx);
              if (!template) throw RastaError.notFound('CriteriaTemplate', dto.templateId);
              this.assertOwnTemplate(template, organizationId);
              // Re-checked on the way out: a template is data, and data is not trusted
              // just because this service once wrote it.
              criteria = criteriaListSchema.parse(template.criteria);
              templateId = template.id;
            } else {
              criteria = dto.criteria ?? [];
            }

            const matched = await this.tenders.updateTenderContent(
              tx,
              tenderId,
              dto.expectedVersion,
              { updatedAt: at, updatedBy: actor },
            );
            if (matched === 0) throw this.conflict(tenderId);

            await this.repository.replaceCriteria(tx, {
              organizationId,
              tenderId,
              criteria,
              templateId,
              newId: () => newId(ID_PREFIX.criterion),
              actor,
              at,
            });

            await this.events.enqueue(tx, {
              eventName: 'TENDER_CRITERIA_SET',
              aggregateId: tenderId,
              organizationId,
              payload: {
                tenderId,
                projectId: locked.projectId,
                organizationId,
                criteriaCount: criteria.length,
                totalWeightBp: totalOf(criteria),
                templateId,
                setBy: actor,
                setAt: at.toISOString(),
              },
              occurredAt: at,
            });
            return this.criteriaView(tx, organizationId, tenderId);
          }),
        { 'rasta.tender.command': 'set-criteria' },
      );
    } catch (error) {
      // The freeze trigger is the backstop for a status this method did not see.
      if (
        isCheckViolation(error) &&
        String((error as Error).message).includes('ck_tender_criteria_frozen')
      ) {
        throw RastaError.businessRule(
          `Tender ${tenderId} is no longer a DRAFT; its criteria are frozen`,
          { tenderId },
        );
      }
      throw error;
    }
    tenderTransitionsTotal.inc({ service: SERVICE_NAME, command: 'set-criteria' });

    return view;
  }

  async getCriteria(tenderId: string): Promise<CriteriaView> {
    const { organizationId } = this.access.assertCanRead();
    return this.criteriaView(this.prisma.client, organizationId, tenderId);
  }

  // -- helpers ----------------------------------------------------------------

  /** A tender's criteria and version, read through `client` (a transaction's, when it must match a write). */
  private async criteriaView(
    client: ExtendedPrismaClient,
    organizationId: string,
    tenderId: string,
  ): Promise<CriteriaView> {
    const tender = await this.tenders.findTender(tenderId, client);
    if (!tender) throw RastaError.notFound('Tender', tenderId);
    assertOwnTender(tender, organizationId);
    const rows = await this.repository.listCriteria(tenderId, client);
    return toCriteriaView(tender.id, tender.version, rows);
  }

  private async templateView(
    organizationId: string,
    templateId: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<CriteriaTemplateView> {
    const row = await this.repository.findTemplate(templateId, client);
    if (!row) throw RastaError.notFound('CriteriaTemplate', templateId);
    this.assertOwnTemplate(row, organizationId);
    return toTemplateView(row);
  }

  private assertOwnTemplate(row: CriteriaTemplate, organizationId: string): void {
    if (row.organizationId !== organizationId) {
      throw RastaError.notFound('CriteriaTemplate', row.id);
    }
  }

  private conflict(tenderId: string): RastaError {
    versionConflictsTotal.inc({ service: SERVICE_NAME, aggregate: 'Tender' });
    return RastaError.optimisticLockFailed('Tender', tenderId);
  }
}

function toTemplateView(row: CriteriaTemplate): CriteriaTemplateView {
  const criteria = criteriaListSchema.parse(row.criteria);
  return {
    id: row.id,
    organizationId: row.organizationId,
    label: row.label,
    version: row.version,
    criteria,
    totalWeightBp: totalOf(criteria),
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
  };
}

function toCriteriaView(
  tenderId: string,
  version: number,
  rows: readonly TenderCriterion[],
): CriteriaView {
  const total = totalOf(rows);
  return {
    tenderId,
    items: rows.map((row) => ({
      id: row.id,
      position: row.position,
      code: row.code,
      label: row.label,
      weightBp: row.weightBp,
      scoringMethod: row.scoringMethod,
      maxScore: row.maxScore,
      templateId: row.templateId,
    })),
    totalWeightBp: total,
    complete: total === TOTAL_WEIGHT_BP,
    version,
  };
}
