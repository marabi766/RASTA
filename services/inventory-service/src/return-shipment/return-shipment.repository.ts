import { Injectable } from '@nestjs/common';
import type { ReturnDisposition } from '@rasta/contracts';
import { Prisma } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { ReturnShipmentSide, ReturnShipmentStatus } from './dto';

export interface ReturnShipmentRow {
  id: string;
  organizationId: string;
  destinationWarehouseId: string;
  buyerOrganizationId: string;
  returnRequestId: string;
  orderId: string;
  carrierName: string | null;
  carrierReference: string | null;
  lineCount: number;
  status: ReturnShipmentStatus;
  createdAt: Date;
  createdBy: string;
  receivedAt: Date | null;
  inspectedAt: Date | null;
  inspectionNote: string | null;
  inspectionReportDocumentId: string | null;
  resolvedAt: Date | null;
  updatedAt: Date;
  version: number;
}

export interface ReturnDispositionRow {
  id: string;
  orderLineId: string;
  disposition: ReturnDisposition;
  quantity: number;
}

export interface ReturnShipmentLineRow {
  id: string;
  orderLineId: string;
  productId: string;
  expectedQuantity: number;
  receivedQuantity: number | null;
}

export interface ReturnTrackingEventRow {
  id: string;
  returnShipmentId: string;
  type: ReturnShipmentStatus;
  /** The shipment version this event records: its place in the lifecycle (1, 2). */
  shipmentVersion: number;
  occurredAt: Date;
  recordedAt: Date;
}

/**
 * Who reads, and from which sides: the acting organization as owner of the destination warehouse,
 * as sender, or both — as its roles open them (`InventoryAccess.assertReturnShipmentReader`).
 */
export interface ReturnShipmentVisibility {
  organizationId: string;
  asDestination: boolean;
  asSender: boolean;
}

const COLUMNS = Prisma.sql`
  "id", "organization_id" AS "organizationId", "destination_warehouse_id" AS "destinationWarehouseId",
  "buyer_organization_id" AS "buyerOrganizationId", "return_request_id" AS "returnRequestId",
  "order_id" AS "orderId", "carrier_name" AS "carrierName", "carrier_reference" AS "carrierReference",
  "line_count" AS "lineCount", "status", "created_at" AS "createdAt", "created_by" AS "createdBy",
  "received_at" AS "receivedAt", "inspected_at" AS "inspectedAt",
  "inspection_note" AS "inspectionNote",
  "inspection_report_document_id" AS "inspectionReportDocumentId",
  "resolved_at" AS "resolvedAt", "updated_at" AS "updatedAt", "version"`;

const DISPOSITION_COLUMNS = Prisma.sql`
  "id", "order_line_id" AS "orderLineId", "disposition", "quantity"`;

const LINE_COLUMNS = Prisma.sql`
  "id", "order_line_id" AS "orderLineId", "product_id" AS "productId",
  "expected_quantity" AS "expectedQuantity", "received_quantity" AS "receivedQuantity"`;

/** A marketplace dispatch reservation withdrawn here (Q-133 (9)(a)). */
export interface ReturnDispatchWithdrawalRow {
  id: string;
  returnRequestId: string;
  reservationId: string;
  withdrawnAt: Date;
}

const WITHDRAWAL_COLUMNS = Prisma.sql`
  "id", "return_request_id" AS "returnRequestId", "reservation_id" AS "reservationId",
  "withdrawn_at" AS "withdrawnAt"`;

const EVENT_COLUMNS = Prisma.sql`
  "id", "return_shipment_id" AS "returnShipmentId", "type", "shipment_version" AS "shipmentVersion",
  "occurred_at" AS "occurredAt", "recorded_at" AS "recordedAt"`;

/**
 * The rows a reader may see, as one predicate that names the organization in each column it reads
 * by — `organization_id` for the destination owner's side, `buyer_organization_id` for the
 * sender's — or `null` when no side is open (nothing is visible). `side` narrows it further.
 */
