import { Injectable } from '@nestjs/common';
import { Prisma, type StockMovementType } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';

/** A stock item as the balance writes see it. */
export interface StockItemRow {
  id: string;
  organizationId: string;
  warehouseId: string;
  productId: string;
  onHandQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface StockMovementRow {
  id: string;
  organizationId: string;
  warehouseId: string;
  stockItemId: string;
  type: StockMovementType;
  onHandDelta: number;
  reservedDelta: number;
  onHandAfter: number;
  reservedAfter: number;
  itemVersion: number;
  reservationId: string | null;
  sourceReference: string | null;
  createdAt: Date;
  createdBy: string;
}

const ITEM_COLUMNS = Prisma.sql`
  "id", "organization_id" AS "organizationId", "warehouse_id" AS "warehouseId",
  "product_id" AS "productId", "on_hand_quantity" AS "onHandQuantity",
  "reserved_quantity" AS "reservedQuantity", "available_quantity" AS "availableQuantity",
  "version", "created_at" AS "createdAt", "updated_at" AS "updatedAt"`;

const MOVEMENT_COLUMNS = Prisma.sql`
  "id", "organization_id" AS "organizationId", "warehouse_id" AS "warehouseId",
  "stock_item_id" AS "stockItemId", "type", "on_hand_delta" AS "onHandDelta",
  "reserved_delta" AS "reservedDelta", "on_hand_after" AS "onHandAfter",
  "reserved_after" AS "reservedAfter", "item_version" AS "itemVersion",
  "reservation_id" AS "reservationId", "source_reference" AS "sourceReference",
  "created_at" AS "createdAt", "created_by" AS "createdBy"`;

/**
 * Stock items and their ledger (ADR-056 § 3).
 *
 * The writes are SQL, inside the command's transaction, and every one names `organization_id`
 * in its own predicate (the tenant guard does not see raw SQL). A balance is changed only by
 * {@link move} on a row {@link lock} returned, and {@link move} is always followed by
 * {@link insertMovement} for the position it reached — the database refuses anything else
 * (`tg_stock_item_guard`, `tg_stock_movement_chain`, `tg_stock_item_ledger_check`).
 *
 * The reads go through the tenant-guarded client.
 */
@Injectable()
export class StockRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The stock item of (warehouse, product), created empty if this is its first receipt. Two
   * first receipts at once both arrive at the one row: the second insert waits on the unique
   * index, then does nothing, and reads the first's.
   */
  async ensureItem(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      warehouseId: string;
      productId: string;
      actor: string;
      at: Date;
    },
  ): Promise<string> {
    await tx.$executeRaw`
      INSERT INTO "stock_item" ("id", "organization_id", "warehouse_id", "product_id",
                                "created_at", "created_by", "updated_at", "updated_by")
      VALUES (${input.id}, ${input.organizationId}, ${input.warehouseId}, ${input.productId},
              ${input.at}, ${input.actor}, ${input.at}, ${input.actor})
      ON CONFLICT ("organization_id", "warehouse_id", "product_id") DO NOTHING`;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "stock_item"
       WHERE "organization_id" = ${input.organizationId}
         AND "warehouse_id" = ${input.warehouseId} AND "product_id" = ${input.productId}`;
    const id = rows[0]?.id;
    if (!id) throw new Error('ensureItem: the stock item is neither inserted nor found');
    return id;
  }

  /**
   * Locks one stock item (`SELECT … FOR UPDATE`) and returns it as it now stands — the latest
   * committed row, since READ COMMITTED re-reads it after the wait. `null` when the organization
   * has no such item. `skipLocked` returns `null` for a held one instead of waiting (the sweeper).
   */
  async lock(
    tx: ExtendedPrismaClient,
    organizationId: string,
    id: string,
    options: { skipLocked?: boolean } = {},
  ): Promise<StockItemRow | null> {
    const mode = options.skipLocked ? Prisma.sql`FOR UPDATE SKIP LOCKED` : Prisma.sql`FOR UPDATE`;
    const rows = await tx.$queryRaw<StockItemRow[]>`
      SELECT ${ITEM_COLUMNS} FROM "stock_item"
       WHERE "organization_id" = ${organizationId} AND "id" = ${id}
       ${mode}`;
    return rows[0] ?? null;
  }

  /**
   * Locks several stock items **one at a time, in ascending id order** — the order every command
   * uses, so two commands over the same items can never wait on each other in a cycle (ADR-056
   * § 3: a deadlock is made impossible by construction, not unlikely). Returns them in that order;
   * an id the organization does not have is missing from the result.
   */
  async lockInOrder(
    tx: ExtendedPrismaClient,
    organizationId: string,
    ids: readonly string[],
  ): Promise<StockItemRow[]> {
    const locked: StockItemRow[] = [];
    for (const id of ascending(ids)) {
      const row = await this.lock(tx, organizationId, id);
      if (row) locked.push(row);
    }
    return locked;
  }

  /**
   * Moves the balance of a locked item by the deltas, one ledger position on, and returns the
   * row as it now is. The CHECKs refuse a negative or over-reserved result.
   */
  async move(
    tx: ExtendedPrismaClient,
    item: Pick<StockItemRow, 'organizationId' | 'id'>,
    deltas: { onHand: number; reserved: number },
    actor: string,
    at: Date,
  ): Promise<StockItemRow> {
    const rows = await tx.$queryRaw<StockItemRow[]>`
      UPDATE "stock_item"
         SET "on_hand_quantity" = "on_hand_quantity" + ${deltas.onHand}::integer,
             "reserved_quantity" = "reserved_quantity" + ${deltas.reserved}::integer,
             "version" = "version" + 1,
             "updated_at" = ${at},
             "updated_by" = ${actor}
       WHERE "organization_id" = ${item.organizationId} AND "id" = ${item.id}
       RETURNING ${ITEM_COLUMNS}`;
    const row = rows[0];
    if (!row) throw new Error('move: the locked stock item vanished');
    return row;
  }

  /** Appends the movement for the position `item` (as {@link move} returned it) now stands at. */
  async insertMovement(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      item: StockItemRow;
      type: StockMovementType;
      onHandDelta: number;
      reservedDelta: number;
      reservationId: string | null;
      sourceReference: string | null;
      commandKeyHash: string;
      correlationId: string;
      actor: string;
      at: Date;
    },
  ): Promise<StockMovementRow> {
    const rows = await tx.$queryRaw<StockMovementRow[]>`
      INSERT INTO "stock_movement" ("id", "organization_id", "warehouse_id", "stock_item_id",
                                    "type", "on_hand_delta", "reserved_delta",
                                    "on_hand_after", "reserved_after", "item_version",
                                    "reservation_id", "source_reference", "command_key_hash",
                                    "correlation_id", "created_at", "created_by")
      VALUES (${input.id}, ${input.item.organizationId}, ${input.item.warehouseId},
              ${input.item.id}, ${input.type}::"StockMovementType",
              ${input.onHandDelta}::integer, ${input.reservedDelta}::integer,
              ${input.item.onHandQuantity}::integer, ${input.item.reservedQuantity}::integer,
              ${input.item.version}::integer, ${input.reservationId}, ${input.sourceReference},
              ${input.commandKeyHash}, ${input.correlationId}, ${input.at}, ${input.actor})
      RETURNING ${MOVEMENT_COLUMNS}`;
    return rows[0] as StockMovementRow;
  }

  // -- reads (tenant-guarded) --------------------------------------------------------------

  async findItem(organizationId: string, id: string) {
    return this.prisma.client.stockItem.findFirst({ where: { organizationId, id } });
  }

  async listItems(
    organizationId: string,
    filter: { warehouseId?: string; productId?: string; cursor?: string; limit: number },
  ) {
    return this.prisma.client.stockItem.findMany({
      where: {
        organizationId,
        ...(filter.warehouseId === undefined ? {} : { warehouseId: filter.warehouseId }),
        ...(filter.productId === undefined ? {} : { productId: filter.productId }),
        ...(filter.cursor === undefined ? {} : { id: { lt: filter.cursor } }),
      },
      orderBy: { id: 'desc' },
      take: filter.limit + 1,
    });
  }

  async listMovements(
    organizationId: string,
    filter: { stockItemId?: string; warehouseId?: string; cursor?: string; limit: number },
  ) {
    return this.prisma.client.stockMovement.findMany({
      where: {
        organizationId,
        ...(filter.stockItemId === undefined ? {} : { stockItemId: filter.stockItemId }),
        ...(filter.warehouseId === undefined ? {} : { warehouseId: filter.warehouseId }),
        ...(filter.cursor === undefined ? {} : { id: { lt: filter.cursor } }),
      },
      orderBy: { id: 'desc' },
      take: filter.limit + 1,
    });
  }
}

/**
 * The one lock order (ADR-056 § 3): ascending id, by code unit — the same order on every
 * instance, whatever the database's collation, since an id is ASCII.
 */
export function ascending(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
