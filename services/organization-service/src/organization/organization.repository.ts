import { Injectable } from '@nestjs/common';
import { buildOutboxRow, type OutboxMessageInput } from '@rasta/nest-common';
import { PrismaService, type PrismaTransactionClient } from '../prisma/prisma.service';
import { SERVICE_NAME } from '../config/env';
import type { ListOrganizationsQuery, NearbyQuery } from './dto';

/**
 * Data access for organizations.
 *
 * Two things here need explaining, because both look odd until you know why.
 *
 * **1. ltree labels are not identifiers.**
 * An ltree label may only contain `[A-Za-z0-9_]`. Our identifiers legitimately
 * contain hyphens (`ORG-DEH-0001` in seed data), which ltree rejects outright.
 * So the path stores a *sanitised* label per node, and `parentId` remains the
 * single source of truth for ancestry. The path is a derived index structure
 * used for subtree filtering — never parsed back into identifiers.
 *
 * **2. Raw SQL for path work.**
 * Prisma has no representation for ltree operators or PostGIS. Rewriting an
 * entire subtree's path is one statement in SQL and N round trips in an ORM,
 * and the correctness of the hierarchy depends on it being atomic.
 */
@Injectable()
export class OrganizationRepository {
  constructor(private readonly prisma: PrismaService) {}

  get client() {
    return this.prisma.client;
  }

