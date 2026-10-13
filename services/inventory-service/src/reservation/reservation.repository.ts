import { Injectable } from '@nestjs/common';
import { Prisma, type StockReservationStatus } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';

export interface ReservationRow {
  id: string;
  organizationId: string;
  warehouseId: string;
  stockItemId: string;
  holderOrganizationId: string;
  orderReference: string | null;
  quantity: number;
  status: StockReservationStatus;
  expiresAt: Date | null;
  createdAt: Date;
  createdBy: string;
  endedAt: Date | null;
  endedBy: string | null;
  updatedAt: Date;
  version: number;
}

const COLUMNS = Prisma.sql`
  "id", "organization_id" AS "organizationId", "warehouse_id" AS "warehouseId",
  "stock_item_id" AS "stockItemId", "holder_organization_id" AS "holderOrganizationId",
  "order_reference" AS "orderReference", "quantity", "status", "expires_at" AS "expiresAt",
  "created_at" AS "createdAt", "created_by" AS "createdBy", "ended_at" AS "endedAt",
  "ended_by" AS "endedBy", "updated_at" AS "updatedAt", "version"`;

/** One (owner, stock item) with reservations past their `expiresAt`, for the sweeper. */
export interface DueItem {
  organizationId: string;
  stockItemId: string;
}

/**
 * Reservations (ADR-056 § 3). Writes are SQL in the command's transaction, each naming
 * `organization_id`, and always **after** the reservation's stock item is locked: every path —
 * command or sweeper — locks the item first and the reservation second, so they never wait on
 * each other in a cycle.
 */