export function returnVisibleTo(
  reader: ReturnShipmentVisibility,
  side?: ReturnShipmentSide,
): Prisma.Sql | null {
  const parts: Prisma.Sql[] = [];
  if (reader.asDestination && side !== 'sender') {
    parts.push(Prisma.sql`"organization_id" = ${reader.organizationId}`);
  }
  if (reader.asSender && side !== 'destination') {
    parts.push(Prisma.sql`"buyer_organization_id" = ${reader.organizationId}`);
  }
  return parts.length === 0 ? null : Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

/**
 * Return shipments, their lines and their tracking history (ADR-048 § 2).
 *
 * Everything is SQL, as the forward shipments' is. The writes run in the command's transaction and
 * are the owner's, each naming `organization_id` in its own predicate. The reads cross tenants **by
 * design** — a return shipment is read by the owner of its destination warehouse and by its sender
 * — which the tenant guard can neither see nor express: each read names, in its own predicate, the
 * organization in the column it is read by ({@link returnVisibleTo}), and the lines and history
 * are read only for a shipment found that way, through its owner's `organization_id`.
 */
@Injectable()
export class ReturnShipmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  // -- writes (the owner's, in the command's transaction) ----------------------------------

  async insert(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      destinationWarehouseId: string;
      buyerOrganizationId: string;
      returnRequestId: string;
      orderId: string;
      carrierName: string | null;
      carrierReference: string | null;
      lineCount: number;
      dispatchReservationId: string;
      commandKeyHash: string;
      actor: string;
      correlationId: string;
      at: Date;
    },
  ): Promise<ReturnShipmentRow> {
    const rows = await tx.$queryRaw<ReturnShipmentRow[]>`
      INSERT INTO "return_shipment" ("id", "organization_id", "destination_warehouse_id",
                                     "buyer_organization_id", "return_request_id", "order_id",
                                     "carrier_name", "carrier_reference", "line_count",
                                     "status", "command_key_hash", "created_at", "created_by",
                                     "created_correlation_id", "updated_at", "version",
                                     "dispatch_reservation_id")
      VALUES (${input.id}, ${input.organizationId}, ${input.destinationWarehouseId},
              ${input.buyerOrganizationId}, ${input.returnRequestId}, ${input.orderId},
              ${input.carrierName}, ${input.carrierReference}, ${input.lineCount}::integer, 'IN_TRANSIT',
              ${input.commandKeyHash}, ${input.at}, ${input.actor},
              ${input.correlationId}, ${input.at}, 1, ${input.dispatchReservationId})
      RETURNING ${COLUMNS}`;
    return rows[0] as ReturnShipmentRow;
  }

  // -- the dispatch fence (Q-133 (9)(a)) ---------------------------------------------------

  /**
   * Serialises everything that decides whether a return request has goods here: recording its
   * shipment, and withdrawing a reservation of it. One transaction-scoped advisory lock per
   * (organization, return request), the key `tg_return_shipment_dispatch_fence` and
   * `tg_return_dispatch_withdrawal_guard` take too — so the checks that follow run under it, and
   * whichever of a shipment and a withdrawal commits first, the other sees it.
   */
  async lockDispatch(
    tx: ExtendedPrismaClient,
    organizationId: string,
    returnRequestId: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`return-dispatch|${organizationId}|${returnRequestId}`}, 0))`;
  }

  /** The withdrawal of one reservation in the owner's books, or `null`. */
  async findWithdrawal(
    tx: ExtendedPrismaClient,
    organizationId: string,
    reservationId: string,
  ): Promise<ReturnDispatchWithdrawalRow | null> {
    const rows = await tx.$queryRaw<ReturnDispatchWithdrawalRow[]>`
      SELECT ${WITHDRAWAL_COLUMNS} FROM "return_dispatch_withdrawal"
       WHERE "organization_id" = ${organizationId} AND "reservation_id" = ${reservationId}`;
    return rows[0] ?? null;
  }

  async insertWithdrawal(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      returnRequestId: string;
      reservationId: string;
      at: Date;
      by: string;
      correlationId: string;
    },
  ): Promise<ReturnDispatchWithdrawalRow> {
    const rows = await tx.$queryRaw<ReturnDispatchWithdrawalRow[]>`
      INSERT INTO "return_dispatch_withdrawal" ("id", "organization_id", "return_request_id",
                                                "reservation_id", "withdrawn_at", "withdrawn_by",
                                                "correlation_id")
      VALUES (${input.id}, ${input.organizationId}, ${input.returnRequestId},
              ${input.reservationId}, ${input.at}, ${input.by}, ${input.correlationId})
      RETURNING ${WITHDRAWAL_COLUMNS}`;
    return rows[0] as ReturnDispatchWithdrawalRow;
  }

  async insertLine(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      returnShipmentId: string;
      orderLineId: string;
      productId: string;
      expectedQuantity: number;
      at: Date;
    },
  ): Promise<ReturnShipmentLineRow> {
    const rows = await tx.$queryRaw<ReturnShipmentLineRow[]>`
      INSERT INTO "return_shipment_line" ("id", "organization_id", "return_shipment_id",
                                          "order_line_id", "product_id", "expected_quantity",
                                          "created_at")
      VALUES (${input.id}, ${input.organizationId}, ${input.returnShipmentId},
              ${input.orderLineId}, ${input.productId}, ${input.expectedQuantity}::integer,
              ${input.at})
      RETURNING ${LINE_COLUMNS}`;
    return rows[0] as ReturnShipmentLineRow;
  }

  /** Records what arrived of one line, once — the shipment is already RECEIVED in this transaction. */
  async receiveLine(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      returnShipmentId: string;
      orderLineId: string;
      received: number;
    },
  ): Promise<ReturnShipmentLineRow | null> {
    const rows = await tx.$queryRaw<ReturnShipmentLineRow[]>`
      UPDATE "return_shipment_line"
         SET "received_quantity" = ${input.received}::integer
       WHERE "organization_id" = ${input.organizationId}
         AND "return_shipment_id" = ${input.returnShipmentId}
         AND "order_line_id" = ${input.orderLineId}
         AND "received_quantity" IS NULL
      RETURNING ${LINE_COLUMNS}`;
    return rows[0] ?? null;
  }

  /**
   * Records the status the shipment has just reached — after it reached it, with the version that
   * gave it: the event's place in the history, which the database checks against the shipment.
   */
  async insertTrackingEvent(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      returnShipmentId: string;
      type: ReturnShipmentStatus;
      shipmentVersion: number;
      commandKeyHash: string;
      actor: string;
      correlationId: string;
      at: Date;
    },
  ): Promise<ReturnTrackingEventRow> {
    const rows = await tx.$queryRaw<ReturnTrackingEventRow[]>`
      INSERT INTO "return_tracking_event" ("id", "organization_id", "return_shipment_id", "type",
                                           "shipment_version", "occurred_at", "recorded_at",
                                           "recorded_by", "correlation_id", "command_key_hash")
      VALUES (${input.id}, ${input.organizationId}, ${input.returnShipmentId}, ${input.type},
              ${input.shipmentVersion}::integer, ${input.at}, ${input.at}, ${input.actor},
              ${input.correlationId}, ${input.commandKeyHash})
      RETURNING ${EVENT_COLUMNS}`;
    return rows[0] as ReturnTrackingEventRow;
  }

  /** Locks one of the owner's return shipments — the only row a return-shipment command locks. */
  async lock(
    tx: ExtendedPrismaClient,
    organizationId: string,
    id: string,
  ): Promise<ReturnShipmentRow | null> {
    const rows = await tx.$queryRaw<ReturnShipmentRow[]>`
      SELECT ${COLUMNS} FROM "return_shipment"
       WHERE "organization_id" = ${organizationId} AND "id" = ${id}
       FOR UPDATE`;
    return rows[0] ?? null;
  }

  /**
   * The owner's shipment for a return request, if one was already dispatched — in the command's
   * transaction, or (no `tx`) before it, as the check that runs ahead of asking marketplace.
   */
  async findByRequest(
    tx: ExtendedPrismaClient | undefined,
    organizationId: string,
    returnRequestId: string,
  ): Promise<ReturnShipmentRow | null> {
    const client = tx ?? this.prisma.client;
    const rows = await client.$queryRaw<ReturnShipmentRow[]>`
      SELECT ${COLUMNS} FROM "return_shipment"
       WHERE "organization_id" = ${organizationId} AND "return_request_id" = ${returnRequestId}`;
    return rows[0] ?? null;
  }

  /**
   * Moves a locked shipment to RECEIVED — compare-and-set on its status and version, the time and
   * actor recorded beside it. `null` when it is no longer where it was.
   */
  async markReceived(
    tx: ExtendedPrismaClient,
    shipment: Pick<ReturnShipmentRow, 'organizationId' | 'id' | 'status' | 'version'>,
    actor: string,
    at: Date,
  ): Promise<ReturnShipmentRow | null> {
    const rows = await tx.$queryRaw<ReturnShipmentRow[]>`
      UPDATE "return_shipment"
         SET "status" = 'RECEIVED', "received_at" = ${at}, "received_by" = ${actor},
             "updated_at" = ${at}, "version" = "version" + 1
       WHERE "organization_id" = ${shipment.organizationId} AND "id" = ${shipment.id}
         AND "status" = ${shipment.status} AND "version" = ${shipment.version}::integer
       RETURNING ${COLUMNS}`;
    return rows[0] ?? null;
  }

  /**
   * RECEIVED → INSPECTED, the same way: compare-and-set, the inspector and instant recorded beside
   * it, with the note and the report reference the inspection carries.
   */
  async markInspected(
    tx: ExtendedPrismaClient,
    shipment: Pick<ReturnShipmentRow, 'organizationId' | 'id' | 'status' | 'version'>,
    inspection: { note: string | null; reportDocumentId: string | null },
    actor: string,
    at: Date,
  ): Promise<ReturnShipmentRow | null> {
    const rows = await tx.$queryRaw<ReturnShipmentRow[]>`
      UPDATE "return_shipment"
         SET "status" = 'INSPECTED', "inspected_at" = ${at}, "inspected_by" = ${actor},
             "inspection_note" = ${inspection.note},
             "inspection_report_document_id" = ${inspection.reportDocumentId},
             "updated_at" = ${at}, "version" = "version" + 1
       WHERE "organization_id" = ${shipment.organizationId} AND "id" = ${shipment.id}
         AND "status" = ${shipment.status} AND "version" = ${shipment.version}::integer
       RETURNING ${COLUMNS}`;
    return rows[0] ?? null;
  }

  /** INSPECTED → RESOLVED, the same way. Its dispositions are written right after, in the same transaction. */
  async markResolved(
    tx: ExtendedPrismaClient,
    shipment: Pick<ReturnShipmentRow, 'organizationId' | 'id' | 'status' | 'version'>,
    actor: string,
    at: Date,
  ): Promise<ReturnShipmentRow | null> {
    const rows = await tx.$queryRaw<ReturnShipmentRow[]>`
      UPDATE "return_shipment"
         SET "status" = 'RESOLVED', "resolved_at" = ${at}, "resolved_by" = ${actor},
             "updated_at" = ${at}, "version" = "version" + 1
       WHERE "organization_id" = ${shipment.organizationId} AND "id" = ${shipment.id}
         AND "status" = ${shipment.status} AND "version" = ${shipment.version}::integer
       RETURNING ${COLUMNS}`;
    return rows[0] ?? null;
  }

  async insertDisposition(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      returnShipmentId: string;
      orderLineId: string;
      disposition: ReturnDisposition;
      quantity: number;
      at: Date;
    },
  ): Promise<ReturnDispositionRow> {
    const rows = await tx.$queryRaw<ReturnDispositionRow[]>`
      INSERT INTO "return_disposition" ("id", "organization_id", "return_shipment_id",
                                        "order_line_id", "disposition", "quantity", "created_at")
      VALUES (${input.id}, ${input.organizationId}, ${input.returnShipmentId},
              ${input.orderLineId}, ${input.disposition}, ${input.quantity}::integer, ${input.at})
      RETURNING ${DISPOSITION_COLUMNS}`;
    return rows[0] as ReturnDispositionRow;
  }

  /** The dispositions of shipments already found visible, through their owner, in a stable order. */
  async dispositionsOf(
    shipments: readonly Pick<ReturnShipmentRow, 'organizationId' | 'id'>[],
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<Map<string, ReturnDispositionRow[]>> {
    const found = new Map<string, ReturnDispositionRow[]>(shipments.map((s) => [s.id, []]));
    if (shipments.length === 0) return found;
    const pairs = shipments.map((s) => Prisma.sql`(${s.organizationId}, ${s.id})`);
    const rows = await client.$queryRaw<(ReturnDispositionRow & { returnShipmentId: string })[]>`
      SELECT ${DISPOSITION_COLUMNS}, "return_shipment_id" AS "returnShipmentId"
        FROM "return_disposition"
       WHERE ("organization_id", "return_shipment_id") IN (${Prisma.join(pairs)})
       ORDER BY "return_shipment_id", "order_line_id", "disposition"`;
    for (const { returnShipmentId, ...row } of rows) found.get(returnShipmentId)?.push(row);
    return found;
  }

  // -- reads (destination owner or sender) ----------------------------------------------------

  /**
   * Runs a read of several statements — a shipment, then its lines — in **one snapshot**: one
   * `REPEATABLE READ` transaction, so every statement sees what a single instant held. Without it a
   * command committing between the header and the lines produced a view that never existed (an
   * `IN_TRANSIT` header with received quantities; Codex r1 on #311). Nothing is locked or written.
   */
  inSnapshot<T>(read: (tx: ExtendedPrismaClient) => Promise<T>): Promise<T> {
    return this.prisma.transaction(read, { isolationLevel: 'RepeatableRead' });
  }

  /** One return shipment, if the reader may see it from a side its roles open. */
  async findVisible(
    reader: ReturnShipmentVisibility,
    id: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<ReturnShipmentRow | null> {
    const visible = returnVisibleTo(reader);
    if (visible === null) return null;
    const rows = await client.$queryRaw<ReturnShipmentRow[]>`
      SELECT ${COLUMNS} FROM "return_shipment" WHERE "id" = ${id} AND ${visible}`;
    return rows[0] ?? null;
  }

  /** Newest first, `limit + 1` rows so the caller can tell whether there is more. */
  async listVisible(
    reader: ReturnShipmentVisibility,
    filter: {
      side?: ReturnShipmentSide;
      status?: ReturnShipmentStatus;
      returnRequestId?: string;
      cursor?: string;
      limit: number;
    },
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<ReturnShipmentRow[]> {
    const visible = returnVisibleTo(reader, filter.side);
    if (visible === null) return [];
    const status =
      filter.status === undefined ? Prisma.empty : Prisma.sql`AND "status" = ${filter.status}`;
    const request =
      filter.returnRequestId === undefined
        ? Prisma.empty
        : Prisma.sql`AND "return_request_id" = ${filter.returnRequestId}`;
    const after =
      filter.cursor === undefined ? Prisma.empty : Prisma.sql`AND "id" < ${filter.cursor}`;
    return client.$queryRaw<ReturnShipmentRow[]>`
      SELECT ${COLUMNS} FROM "return_shipment"
       WHERE ${visible} ${status} ${request} ${after}
       ORDER BY "id" DESC
       LIMIT ${filter.limit + 1}`;
  }

  /** The lines of shipments already found visible, through their owner, in a stable order. */
  async linesOf(
    shipments: readonly Pick<ReturnShipmentRow, 'organizationId' | 'id'>[],
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<Map<string, ReturnShipmentLineRow[]>> {
    const lines = new Map<string, ReturnShipmentLineRow[]>(shipments.map((s) => [s.id, []]));
    if (shipments.length === 0) return lines;
    const pairs = shipments.map((s) => Prisma.sql`(${s.organizationId}, ${s.id})`);
    const rows = await client.$queryRaw<(ReturnShipmentLineRow & { returnShipmentId: string })[]>`
      SELECT ${LINE_COLUMNS}, "return_shipment_id" AS "returnShipmentId" FROM "return_shipment_line"
       WHERE ("organization_id", "return_shipment_id") IN (${Prisma.join(pairs)})
       ORDER BY "return_shipment_id", "order_line_id"`;
    for (const { returnShipmentId, ...line } of rows) lines.get(returnShipmentId)?.push(line);
    return lines;
  }

  /**
   * One return shipment the reader may see and its tracking history, in lifecycle order — **one
   * statement**, so one snapshot: the status and the history are what a single instant held.
   */
  async findTracked(
    reader: ReturnShipmentVisibility,
    id: string,
  ): Promise<{ shipment: ReturnShipmentRow; events: ReturnTrackingEventRow[] } | null> {
    const visible = returnVisibleTo(reader);
    if (visible === null) return null;
    const rows = await this.prisma.client.$queryRaw<TrackedRow[]>`
      WITH "s" AS (SELECT ${COLUMNS} FROM "return_shipment" WHERE "id" = ${id} AND ${visible})
      SELECT "s".*, "e"."id" AS "eventId", "e"."type" AS "eventType",
             "e"."shipment_version" AS "eventShipmentVersion",
             "e"."occurred_at" AS "eventOccurredAt", "e"."recorded_at" AS "eventRecordedAt"
        FROM "s"
        LEFT JOIN "return_tracking_event" "e"
          ON "e"."organization_id" = "s"."organizationId" AND "e"."return_shipment_id" = "s"."id"
       ORDER BY "e"."shipment_version"`;
    const first = rows[0];
    if (first === undefined) return null;
    const {
      eventId: _id,
      eventType: _type,
      eventShipmentVersion: _version,
      eventOccurredAt: _occurredAt,
      eventRecordedAt: _recordedAt,
      ...shipment
    } = first;
    const events: ReturnTrackingEventRow[] = [];
    for (const row of rows) {
      if (row.eventId === null) continue;
      events.push({
        id: row.eventId,
        returnShipmentId: row.id,
        type: row.eventType as ReturnShipmentStatus,
        shipmentVersion: row.eventShipmentVersion as number,
        occurredAt: row.eventOccurredAt as Date,
        recordedAt: row.eventRecordedAt as Date,
      });
    }
    return { shipment, events };
  }
}

/** A return shipment beside one of its tracking events (all `null` for one without any). */
type TrackedRow = ReturnShipmentRow & {
  eventId: string | null;
  eventType: string | null;
  eventShipmentVersion: number | null;
  eventOccurredAt: Date | null;
  eventRecordedAt: Date | null;
};
