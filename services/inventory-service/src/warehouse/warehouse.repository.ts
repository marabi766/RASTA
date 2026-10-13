import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';

/** A warehouse row as this service reads it, its point unpacked. */
export interface WarehouseRow {
  id: string;
  organizationId: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

const COLUMNS = Prisma.sql`
  "id", "organization_id" AS "organizationId", "name",
  ST_Y("location"::geometry) AS "latitude", ST_X("location"::geometry) AS "longitude",
  "status", "created_at" AS "createdAt", "updated_at" AS "updatedAt", "version"`;

/**
 * Warehouse persistence. In SQL, because Prisma has no geography type: every statement names
 * `organization_id` in its own predicate, since the tenant guard does not see raw SQL.
 */
@Injectable()
export class WarehouseRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      name: string;
      location: { latitude: number; longitude: number } | null;
      actor: string;
      correlationId: string;
      at: Date;
    },
  ): Promise<WarehouseRow> {
    const point =
      input.location === null
        ? Prisma.sql`NULL`
        : Prisma.sql`ST_SetSRID(ST_MakePoint(${input.location.longitude}::float8, ${input.location.latitude}::float8), 4326)::geography`;
    const rows = await tx.$queryRaw<WarehouseRow[]>`
      INSERT INTO "warehouse" ("id", "organization_id", "name", "location", "status",
                               "created_at", "created_by", "created_correlation_id",
                               "updated_at", "version")
      VALUES (${input.id}, ${input.organizationId}, ${input.name}, ${point}, 'ACTIVE',
              ${input.at}, ${input.actor}, ${input.correlationId}, ${input.at}, 1)
      RETURNING ${COLUMNS}`;
    return rows[0] as WarehouseRow;
  }

  async find(
    organizationId: string,
    id: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<WarehouseRow | null> {
    const rows = await client.$queryRaw<WarehouseRow[]>`
      SELECT ${COLUMNS} FROM "warehouse"
       WHERE "organization_id" = ${organizationId} AND "id" = ${id}`;
    return rows[0] ?? null;
  }

  /** Newest first, `limit + 1` rows so the caller can tell whether there is more. */
  async list(
    organizationId: string,
    filter: { cursor?: string; limit: number },
  ): Promise<WarehouseRow[]> {
    const after =
      filter.cursor === undefined ? Prisma.empty : Prisma.sql`AND "id" < ${filter.cursor}`;
    return this.prisma.client.$queryRaw<WarehouseRow[]>`
      SELECT ${COLUMNS} FROM "warehouse"
       WHERE "organization_id" = ${organizationId} ${after}
       ORDER BY "id" DESC
       LIMIT ${filter.limit + 1}`;
  }
}
