import { Injectable } from '@nestjs/common';
import { Prisma, type Project, type ProjectNeed } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { ProjectStateName } from './project.state-machine';
import type { NeedStateName } from './need.state-machine';
import type { PolygonInput } from './dto';

/**
 * Every read and write of this service's own tables.
 *
 * ## Tenant scope, in two forms
 *
 * Prisma calls go through the tenant guard, which adds `organization_id = <the
 * caller's organization>` to every query on `Project`, `ProjectNeed` and
 * `IdempotencyKey`. A project of another organization is therefore never
 * found, and the caller gets the same `404` a missing project produces.
 *
 * Raw SQL does **not** go through the guard — Prisma has no geography type and
 * no `FOR UPDATE`, so three statements here are raw. Each one names
 * `organization_id` in its own predicate, taken from the caller's context by
 * the service, and each is parameterised (S-05). There is no `runUnscoped` in
 * this file: nothing in CON-001 PR 1 crosses a tenant.
 *
 * ## Compare-and-set
 *
 * Every write that changes a lifecycle or content matches on the row's
 * `version` (and its current status, where it has one) and increments it
 * (ADR-063). A write that matches nothing returns `0`, and the service turns
 * that into a refusal that rolls back the whole transaction, event included.
 */

/** What the locked project read returns: enough to decide, nothing more. */
export interface LockedProject {
  id: string;
  organizationId: string;
  status: ProjectStateName;
  version: number;
}

export interface ProjectCreateInput {
  id: string;
  organizationId: string;
  title: string;
  operationType: string;
  scopeOfWork: string;
  locationDescription: string;
  estimatedCostMinor: bigint | null;
  actor: string;
  correlationId: string;
  at: Date;
}

export interface NeedCreateInput {
  id: string;
  organizationId: string;
  projectId: string;
  title: string;
  description: string;
  quantity: string | null;
  unit: string | null;
  estimatedCostMinor: bigint | null;
  actor: string;
  correlationId: string;
  at: Date;
}

export interface ProjectListFilter {
  status?: ProjectStateName;
  cursor?: string;
  limit: number;
}

export interface NeedListFilter {
  status?: NeedStateName;
  cursor?: string;
  limit: number;
}

export type NeedsSummary = { draft: number; submitted: number; withdrawn: number };

@Injectable()
export class ProjectRepository {
  constructor(private readonly prisma: PrismaService) {}

  // -- project writes ---------------------------------------------------------

  async createProject(tx: ExtendedPrismaClient, input: ProjectCreateInput): Promise<void> {
    await tx.project.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        title: input.title,
        operationType: input.operationType,
        scopeOfWork: input.scopeOfWork,
        locationDescription: input.locationDescription,
        estimatedCostMinor: input.estimatedCostMinor,
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
   * Sets or clears the operating area.
   *
   * Raw, because Prisma has no geography type. `ST_GeomFromGeoJSON` parses the
   * polygon the DTO already validated structurally; `ck_project_area_valid`
   * refuses one PostGIS considers invalid, and the service reports that as a
   * `400` on `area`.
   */
  async setArea(
    tx: ExtendedPrismaClient,
    organizationId: string,
    projectId: string,
    area: PolygonInput | null,
  ): Promise<void> {
    const geoJson = area === null ? null : JSON.stringify(area);
    await tx.$executeRaw`
      UPDATE "project"
         SET "area" = CASE
               WHEN ${geoJson}::text IS NULL THEN NULL
               ELSE ST_SetSRID(ST_GeomFromGeoJSON(${geoJson}::text), 4326)::geography
             END
       WHERE "organization_id" = ${organizationId} AND "id" = ${projectId}`;
  }

  /**
   * Locks the project row for the rest of the transaction and reads its state.
   *
   * Every command on a project or one of its needs starts here, so two
   * commands on one project serialise: a need cannot be added, edited or
   * submitted while the project is being cancelled — or, in PR 2, while an
   * approval request is freezing its scope.
   */
  async lockProject(
    tx: ExtendedPrismaClient,
    organizationId: string,
    projectId: string,
  ): Promise<LockedProject | null> {
    const rows = await tx.$queryRaw<
      { id: string; organization_id: string; status: ProjectStateName; version: number }[]
    >`
      SELECT "id", "organization_id", "status"::text AS "status", "version"
        FROM "project"
       WHERE "organization_id" = ${organizationId} AND "id" = ${projectId}
       FOR UPDATE`;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organization_id,
      status: row.status,
      version: row.version,
    };
  }