@Injectable()
export class ReservationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      warehouseId: string;
      stockItemId: string;
      holderOrganizationId: string;
      orderReference: string | null;
      quantity: number;
      expiresAt: Date | null;
      commandKeyHash: string;
      actor: string;
      correlationId: string;
      at: Date;
    },
  ): Promise<ReservationRow> {
    const rows = await tx.$queryRaw<ReservationRow[]>`
      INSERT INTO "stock_reservation" ("id", "organization_id", "warehouse_id", "stock_item_id",
                                       "holder_organization_id", "order_reference", "quantity",
                                       "status", "expires_at", "command_key_hash",
                                       "created_at", "created_by", "created_correlation_id",
                                       "updated_at", "version")
      VALUES (${input.id}, ${input.organizationId}, ${input.warehouseId}, ${input.stockItemId},
              ${input.holderOrganizationId}, ${input.orderReference}, ${input.quantity}::integer,
              'ACTIVE', ${input.expiresAt}, ${input.commandKeyHash},
              ${input.at}, ${input.actor}, ${input.correlationId}, ${input.at}, 1)
      RETURNING ${COLUMNS}`;
    return rows[0] as ReservationRow;
  }

  /** Locks one reservation — only ever after its stock item. */
  async lock(
    tx: ExtendedPrismaClient,
    organizationId: string,
    id: string,
  ): Promise<ReservationRow | null> {
    const rows = await tx.$queryRaw<ReservationRow[]>`
      SELECT ${COLUMNS} FROM "stock_reservation"
       WHERE "organization_id" = ${organizationId} AND "id" = ${id}
       FOR UPDATE`;
    return rows[0] ?? null;
  }

  /**
   * Ends an ACTIVE reservation — compare-and-set on its status and version. `null` when it is no
   * longer ACTIVE at that version (it cannot be, under its item's lock; the database's guard
   * refuses the transition anyway).
   */
  async end(
    tx: ExtendedPrismaClient,
    reservation: Pick<ReservationRow, 'organizationId' | 'id' | 'version'>,
    status: Exclude<StockReservationStatus, 'ACTIVE'>,
    actor: string,
    at: Date,
  ): Promise<ReservationRow | null> {
    const rows = await tx.$queryRaw<ReservationRow[]>`
      UPDATE "stock_reservation"
         SET "status" = ${status}::"StockReservationStatus", "ended_at" = ${at},
             "ended_by" = ${actor}, "updated_at" = ${at}, "version" = "version" + 1
       WHERE "organization_id" = ${reservation.organizationId} AND "id" = ${reservation.id}
         AND "status" = 'ACTIVE' AND "version" = ${reservation.version}::integer
       RETURNING ${COLUMNS}`;
    return rows[0] ?? null;
  }

  /**
   * At most `limit` ACTIVE reservations of a **locked** stock item whose `expiresAt` is at or
   * before `at`, locked, the longest overdue first. Never all of them: a backlog is worked off
   * in batches (`ReservationExpiry`).
   */
  async dueOf(
    tx: ExtendedPrismaClient,
    organizationId: string,
    stockItemId: string,
    at: Date,
    limit: number,
  ): Promise<ReservationRow[]> {
    return tx.$queryRaw<ReservationRow[]>`
      SELECT ${COLUMNS} FROM "stock_reservation"
       WHERE "organization_id" = ${organizationId} AND "stock_item_id" = ${stockItemId}
         AND "status" = 'ACTIVE' AND "expires_at" <= ${at}
       ORDER BY "expires_at", "id"
       LIMIT ${limit}::integer
       FOR UPDATE`;
  }

  /**
   * What the ACTIVE reservations of a **locked** stock item that are due at `at` still hold, in
   * all: the part of `reserved` that expiring them would give back. One aggregate over
   * `ix_stock_reservation_org_item_status`, whatever the backlog.
   */
  async dueQuantity(
    tx: ExtendedPrismaClient,
    organizationId: string,
    stockItemId: string,
    at: Date,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ held: bigint | null }[]>`
      SELECT sum("quantity") AS "held" FROM "stock_reservation"
       WHERE "organization_id" = ${organizationId} AND "stock_item_id" = ${stockItemId}
         AND "status" = 'ACTIVE' AND "expires_at" <= ${at}`;
    return Number(rows[0]?.held ?? 0);
  }

  /**
   * The stock items, across every owner, that hold a reservation past its `expiresAt` — the
   * sweeper's question, by the database's clock. Unscoped by necessity: the sweeper runs outside
   * any request. Read without a lock; each item is then locked and re-checked in its own
   * transaction.
   */
  async dueItems(limit: number): Promise<DueItem[]> {
    return this.prisma.client.$queryRaw<DueItem[]>`
      SELECT "organization_id" AS "organizationId", "stock_item_id" AS "stockItemId"
        FROM "stock_reservation"
       WHERE "status" = 'ACTIVE' AND "expires_at" <= now()
       GROUP BY "organization_id", "stock_item_id"
       ORDER BY min("expires_at")
       LIMIT ${limit}`;
  }

  /** ACTIVE reservations past their `expiresAt`, across every owner: the overdue gauge. */
  async overdueCount(): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS "count" FROM "stock_reservation"
       WHERE "status" = 'ACTIVE' AND "expires_at" <= now()`;
    return Number(rows[0]?.count ?? 0);
  }

  // -- reads (tenant-guarded) --------------------------------------------------------------

  async find(organizationId: string, id: string) {
    return this.prisma.client.stockReservation.findFirst({ where: { organizationId, id } });
  }

  async list(
    organizationId: string,
    filter: {
      status?: StockReservationStatus;
      stockItemId?: string;
      cursor?: string;
      limit: number;
    },
  ) {
    return this.prisma.client.stockReservation.findMany({
      where: {
        organizationId,
        ...(filter.status === undefined ? {} : { status: filter.status }),
        ...(filter.stockItemId === undefined ? {} : { stockItemId: filter.stockItemId }),
        ...(filter.cursor === undefined ? {} : { id: { lt: filter.cursor } }),
      },
      orderBy: { id: 'desc' },
      take: filter.limit + 1,
    });
  }
}
