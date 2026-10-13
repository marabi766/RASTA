import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { ShipmentSide, ShipmentStatus } from './dto';

export interface ShipmentRow {
  id: string;
  organizationId: string;
  originWarehouseId: string;
  consigneeOrganizationId: string;
  orderReference: string | null;
  status: ShipmentStatus;
  legCount: number;
  createdAt: Date;
  createdBy: string;
  dispatchedAt: Date | null;
  deliveredAt: Date | null;
  updatedAt: Date;
  version: number;
}

export interface ShipmentLegRow {
  id: string;
  sequence: number;
  carrierName: string;
  carrierReference: string | null;
}

export interface TrackingEventRow {
  id: string;
  shipmentId: string;
  type: ShipmentStatus;
  occurredAt: Date;
  recordedAt: Date;
}

/**
 * Who reads, and from which sides (ADR-056 § 5): the acting organization as owner of the origin
 * warehouse, as consignee, or both — as its roles open them (`InventoryAccess.assertShipmentReader`).
 */
export interface Visibility {
  organizationId: string;
  asOrigin: boolean;
  asConsignee: boolean;
}

const COLUMNS = Prisma.sql`
  "id", "organization_id" AS "organizationId", "origin_warehouse_id" AS "originWarehouseId",
  "consignee_organization_id" AS "consigneeOrganizationId", "order_reference" AS "orderReference",
  "status", "leg_count" AS "legCount", "created_at" AS "createdAt", "created_by" AS "createdBy",
  "dispatched_at" AS "dispatchedAt", "delivered_at" AS "deliveredAt",
  "updated_at" AS "updatedAt", "version"`;

const LEG_COLUMNS = Prisma.sql`
  "id", "sequence", "carrier_name" AS "carrierName", "carrier_reference" AS "carrierReference"`;

const EVENT_COLUMNS = Prisma.sql`
  "id", "shipment_id" AS "shipmentId", "type", "occurred_at" AS "occurredAt",
  "recorded_at" AS "recordedAt"`;

/**
 * The rows a reader may see, as one predicate that names the organization in each column it
 * reads by — `organization_id` for the owner's side, `consignee_organization_id` for the
 * consignee's — or `null` when no side is open (nothing is visible). `side` narrows it further.
 */
