import { Injectable } from '@nestjs/common';
import type { CriteriaTemplate, TenderCriterion } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { CriterionInput } from './criteria.dto';

/**
 * Criteria templates and a tender's criteria.
 *
 * Every call goes through the tenant guard (`CriteriaTemplate` and
 * `TenderCriterion` are tenant-scoped): another organization's template or
 * criteria are never found, and the caller gets the `404` a missing row gives.
 * There is no raw SQL and no `runUnscoped` here. The freeze after publication is
 * the database's (`tg_tender_criterion_freeze`), not this class's: it holds for
 * every write path, and a write it refuses surfaces as a check violation.
 */

export interface TemplateCreateInput {
  id: string;
  organizationId: string;
  label: string;
  criteria: CriterionInput[];
  actor: string;
  correlationId: string;
  at: Date;
}

export interface TemplateListFilter {
  label?: string;
  cursor?: string;
  limit: number;
}

@Injectable()
export class CriteriaRepository {
  constructor(private readonly prisma: PrismaService) {}

  // -- templates --------------------------------------------------------------

  /** The next version of a label: one past the highest this organization has. */
  async nextTemplateVersion(tx: ExtendedPrismaClient, label: string): Promise<number> {
    const highest = await tx.criteriaTemplate.aggregate({
      where: { label },
      _max: { version: true },
    });
    return (highest._max.version ?? 0) + 1;
  }

  async createTemplate(
    tx: ExtendedPrismaClient,
    input: TemplateCreateInput & { version: number },
  ): Promise<void> {
    await tx.criteriaTemplate.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        label: input.label,
        version: input.version,
        criteria: input.criteria as unknown as object,
        createdAt: input.at,
        createdBy: input.actor,
        createdCorrelationId: input.correlationId,
      },
    });
  }

  async findTemplate(
    templateId: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<CriteriaTemplate | null> {
    return client.criteriaTemplate.findFirst({ where: { id: templateId } });
  }

  /** Newest first: the id is a ULID, so ordering by it is ordering by creation. */
  async listTemplates(filter: TemplateListFilter): Promise<CriteriaTemplate[]> {
    return this.prisma.client.criteriaTemplate.findMany({
      where: {
        ...(filter.label ? { label: filter.label } : {}),
        ...(filter.cursor ? { id: { lt: filter.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: filter.limit + 1,
    });
  }

  // -- a tender's criteria ----------------------------------------------------

  async listCriteria(
    tenderId: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<TenderCriterion[]> {
    return client.tenderCriterion.findMany({ where: { tenderId }, orderBy: { position: 'asc' } });
  }

  /** Replaces the whole list. The freeze trigger refuses this once the tender is not a DRAFT. */
  async replaceCriteria(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      tenderId: string;
      criteria: CriterionInput[];
      templateId: string | null;
      newId: () => string;
      actor: string;
      at: Date;
    },
  ): Promise<void> {
    await tx.tenderCriterion.deleteMany({ where: { tenderId: input.tenderId } });
    await tx.tenderCriterion.createMany({
      data: input.criteria.map((criterion, index) => ({
        id: input.newId(),
        organizationId: input.organizationId,
        tenderId: input.tenderId,
        position: index + 1,
        code: criterion.code,
        label: criterion.label,
        weightBp: criterion.weightBp,
        scoringMethod: criterion.scoringMethod,
        maxScore: criterion.maxScore,
        templateId: input.templateId,
        createdAt: input.at,
        createdBy: input.actor,
      })),
    });
  }
}
