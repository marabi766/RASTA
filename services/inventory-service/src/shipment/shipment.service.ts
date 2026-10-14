import { Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import { InventoryAccess } from '../access/access';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import type { Command } from '../shared/command';
import { CommandRunner } from '../shared/command-runner';
import { pageOf, type CursorPage } from '../shared/dto';
import { refusal } from '../shared/refusal';
import { WarehouseRepository } from '../warehouse/warehouse.repository';
import type {
  CreateShipmentDto,
  ListShipmentsQuery,
  MoveShipmentDto,
  ShipmentView,
  TrackingView,
} from './dto';
import { ShipmentRepository, type ShipmentRow } from './shipment.repository';
import { SHIPMENT_VERSION_OF, canMove } from './shipment.state-machine';
import { toShipmentView, toTrackingView } from './views';

/**
 * Shipments (ADR-056 § 2, § 5; plan steps 8–10): `CreateShipment`, `DispatchShipment` and
 * `DeliverShipment` (`ConfirmDelivery` in `docs/04` § 4.11), and the reads `GetShipment` and
 * `TrackShipment`.
 *
 * ## Who
 *
 * Every command is an operator's of the organization that owns the origin warehouse (plan step
 * 10). The consignee reads the shipment and its tracking and moves nothing (Q-113, Q-114): a
 * command of its is `403` — it can see the shipment, so a `404` would hide nothing — while any
 * third organization gets `404` for everything (ADR-056 § 5, negative 3).
 *
 * ## One transaction per command
 *
 * `CommandRunner`, as every stock command: the shipment (created, or locked and moved by
 * compare-and-set), its tracking event, its outbox event and the stored response commit together
 * or not at all. A shipment command locks one row — the shipment — and no stock item, so it can
 * never wait in a cycle with a stock command. A shipment moves no stock (Q-115).
 */
@Injectable()
export class ShipmentService {
  constructor(
    private readonly shipments: ShipmentRepository,
    private readonly warehouses: WarehouseRepository,
    private readonly access: InventoryAccess,
    private readonly publisher: EventPublisher,
    private readonly runner: CommandRunner,
  ) {}

  // -- create -------------------------------------------------------------------------------

  /** Creates a CREATED shipment out of one of the owner's warehouses, with its legs. */
  async create(dto: CreateShipmentDto, command: Command<ShipmentView>): Promise<ShipmentView> {
    const acting = this.access.assertOperator();
    const correlationId = getContext().correlationId;

    return this.runner.run('create_shipment', command.fence, null, async (tx, at) => {
      // Another organization's warehouse, or none: 404 — a shipment leaves its owner's
      // warehouse and no other (ADR-056 § 2; the composite foreign key says the same).
      const warehouse = await this.warehouses.find(
        acting.organizationId,
        dto.originWarehouseId,
        tx,
      );
      if (!warehouse) throw RastaError.notFound('Warehouse', dto.originWarehouseId);

      const shipment = await this.shipments.insert(tx, {
        id: newId(ID_PREFIX.shipment),
        organizationId: acting.organizationId,
        originWarehouseId: warehouse.id,
        consigneeOrganizationId: dto.consigneeOrganizationId,
        orderReference: dto.orderReference ?? null,
        legCount: dto.legs.length,
        commandKeyHash: command.keyHash,
        actor: acting.userId,
        correlationId,
        at,
      });
      const legs = [];
      for (const [index, leg] of dto.legs.entries()) {
        legs.push(
          await this.shipments.insertLeg(tx, {
            id: newId(ID_PREFIX.shipmentLeg),
            organizationId: shipment.organizationId,
            shipmentId: shipment.id,
            sequence: index + 1,
            carrierName: leg.carrierName,
            carrierReference: leg.carrierReference ?? null,
            at,
          }),
        );
      }
      const tracked = await this.shipments.insertTrackingEvent(tx, {
        id: newId(ID_PREFIX.trackingEvent),
        organizationId: shipment.organizationId,
        shipmentId: shipment.id,
        type: 'CREATED',
        shipmentVersion: shipment.version,
        commandKeyHash: command.keyHash,
        actor: acting.userId,
        correlationId,
        at,
      });
      await this.publisher.enqueue(tx, {
        eventName: 'SHIPMENT_CREATED',
        aggregateId: shipment.id,
        organizationId: shipment.organizationId,
        occurredAt: at,
        payload: {
          ...shipmentFacts(shipment, tracked.id),
          shipmentVersion: SHIPMENT_VERSION_OF.CREATED,
          legCount: shipment.legCount,
          createdBy: acting.userId,
          createdAt: at.toISOString(),
        },
      });
      return toShipmentView(shipment, legs);
    });
  }

  // -- dispatch and deliver -----------------------------------------------------------------

  /** CREATED → DISPATCHED: the shipment left its origin warehouse. */
  async dispatch(
    id: string,
    dto: MoveShipmentDto,
    command: Command<ShipmentView>,
  ): Promise<ShipmentView> {
    return this.move('DISPATCHED', id, dto, command);
  }

  /** DISPATCHED → DELIVERED, as the origin warehouse's owner records it (plan step 10). */
  async deliver(
    id: string,
    dto: MoveShipmentDto,
    command: Command<ShipmentView>,
  ): Promise<ShipmentView> {
    return this.move('DELIVERED', id, dto, command);
  }

  private async move(
    to: 'DISPATCHED' | 'DELIVERED',
    id: string,
    dto: MoveShipmentDto,
    command: Command<ShipmentView>,
  ): Promise<ShipmentView> {
    const acting = this.access.assertOperator();
    const correlationId = getContext().correlationId;
    const name = to === 'DISPATCHED' ? 'dispatch_shipment' : 'deliver_shipment';

    return this.runner.run(name, command.fence, null, async (tx, at) => {
      const locked = await this.shipments.lock(tx, acting.organizationId, id);
      if (!locked) throw await this.notMovable(tx, acting.organizationId, id);
      if (!canMove(locked.status, to)) {
        throw refusal(
          'shipment',
          to === 'DISPATCHED' ? 'SHIPMENT_NOT_CREATED' : 'SHIPMENT_NOT_DISPATCHED',
          to === 'DISPATCHED'
            ? 'The shipment has already been dispatched'
            : 'The shipment has not been dispatched, or has already been delivered',
          { shipmentId: id, status: locked.status },
        );
      }
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== locked.version) {
        throw RastaError.optimisticLockFailed('Shipment', id);
      }
      // Never before what it follows: a command whose transaction began before the previous
      // move committed (it then waited on the row) still records its step after that one.
      const when = new Date(Math.max(at.getTime(), locked.updatedAt.getTime()));
      const moved = await this.shipments.advance(tx, locked, to, acting.userId, when);
      if (!moved) throw RastaError.optimisticLockFailed('Shipment', id);

      const tracked = await this.shipments.insertTrackingEvent(tx, {
        id: newId(ID_PREFIX.trackingEvent),
        organizationId: moved.organizationId,
        shipmentId: moved.id,
        type: to,
        shipmentVersion: moved.version,
        commandKeyHash: command.keyHash,
        actor: acting.userId,
        correlationId,
        at: when,
      });
      const facts = shipmentFacts(moved, tracked.id);
      if (to === 'DISPATCHED') {
        await this.publisher.enqueue(tx, {
          eventName: 'SHIPMENT_DISPATCHED',
          aggregateId: moved.id,
          organizationId: moved.organizationId,
          occurredAt: when,
          payload: {
            ...facts,
            shipmentVersion: SHIPMENT_VERSION_OF.DISPATCHED,
            dispatchedBy: acting.userId,
            dispatchedAt: when.toISOString(),
          },
        });
      } else {
        await this.publisher.enqueue(tx, {
          eventName: 'SHIPMENT_DELIVERED',
          aggregateId: moved.id,
          organizationId: moved.organizationId,
          occurredAt: when,
          payload: {
            ...facts,
            shipmentVersion: SHIPMENT_VERSION_OF.DELIVERED,
            deliveredBy: acting.userId,
            deliveredAt: when.toISOString(),
          },
        });
      }
      const legs = await this.shipments.legsOf([moved], tx);
      return toShipmentView(moved, legs.get(moved.id) ?? []);
    });
  }

  /**
   * Why a shipment the acting organization does not own cannot be moved: its consignee — one
   * whose roles let it read the shipment — is told it may not (`403`); anybody else learns
   * nothing (`404`, ADR-056 § 5).
   */
  private async notMovable(
    tx: ExtendedPrismaClient,
    organizationId: string,
    id: string,
  ): Promise<RastaError> {
    if (this.access.readsAsConsignee()) {
      const asConsignee = await this.shipments.findVisible(
        { organizationId, asOrigin: false, asConsignee: true },
        id,
        tx,
      );
      if (asConsignee) {
        return RastaError.forbidden(
          'A shipment is moved by the owner of its origin warehouse; its consignee reads it',
        );
      }
    }
    return RastaError.notFound('Shipment', id);
  }

  // -- reads --------------------------------------------------------------------------------

  async get(id: string): Promise<ShipmentView> {
    const row = await this.visible(id);
    const legs = await this.shipments.legsOf([row]);
    return toShipmentView(row, legs.get(row.id) ?? []);
  }

  /**
   * `TrackShipment`: the shipment's status and its tracking history, in lifecycle order, read
   * together in one statement — so the status and the history always agree.
   */
  async tracking(id: string): Promise<TrackingView> {
    const reader = this.access.assertShipmentReader();
    const tracked = await this.shipments.findTracked(reader, id);
    if (!tracked) throw RastaError.notFound('Shipment', id);
    return toTrackingView(tracked.shipment, tracked.events);
  }

  async list(query: ListShipmentsQuery): Promise<CursorPage<ShipmentView>> {
    const reader = this.access.assertShipmentReader();
    const rows = await this.shipments.listVisible(reader, {
      ...(query.side === undefined ? {} : { side: query.side }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit: query.limit,
    });
    const legs = await this.shipments.legsOf(rows.slice(0, query.limit));
    return pageOf(rows, query.limit, (row) => toShipmentView(row, legs.get(row.id) ?? []));
  }

  /** Whether the caller may still see this shipment (the replay of a command). */
  async assertVisible(id: string): Promise<void> {
    await this.visible(id);
  }

  private async visible(id: string): Promise<ShipmentRow> {
    const reader = this.access.assertShipmentReader();
    const row = await this.shipments.findVisible(reader, id);
    if (!row) throw RastaError.notFound('Shipment', id);
    return row;
  }
}

/** What every shipment event says about the shipment (`@rasta/contracts`, inventory-shipments). */
function shipmentFacts(row: ShipmentRow, trackingEventId: string) {
  return {
    shipmentId: row.id,
    organizationId: row.organizationId,
    originWarehouseId: row.originWarehouseId,
    consigneeOrganizationId: row.consigneeOrganizationId,
    orderReference: row.orderReference,
    trackingEventId,
  };
}