  transaction<T>(fn: (tx: PrismaTransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.transaction(fn);
  }

  async enqueueEvent(tx: PrismaTransactionClient, input: OutboxMessageInput): Promise<string> {
    const row = buildOutboxRow(input, {
      producer: SERVICE_NAME,
      producerVersion: process.env.SERVICE_VERSION ?? '0.1.0',
    });

    await tx.outboxMessage.create({
      data: {
        id: row.id,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        eventName: row.eventName,
        eventVersion: row.eventVersion,
        topic: row.topic,
        partitionKey: row.partitionKey,
        payload: row.payload as object,
        headers: row.headers,
        organizationId: row.organizationId,
        correlationId: row.correlationId,
        createdAt: row.createdAt,
      },
    });

    return row.id;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async findById(id: string) {
    return this.client.organization.findFirst({ where: { id, deletedAt: null } });
  }

  async findDetailById(id: string) {
    const [organization, childCount] = await Promise.all([
      this.client.organization.findFirst({
        where: { id, deletedAt: null },
        include: {
          locations: { orderBy: { createdAt: 'asc' } },
          contacts: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
        },
      }),
      this.client.organization.count({ where: { parentId: id, deletedAt: null } }),
    ]);

    if (!organization) return null;
    return { ...organization, childCount };
  }

  async findByExternalCode(externalCode: string) {
    return this.client.organization.findFirst({ where: { externalCode, deletedAt: null } });
  }

  async list(query: ListOrganizationsQuery, allowedRootPath: string | null) {
    // The cursor and the subtree restriction both constrain `id`. They are
    // combined under AND rather than merged into one object, because two `id`
    // keys in a single `where` would silently drop the cursor and break
    // pagination in a way no test on page one would catch.
    const idConstraints: object[] = [];
    if (query.cursor) idConstraints.push({ id: { gt: query.cursor } });
    if (allowedRootPath) {
      // Restricted here rather than filtered afterwards, so a page contains
      // `limit` rows the caller may actually see.
      idConstraints.push({ id: { in: await this.idsUnderPath(allowedRootPath) } });
    }

    const rows = await this.client.organization.findMany({
      where: {
        deletedAt: null,
        ...(query.type ? { type: query.type } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.parentId ? { parentId: query.parentId } : {}),
        ...(query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' as const } },
                { shortName: { contains: query.q, mode: 'insensitive' as const } },
                { externalCode: { contains: query.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
        ...(idConstraints.length > 0 ? { AND: idConstraints } : {}),
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });

    const items = rows.slice(0, query.limit);
    return {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
      hasMore: rows.length > query.limit,
    };
  }

  /** Identifiers in the subtree rooted at `path`, inclusive. */
  async idsUnderPath(path: string): Promise<string[]> {
    const rows = await this.client.$queryRaw<{ id: string }[]>`
      SELECT id FROM organization
      WHERE deleted_at IS NULL AND path <@ ${path}::ltree
    `;
    return rows.map((row) => row.id);
  }

  /** Direct children only. */
  async findChildren(id: string) {
    return this.client.organization.findMany({
      where: { parentId: id, deletedAt: null },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Ancestors, root first.
   *
   * `@>` reads as "is an ancestor of", so this is a single index scan rather
   * than a loop that walks parentId upwards one query at a time.
   */
  async findAncestors(id: string) {
    return this.client.$queryRaw<OrganizationRow[]>`
      SELECT o.* FROM organization o
      WHERE o.deleted_at IS NULL
        AND o.path @> (SELECT path FROM organization WHERE id = ${id})
        AND o.id <> ${id}
      ORDER BY nlevel(o.path)
    `;
  }

  /** Whole subtree, inclusive of the root. */
  async findSubtree(id: string, maxDepth?: number) {
    if (maxDepth === undefined) {
      return this.client.$queryRaw<OrganizationRow[]>`
        SELECT o.* FROM organization o
        WHERE o.deleted_at IS NULL
          AND o.path <@ (SELECT path FROM organization WHERE id = ${id})
        ORDER BY o.path
      `;
    }
    return this.client.$queryRaw<OrganizationRow[]>`
      SELECT o.* FROM organization o
      WHERE o.deleted_at IS NULL
        AND o.path <@ (SELECT path FROM organization WHERE id = ${id})
        AND nlevel(o.path) <= (SELECT nlevel(path) FROM organization WHERE id = ${id}) + ${maxDepth}
      ORDER BY o.path
    `;
  }

  /** True when `ancestorId` is at or above `descendantId`. */
  async isAncestorOf(ancestorId: string, descendantId: string): Promise<boolean> {
    const rows = await this.client.$queryRaw<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM organization a, organization d
        WHERE a.id = ${ancestorId} AND d.id = ${descendantId} AND d.path <@ a.path
      ) AS ok
    `;
    return rows[0]?.ok ?? false;
  }

  async getPath(id: string): Promise<string | null> {
    const rows = await this.client.$queryRaw<{ path: string | null }[]>`
      SELECT path::text AS path FROM organization WHERE id = ${id}
    `;
    return rows[0]?.path ?? null;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Sets the ltree path on a freshly inserted row.
   *
   * Prisma cannot write an `Unsupported` column, so the row is created without
   * a path and the path is set immediately afterwards inside the same
   * transaction.
   */
  async setPath(
    tx: PrismaTransactionClient,
    id: string,
    parentPath: string | null,
  ): Promise<{ path: string; depth: number }> {
    const label = toLabel(id);
    const path = parentPath ? `${parentPath}.${label}` : label;
    const depth = path.split('.').length - 1;

    await tx.$executeRaw`
      UPDATE organization SET path = ${path}::ltree, depth = ${depth} WHERE id = ${id}
    `;

    return { path, depth };
  }

  /**
   * Re-parents a subtree.
   *
   * One statement rewrites every descendant: strip the old ancestry prefix,
   * graft on the new one. Doing it row by row would leave the tree
   * inconsistent if it failed partway.
   */
  async rewriteSubtreePath(
    tx: PrismaTransactionClient,
    oldPath: string,
    newPath: string,
  ): Promise<number> {
    const affected = await tx.$executeRaw`
      UPDATE organization
      SET path  = ${newPath}::ltree || subpath(path, nlevel(${oldPath}::ltree)),
          depth = nlevel(${newPath}::ltree || subpath(path, nlevel(${oldPath}::ltree))) - 1
      WHERE path <@ ${oldPath}::ltree
    `;
    return affected;
  }

  // -------------------------------------------------------------------------
  // Geospatial
  // -------------------------------------------------------------------------

  async setLocationPoint(
    tx: PrismaTransactionClient,
    locationId: string,
    latitude: number,
    longitude: number,
  ): Promise<void> {
    // ST_MakePoint takes longitude first. Getting this backwards is the single
    // most common PostGIS bug and puts Yazd in the Indian Ocean.
    await tx.$executeRaw`
      UPDATE organization_location
      SET point = ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography
      WHERE id = ${locationId}
    `;
  }

  async readLocationPoints(
    organizationId: string,
  ): Promise<Map<string, { latitude: number; longitude: number }>> {
    const rows = await this.client.$queryRaw<
      { id: string; latitude: number | null; longitude: number | null }[]
    >`
      SELECT id,
             ST_Y(point::geometry)::float8 AS latitude,
             ST_X(point::geometry)::float8 AS longitude
      FROM organization_location
      WHERE organization_id = ${organizationId}
    `;

    const result = new Map<string, { latitude: number; longitude: number }>();
    for (const row of rows) {
      if (row.latitude !== null && row.longitude !== null) {
        result.set(row.id, { latitude: row.latitude, longitude: row.longitude });
      }
    }
    return result;
  }

  /** Organizations within `radiusMeters`, nearest first. */
  async findNearby(query: NearbyQuery) {
    return this.client.$queryRaw<NearbyRow[]>`
      SELECT o.id, o.name, o.type, o.status,
             ST_Distance(
               l.point,
               ST_SetSRID(ST_MakePoint(${query.longitude}, ${query.latitude}), 4326)::geography
             )::float8 AS distance_meters
      FROM organization_location l
      JOIN organization o ON o.id = l.organization_id
      WHERE o.deleted_at IS NULL
        AND l.point IS NOT NULL
        -- Parenthesised deliberately: AND x OR y binds as (AND x) OR y, which
        -- would return every organization in the country and quietly ignore
        -- the radius entirely.
        AND (${query.type ?? null}::text IS NULL OR o.type::text = ${query.type ?? null}::text)
        AND ST_DWithin(
              l.point,
              ST_SetSRID(ST_MakePoint(${query.longitude}, ${query.latitude}), 4326)::geography,
              ${query.radiusMeters}
            )
      ORDER BY distance_meters
      LIMIT ${query.limit}
    `;
  }
}

/**
 * Converts an identifier into a legal ltree label.
 *
 * ltree permits only `[A-Za-z0-9_]`, and our identifiers may contain hyphens.
 * The mapping is one-way by design: `parentId` is the source of truth for
 * ancestry, and the path is only ever used for subtree filtering.
 */
export function toLabel(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, '_');
}

export interface OrganizationRow {
  id: string;
  external_code: string | null;
  name: string;
  short_name: string | null;
  type: string;
  status: string;
  parent_id: string | null;
  depth: number;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface NearbyRow {
  id: string;
  name: string;
  type: string;
  status: string;
  distance_meters: number;
}