  /** Compare-and-set on a project's content. Returns the rows matched: 0 or 1. */
  async updateProjectContent(
    tx: ExtendedPrismaClient,
    projectId: string,
    expectedVersion: number,
    data: Prisma.ProjectUpdateManyMutationInput,
  ): Promise<number> {
    const result = await tx.project.updateMany({
      where: { id: projectId, version: expectedVersion },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count;
  }

  /** Compare-and-set on a project's status. Returns the rows matched: 0 or 1. */
  async transitionProject(
    tx: ExtendedPrismaClient,
    input: {
      projectId: string;
      from: ProjectStateName;
      to: ProjectStateName;
      expectedVersion: number;
      reason: string | null;
      actor: string;
      at: Date;
    },
  ): Promise<number> {
    const result = await tx.project.updateMany({
      where: { id: input.projectId, status: input.from, version: input.expectedVersion },
      data: {
        status: input.to,
        statusReason: input.reason,
        statusChangedAt: input.at,
        statusChangedBy: input.actor,
        updatedAt: input.at,
        updatedBy: input.actor,
        version: { increment: 1 },
      },
    });
    return result.count;
  }

  // -- project reads ----------------------------------------------------------

  async findProject(
    projectId: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<Project | null> {
    return client.project.findFirst({ where: { id: projectId } });
  }

  /** The operating area as GeoJSON, or null. Raw, for the same reason as `setArea`. */
  async readArea(
    organizationId: string,
    projectId: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<unknown> {
    const rows = await client.$queryRaw<{ area: string | null }[]>`
      SELECT ST_AsGeoJSON("area") AS "area"
        FROM "project"
       WHERE "organization_id" = ${organizationId} AND "id" = ${projectId}`;
    const area = rows[0]?.area;
    return area ? (JSON.parse(area) as unknown) : null;
  }

  /** Which of these projects have an area. One query per page, never one per row. */
  async projectsWithArea(organizationId: string, projectIds: string[]): Promise<Set<string>> {
    if (projectIds.length === 0) return new Set();
    const rows = await this.prisma.client.$queryRaw<{ id: string }[]>`
      SELECT "id"
        FROM "project"
       WHERE "organization_id" = ${organizationId}
         AND "id" IN (${Prisma.join(projectIds)})
         AND "area" IS NOT NULL`;
    return new Set(rows.map((row) => row.id));
  }

  /**
   * One page, newest first. The id is a ULID, so ordering by it is ordering by
   * creation time with a built-in tiebreaker, and the cursor is the last id.
   * `limit + 1` rows tell whether there is a next page without a `count`.
   */
  async listProjects(filter: ProjectListFilter): Promise<Project[]> {
    return this.prisma.client.project.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.cursor ? { id: { lt: filter.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: filter.limit + 1,
    });
  }

  async needsSummary(
    projectId: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<NeedsSummary> {
    const groups = await client.projectNeed.groupBy({
      by: ['status'],
      where: { projectId },
      _count: { _all: true },
    });
    const count = (status: NeedStateName): number =>
      groups.find((group) => group.status === status)?._count._all ?? 0;
    return { draft: count('DRAFT'), submitted: count('SUBMITTED'), withdrawn: count('WITHDRAWN') };
  }

  // -- needs ------------------------------------------------------------------

  async createNeed(tx: ExtendedPrismaClient, input: NeedCreateInput): Promise<void> {
    await tx.projectNeed.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        title: input.title,
        description: input.description,
        quantity: input.quantity === null ? null : new Prisma.Decimal(input.quantity),
        unit: input.unit,
        estimatedCostMinor: input.estimatedCostMinor,
        status: 'DRAFT',
        createdAt: input.at,
        createdBy: input.actor,
        createdCorrelationId: input.correlationId,
        updatedAt: input.at,
        updatedBy: input.actor,
      },
    });
  }

  async findNeed(
    client: ExtendedPrismaClient,
    projectId: string,
    needId: string,
  ): Promise<ProjectNeed | null> {
    return client.projectNeed.findFirst({ where: { id: needId, projectId } });
  }

  /** Compare-and-set on a need. Returns the rows matched: 0 or 1. */
  async updateNeed(
    tx: ExtendedPrismaClient,
    input: {
      needId: string;
      projectId: string;
      expectedVersion: number;
      from: NeedStateName;
      data: Prisma.ProjectNeedUpdateManyMutationInput;
    },
  ): Promise<number> {
    const result = await tx.projectNeed.updateMany({
      where: {
        id: input.needId,
        projectId: input.projectId,
        status: input.from,
        version: input.expectedVersion,
      },
      data: { ...input.data, version: { increment: 1 } },
    });
    return result.count;
  }

  async listNeeds(projectId: string, filter: NeedListFilter): Promise<ProjectNeed[]> {
    return this.prisma.client.projectNeed.findMany({
      where: {
        projectId,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.cursor ? { id: { gt: filter.cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: filter.limit + 1,
    });
  }
}