export function visibleTo(reader: Visibility, side?: ShipmentSide): Prisma.Sql | null {
  const parts: Prisma.Sql[] = [];
  if (reader.asOrigin && side !== 'consignee') {
    parts.push(Prisma.sql`"organization_id" = ${reader.organizationId}`);
  }
  if (reader.asConsignee && side !== 'origin') {
    parts.push(Prisma.sql`"consignee_organization_id" = ${reader.organizationId}`);
  }
  return parts.length === 0 ? null : Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

/**
 * Shipments, their legs and their tracking history (ADR-056 § 2, § 5).
 *
 * Everything is SQL. The writes run in the command's transaction and are the owner's, each naming
 * `organization_id` in its own predicate. The reads cross tenants **by design** — a shipment is
 * read by its owner and by its consignee — which the tenant guard can neither see nor express:
 * each read names, in its own predicate, the organization in the column it is read by
 * ({@link visibleTo}), and the legs and history are read only for a shipment found that way,
 * through its owner's `organization_id`.
 */
@Injectable()
export class ShipmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  // -- writes (the owner's, in the command's transaction) ----------------------------------

  async insert(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      originWarehouseId: string;
      consigneeOrganizationId: string;
      orderReference: string | null;
      legCount: number;
      commandKeyHash: string;
      actor: string;
      correlationId: string;
      at: Date;
    },
  ): Promise<ShipmentRow> {
    const rows = await tx.$queryRaw<ShipmentRow[]>`
      INSERT INTO "shipment" ("id", "organization_id", "origin_warehouse_id",
                              "consignee_organization_id", "order_reference", "status",
                              "leg_count", "command_key_hash", "created_at", "created_by",
                              "created_correlation_id", "updated_at", "version")
      VALUES (${input.id}, ${input.organizationId}, ${input.originWarehouseId},
              ${input.consigneeOrganizationId}, ${input.orderReference}, 'CREATED',
              ${input.legCount}::integer, ${input.commandKeyHash}, ${input.at}, ${input.actor},
              ${input.correlationId}, ${input.at}, 1)
      RETURNING ${COLUMNS}`;
    return rows[0] as ShipmentRow;
  }

  async insertLeg(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      shipmentId: string;
      sequence: number;
      carrierName: string;
      carrierReference: string | null;
      at: Date;
    },
  ): Promise<ShipmentLegRow> {
    const rows = await tx.$queryRaw<ShipmentLegRow[]>`
      INSERT INTO "shipment_leg" ("id", "organization_id", "shipment_id", "sequence",
                                  "carrier_name", "carrier_reference", "created_at")
      VALUES (${input.id}, ${input.organizationId}, ${input.shipmentId}, ${input.sequence}::integer,
              ${input.carrierName}, ${input.carrierReference}, ${input.at})
      RETURNING ${LEG_COLUMNS}`;
    return rows[0] as ShipmentLegRow;
  }

  /** Records the status the shipment has just reached — after it reached it. */
  async insertTrackingEvent(
    tx: ExtendedPrismaClient,
    input: {
      id: string;
      organizationId: string;
      shipmentId: string;
      type: ShipmentStatus;
      commandKeyHash: string;
      actor: string;
      correlationId: string;
      at: Date;
    },
  ): Promise<TrackingEventRow> {
    const rows = await tx.$queryRaw<TrackingEventRow[]>`
      INSERT INTO "tracking_event" ("id", "organization_id", "shipment_id", "type",
                                    "occurred_at", "recorded_at", "recorded_by",
                                    "correlation_id", "command_key_hash")
      VALUES (${input.id}, ${input.organizationId}, ${input.shipmentId}, ${input.type},
              ${input.at}, ${input.at}, ${input.actor}, ${input.correlationId},
              ${input.commandKeyHash})
      RETURNING ${EVENT_COLUMNS}`;
    return rows[0] as TrackingEventRow;
  }

  /** Locks one of the owner's shipments — the only row a shipment command locks. */
  async lock(
    tx: ExtendedPrismaClient,
    organizationId: string,
    id: string,
  ): Promise<ShipmentRow | null> {
    const rows = await tx.$queryRaw<ShipmentRow[]>`
      SELECT ${COLUMNS} FROM "shipment"
       WHERE "organization_id" = ${organizationId} AND "id" = ${id}
       FOR UPDATE`;
    return rows[0] ?? null;
  }

  /**
   * Moves a locked shipment to its next status — compare-and-set on its status and version, the
   * time and actor of that status recorded beside it. `null` when it is no longer where it was.
   */
  async advance(
    tx: ExtendedPrismaClient,
    shipment: Pick<ShipmentRow, 'organizationId' | 'id' | 'status' | 'version'>,
    to: 'DISPATCHED' | 'DELIVERED',
    actor: string,
    at: Date,
  ): Promise<ShipmentRow | null> {
    const stamp =
      to === 'DISPATCHED'
        ? Prisma.sql`"dispatched_at" = ${at}, "dispatched_by" = ${actor}`
        : Prisma.sql`"delivered_at" = ${at}, "delivered_by" = ${actor}`;
    const rows = await tx.$queryRaw<ShipmentRow[]>`
      UPDATE "shipment"
         SET "status" = ${to}, ${stamp}, "updated_at" = ${at},
             "version" = "version" + 1
       WHERE "organization_id" = ${shipment.organizationId} AND "id" = ${shipment.id}
         AND "status" = ${shipment.status} AND "version" = ${shipment.version}::integer
       RETURNING ${COLUMNS}`;
    return rows[0] ?? null;
  }

  // -- reads (owner or consignee) ------------------------------------------------------------

  /** One shipment, if the reader may see it from a side its roles open. */
  async findVisible(
    reader: Visibility,
    id: string,
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<ShipmentRow | null> {
    const visible = visibleTo(reader);
    if (visible === null) return null;
    const rows = await client.$queryRaw<ShipmentRow[]>`
      SELECT ${COLUMNS} FROM "shipment" WHERE "id" = ${id} AND ${visible}`;
    return rows[0] ?? null;
  }

  /** Newest first, `limit + 1` rows so the caller can tell whether there is more. */
  async listVisible(
    reader: Visibility,
    filter: { side?: ShipmentSide; status?: ShipmentStatus; cursor?: string; limit: number },
  ): Promise<ShipmentRow[]> {
    const visible = visibleTo(reader, filter.side);
    if (visible === null) return [];
    const status =
      filter.status === undefined ? Prisma.empty : Prisma.sql`AND "status" = ${filter.status}`;
    const after =
      filter.cursor === undefined ? Prisma.empty : Prisma.sql`AND "id" < ${filter.cursor}`;
    return this.prisma.client.$queryRaw<ShipmentRow[]>`
      SELECT ${COLUMNS} FROM "shipment"
       WHERE ${visible} ${status} ${after}
       ORDER BY "id" DESC
       LIMIT ${filter.limit + 1}`;
  }

  /** The legs of shipments already found visible, through their owner, in order. */
  async legsOf(
    shipments: readonly Pick<ShipmentRow, 'organizationId' | 'id'>[],
    client: ExtendedPrismaClient = this.prisma.client,
  ): Promise<Map<string, ShipmentLegRow[]>> {
    const legs = new Map<string, ShipmentLegRow[]>(shipments.map((s) => [s.id, []]));
    if (shipments.length === 0) return legs;
    const pairs = shipments.map((s) => Prisma.sql`(${s.organizationId}, ${s.id})`);
    const rows = await client.$queryRaw<(ShipmentLegRow & { shipmentId: string })[]>`
      SELECT ${LEG_COLUMNS}, "shipment_id" AS "shipmentId" FROM "shipment_leg"
       WHERE ("organization_id", "shipment_id") IN (${Prisma.join(pairs)})
       ORDER BY "shipment_id", "sequence"`;
    for (const { shipmentId, ...leg } of rows) legs.get(shipmentId)?.push(leg);
    return legs;
  }

  /** The tracking history of a shipment already found visible, through its owner, in order. */
  async eventsOf(
    shipment: Pick<ShipmentRow, 'organizationId' | 'id'>,
  ): Promise<TrackingEventRow[]> {
    return this.prisma.client.$queryRaw<TrackingEventRow[]>`
      SELECT ${EVENT_COLUMNS} FROM "tracking_event"
       WHERE "organization_id" = ${shipment.organizationId} AND "shipment_id" = ${shipment.id}
       ORDER BY "occurred_at", "id"`;
  }
}
