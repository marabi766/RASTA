import { Injectable } from '@nestjs/common';
import type { Prisma, Tender } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { TERMINAL_TENDER_STATES, type TenderStateName } from './tender.state-machine';

/**
 * Every read and write of the tender table.
 *
 * ## Tenant scope
 *
 * Prisma calls go through the tenant guard, which adds `organization_id = <the
 * caller's organization>` to every query on `Tender`: a tender of another
 * organization is never found, and the caller gets the same `404` a missing
 * tender produces. The one raw statement (the row lock — Prisma has no
 * `FOR UPDATE`) names `organization_id` in its own predicate, parameterised
 * (S-05). There is no `runUnscoped` in this file: nothing in CON-002 PR 2
 * crosses a tenant. Bidders, who are other tenants, arrive with the bid step
 * and read through an explicit, reasoned crossing (ADR-065 § 4).
 *
 * ## Compare-and-set
 *
 * Every write matches on the row's `version` (and its current status, where it
 * moves) and increments it (ADR-065 § 1). A write that matches nothing returns
 * `0`, and the service turns that into a refusal that rolls back the whole
 * transaction, event included.
 */

/** What the locked tender read returns: enough to decide, nothing more. */
export interface LockedTender {
  id: string;
  organizationId: string;
  projectId: string;
  status: TenderStateName;
  version: number;
}

export interface TenderCreateInput {
  id: string;
  organizationId: string;
  projectId: string;
  title: string;
  scopeOfWork: string;
  procurementNature: Tender['procurementNature'];
  visibility: Tender['visibility'];
  bidOpeningAt: Date | null;
  bidClosingAt: Date | null;
  actor: string;
  correlationId: string;
  at: Date;
}

export interface TenderListFilter {
  status?: TenderStateName;
  projectId?: string;
  cursor?: string;
  limit: number;
}

@Injectable()
export class TenderRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createTender(tx: ExtendedPrismaClient, input: TenderCreateInput): Promise<void> {
    await tx.tender.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        title: input.title,
        scopeOfWork: input.scopeOfWork,
        procurementNature: input.procurementNature,
        visibility: input.visibility,
        bidOpeningAt: input.bidOpeningAt,
        bidClosingAt: input.bidClosingAt,
        status: 'DRAFT',
        statusChangedAt: input.at,
        statusChangedBy: input.actor,
        createdAt: input.at,
        createdBy: input.actor,
        createdCorrelationId: input.correlationId,
        updatedAt: input.at,
        updatedBy: input.actor,
      },
    });
  }

  /**
   * Locks the tender row for the rest of the transaction and reads its state.
   *
   * Every command on a tender starts here, so two commands on one tender
   * serialise (ADR-065 § 2). The lock order across aggregates is project, then
   * tender: a command that needs both takes the project first.
   */
  async lockTender(
    tx: ExtendedPrismaClient,
    organizationId: string,
    tenderId: string,
  ): Promise<LockedTender | null> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        organization_id: string;
        project_id: string;
        status: TenderStateName;
        version: number;
      }[]
    >`
      SELECT "id", "organization_id", "project_id", "status"::text AS "status", "version"
        FROM "tender"
       WHERE "organization_id" = ${organizationId} AND "id" = ${tenderId}
       FOR UPDATE`;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      status: row.status,
      version: row.version,
    };
  }

  /** Compare-and-set on a tender's content. Returns the rows matched: 0 or 1. */
  async updateTenderContent(
    tx: ExtendedPrismaClient,
    tenderId: string,
    expectedVersion: number,
    data: Prisma.TenderUpdateManyMutationInput,
  ): Promise<number> {
    const result = await tx.tender.updateMany({
      where: { id: tenderId, status: 'DRAFT', version: expectedVersion },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count;
  }

  /** Compare-and-set on a tender's status. Returns the rows matched: 0 or 1. */
  async transitionTender(
    tx: ExtendedPrismaClient,
    input: {
      tenderId: string;
      from: TenderStateName;
      to: TenderStateName;
      expectedVersion: number;
      reason: string | null;
      reasonCode: string | null;
      actor: string;
      at: Date;
    },
  ): Promise<number> {
    const result = await tx.tender.updateMany({
      where: { id: input.tenderId, status: input.from, version: input.expectedVersion },
      data: {
        status: input.to,
        statusReason: input.reason,
        statusReasonCode: input.reasonCode,
        statusChangedAt: input.at,
        statusChangedBy: input.actor,
        updatedAt: input.at,
        updatedBy: input.actor,
        version: { increment: 1 },
      },
    });
    return result.count;
  }

  async findTender(
    tenderId: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<Tender | null> {
    return client.tender.findFirst({ where: { id: tenderId } });
  }

  /**
   * One page, newest first. The id is a ULID, so ordering by it is ordering by
   * creation time with a built-in tiebreaker, and the cursor is the last id.
   * `limit + 1` rows tell whether there is a next page without a `count`.
   */
  async listTenders(filter: TenderListFilter): Promise<Tender[]> {
    return this.prisma.client.tender.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.projectId ? { projectId: filter.projectId } : {}),
        ...(filter.cursor ? { id: { lt: filter.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: filter.limit + 1,
    });
  }

  /**
   * Whether the project has a tender that is not finished (neither AWARDED nor
   * CANCELLED). A project with one cannot be cancelled: the tender is the
   * commitment, and it must be ended by name and with a reason, not swept away
   * by its project (ADR-065 § 4). Read inside the project's locked transaction,
   * and creating a tender takes the same project lock, so the two cannot both
   * pass.
   */
  async hasLiveTender(tx: ExtendedPrismaClient, projectId: string): Promise<boolean> {
    const live = await tx.tender.findFirst({
      where: { projectId, status: { notIn: [...TERMINAL_TENDER_STATES] } },
      select: { id: true },
    });
    return live !== null;
  }
}
