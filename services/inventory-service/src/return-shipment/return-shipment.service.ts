import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import { InventoryAccess } from '../access/access';
import type { InventoryEnv } from '../config/env';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import type { Command } from '../shared/command';
import { CommandRunner } from '../shared/command-runner';
import { pageOf, type CursorPage } from '../shared/dto';
import { refusal } from '../shared/refusal';
import { ENV } from '../tokens';
import { WarehouseRepository } from '../warehouse/warehouse.repository';
import type {
  CreateReturnShipmentDto,
  InspectReturnShipmentDto,
  ListReturnShipmentsQuery,
  ReceiveReturnShipmentDto,
  ResolveReturnShipmentDto,
  ReturnShipmentView,
  ReturnTrackingView,
} from './dto';
import {
  ReturnShipmentRepository,
  type ReturnDispositionRow,
  type ReturnShipmentLineRow,
  type ReturnShipmentRow,
} from './return-shipment.repository';
import { RETURN_SHIPMENT_VERSION_OF, canMove } from './return-shipment.state-machine';
import { toReturnShipmentView, toReturnTrackingView } from './views';

/**
 * Return shipments (ADR-048 § 2, § 3; RUN-005 PR 2): `DispatchReturnShipment` (goods of a return
 * are on their way back), `ReceiveReturnShipment` (they arrived), `InspectReturnShipment` (the
 * received goods were examined), `ResolveReturnShipment` (every received unit was given an
 * outcome), and the reads.
 *
 * ## What this service does and does not say
 *
 * It records what happened to goods — nothing else. It never reads marketplace's return request,
 * so it cannot say the return was *allowed*; marketplace, which owns the request, verifies every
 * event published here against it (a return it does not know, did not authorize, or whose supplier
 * is not this event's organization is refused there). It moves no stock — returned goods are not
 * sellable until inspection ends (ADR-048 § 4), and a RESTOCK disposition is a record, not a
 * receipt into a balance — and no money: a refund is economic's, and cannot be asked for here
 * (Q-76). Which dispositions may be recorded is configuration with no default (Q-133).
 *
 * ## Who
 *
 * Every command is an operator's of the organization that owns the destination warehouse (Q-133,
 * temporary decision: the order's supplier). The sender reads the return shipment and its tracking
 * and moves nothing: a command of its is `403` — it can see the shipment, so a `404` would hide
 * nothing — while any third organization gets `404` for everything.
 *
 * ## One transaction per command
 *
 * `CommandRunner`, as every stock and shipment command: the return shipment (created, or locked and
 * moved by compare-and-set), its lines, its tracking event, its outbox event and the stored
 * response commit together or not at all. A command locks one row — the return shipment — and no
 * stock item.
 */
@Injectable()
export class ReturnShipmentService {
  constructor(
    private readonly shipments: ReturnShipmentRepository,
    private readonly warehouses: WarehouseRepository,
    private readonly access: InventoryAccess,
    private readonly publisher: EventPublisher,
    private readonly runner: CommandRunner,
    @Inject(ENV) private readonly env: InventoryEnv,
  ) {}

  // -- dispatch -----------------------------------------------------------------------------

  /** Records goods of a return as on their way to one of the owner's warehouses: IN_TRANSIT. */
  async dispatch(
    dto: CreateReturnShipmentDto,
    command: Command<ReturnShipmentView>,
  ): Promise<ReturnShipmentView> {
    const acting = this.access.assertOperator();
    const correlationId = getContext().correlationId;

    if (dto.buyerOrganizationId === acting.organizationId) {
      throw RastaError.validation(
        [
          {
            path: 'buyerOrganizationId',
            code: 'sender_is_receiver',
            message: 'Goods are not returned to the organization they come from',
          },
        ],
        'A return shipment comes from another organization',
      );
    }

    return this.runner.run('create_return_shipment', command.fence, null, async (tx, at) => {
      // Another organization's warehouse, or none: 404 — a return arrives in its owner's
      // warehouse and no other (the composite foreign key says the same).
      const warehouse = await this.warehouses.find(
        acting.organizationId,
        dto.destinationWarehouseId,
        tx,
      );
      if (!warehouse) throw RastaError.notFound('Warehouse', dto.destinationWarehouseId);

      // One consignment per return (Q-133): a second dispatch under another key is refused, with
      // the unique index behind this read for two that race.
      const existing = await this.shipments.findByRequest(
        tx,
        acting.organizationId,
        dto.returnRequestId,
      );
      if (existing) {
        throw refusal(
          'returnShipment',
          'RETURN_ALREADY_DISPATCHED',
          'This return request already has a return shipment',
          { returnShipmentId: existing.id },
        );
      }

      const shipment = await this.shipments.insert(tx, {
        id: newId(ID_PREFIX.returnShipment),
        organizationId: acting.organizationId,
        destinationWarehouseId: warehouse.id,
        buyerOrganizationId: dto.buyerOrganizationId,
        returnRequestId: dto.returnRequestId,
        orderId: dto.orderId,
        carrierName: dto.carrierName ?? null,
        carrierReference: dto.carrierReference ?? null,
        lineCount: dto.lines.length,
        commandKeyHash: command.keyHash,
        actor: acting.userId,
        correlationId,
        at,
      });
      const lines: ReturnShipmentLineRow[] = [];
      for (const line of dto.lines) {
        lines.push(
          await this.shipments.insertLine(tx, {
            id: newId(ID_PREFIX.returnShipmentLine),
            organizationId: shipment.organizationId,
            returnShipmentId: shipment.id,
            orderLineId: line.orderLineId,
            productId: line.productId,
            expectedQuantity: line.quantity,
            at,
          }),
        );
      }
      const tracked = await this.shipments.insertTrackingEvent(tx, {
        id: newId(ID_PREFIX.returnTrackingEvent),
        organizationId: shipment.organizationId,
        returnShipmentId: shipment.id,
        type: 'IN_TRANSIT',
        shipmentVersion: shipment.version,
        commandKeyHash: command.keyHash,
        actor: acting.userId,
        correlationId,
        at,
      });
      await this.publisher.enqueue(tx, {
        eventName: 'RETURN_SHIPMENT_DISPATCHED',
        aggregateId: shipment.id,
        organizationId: shipment.organizationId,
        occurredAt: at,
        payload: {
          ...returnShipmentFacts(shipment, tracked.id),
          returnShipmentVersion: RETURN_SHIPMENT_VERSION_OF.IN_TRANSIT,
          lines: lines.map((line) => ({
            orderLineId: line.orderLineId,
            productId: line.productId,
            expectedQuantity: line.expectedQuantity,
          })),
          dispatchedBy: acting.userId,
          dispatchedAt: at.toISOString(),
        },
      });
      return toReturnShipmentView(shipment, lines);
    });
  }

  // -- receive ------------------------------------------------------------------------------

  /** IN_TRANSIT → RECEIVED: the goods arrived at the destination warehouse. They are not stock. */
  async receive(
    id: string,
    dto: ReceiveReturnShipmentDto,
    command: Command<ReturnShipmentView>,
  ): Promise<ReturnShipmentView> {
    const acting = this.access.assertOperator();
    const correlationId = getContext().correlationId;

    return this.runner.run('receive_return_shipment', command.fence, null, async (tx, at) => {
      const locked = await this.shipments.lock(tx, acting.organizationId, id);
      if (!locked) throw await this.notMovable(tx, acting.organizationId, id);
      if (!canMove(locked.status, 'RECEIVED')) {
        throw refusal(
          'returnShipment',
          'RETURN_SHIPMENT_NOT_IN_TRANSIT',
          'The return shipment has already been received',
          { returnShipmentId: id, status: locked.status },
        );
      }
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== locked.version) {
        throw RastaError.optimisticLockFailed('ReturnShipment', id);
      }

      const dispatched = (await this.shipments.linesOf([locked], tx)).get(locked.id) ?? [];
      const expected = new Map(dispatched.map((line) => [line.orderLineId, line]));
      const arrived = new Map(dto.lines.map((line) => [line.orderLineId, line.receivedQuantity]));
      if (
        arrived.size !== dto.lines.length ||
        arrived.size !== expected.size ||
        [...arrived.keys()].some((orderLineId) => !expected.has(orderLineId))
      ) {
        throw refusal(
          'returnShipment',
          'RECEIPT_LINES_MISMATCH',
          'A receipt names exactly the lines the return shipment was dispatched with, each once',
          { returnShipmentId: id },
        );
      }
      for (const line of dispatched) {
        if ((arrived.get(line.orderLineId) as number) > line.expectedQuantity) {
          throw refusal(
            'returnShipment',
            'RECEIVED_EXCEEDS_EXPECTED',
            'A line cannot arrive in a larger quantity than it was dispatched in',
            { returnShipmentId: id, orderLineId: line.orderLineId },
          );
        }
      }

      // Never before what it follows: a command whose transaction began before the previous
      // move committed (it then waited on the row) still records its step after that one.
      const when = new Date(Math.max(at.getTime(), locked.updatedAt.getTime()));
      const moved = await this.shipments.markReceived(tx, locked, acting.userId, when);
      if (!moved) throw RastaError.optimisticLockFailed('ReturnShipment', id);

      const lines: ReturnShipmentLineRow[] = [];
      for (const line of dispatched) {
        const updated = await this.shipments.receiveLine(tx, {
          organizationId: moved.organizationId,
          returnShipmentId: moved.id,
          orderLineId: line.orderLineId,
          received: arrived.get(line.orderLineId) as number,
        });
        if (!updated) throw RastaError.optimisticLockFailed('ReturnShipment', id);
        lines.push(updated);
      }
      const tracked = await this.shipments.insertTrackingEvent(tx, {
        id: newId(ID_PREFIX.returnTrackingEvent),
        organizationId: moved.organizationId,
        returnShipmentId: moved.id,
        type: 'RECEIVED',
        shipmentVersion: moved.version,
        commandKeyHash: command.keyHash,
        actor: acting.userId,
        correlationId,
        at: when,
      });
      await this.publisher.enqueue(tx, {
        eventName: 'RETURN_SHIPMENT_RECEIVED',
        aggregateId: moved.id,
        organizationId: moved.organizationId,
        occurredAt: when,
        payload: {
          ...returnShipmentFacts(moved, tracked.id),
          returnShipmentVersion: RETURN_SHIPMENT_VERSION_OF.RECEIVED,
          lines: lines.map((line) => ({
            orderLineId: line.orderLineId,
            productId: line.productId,
            expectedQuantity: line.expectedQuantity,
            receivedQuantity: line.receivedQuantity as number,
          })),
          receivedBy: acting.userId,
          receivedAt: when.toISOString(),
        },
      });
      return toReturnShipmentView(moved, lines);
    });
  }

  // -- inspect ------------------------------------------------------------------------------

  /**
   * RECEIVED → INSPECTED: the received goods were examined. The note (words) stays here; the
   * report is a file in document-service, referenced by id. The goods are still not stock.
   */
  async inspect(
    id: string,
    dto: InspectReturnShipmentDto,
    command: Command<ReturnShipmentView>,
  ): Promise<ReturnShipmentView> {
    const acting = this.access.assertOperator();
    const correlationId = getContext().correlationId;

    return this.runner.run('inspect_return_shipment', command.fence, null, async (tx, at) => {
      const locked = await this.shipments.lock(tx, acting.organizationId, id);
      if (!locked) throw await this.notMovable(tx, acting.organizationId, id);
      if (!canMove(locked.status, 'INSPECTED')) {
        throw refusal(
          'returnShipment',
          'RETURN_SHIPMENT_NOT_RECEIVED',
          'A return shipment is inspected once, after it was received',
          { returnShipmentId: id, status: locked.status },
        );
      }
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== locked.version) {
        throw RastaError.optimisticLockFailed('ReturnShipment', id);
      }

      const when = new Date(Math.max(at.getTime(), locked.updatedAt.getTime()));
      const moved = await this.shipments.markInspected(
        tx,
        locked,
        { note: dto.note ?? null, reportDocumentId: dto.reportDocumentId ?? null },
        acting.userId,
        when,
      );
      if (!moved) throw RastaError.optimisticLockFailed('ReturnShipment', id);

      const tracked = await this.shipments.insertTrackingEvent(tx, {
        id: newId(ID_PREFIX.returnTrackingEvent),
        organizationId: moved.organizationId,
        returnShipmentId: moved.id,
        type: 'INSPECTED',
        shipmentVersion: moved.version,
        commandKeyHash: command.keyHash,
        actor: acting.userId,
        correlationId,
        at: when,
      });
      await this.publisher.enqueue(tx, {
        eventName: 'RETURN_SHIPMENT_INSPECTED',
        aggregateId: moved.id,
        organizationId: moved.organizationId,
        occurredAt: when,
        payload: {
          ...returnShipmentFacts(moved, tracked.id),
          returnShipmentVersion: RETURN_SHIPMENT_VERSION_OF.INSPECTED,
          reportDocumentId: moved.inspectionReportDocumentId,
          inspectedBy: acting.userId,
          inspectedAt: when.toISOString(),
        },
      });
      const lines = (await this.shipments.linesOf([moved], tx)).get(moved.id) ?? [];
      return toReturnShipmentView(moved, lines);
    });
  }

  // -- resolve ------------------------------------------------------------------------------

  /**
   * INSPECTED → RESOLVED: every received unit is given an outcome, from the dispositions the
   * deployment allows (Q-133). Per line the quantities add up to exactly what was received. Only
   * a record: no stock moves and no money (ADR-048 § 2, § 4; Q-76).
   */
  async resolve(
    id: string,
    dto: ResolveReturnShipmentDto,
    command: Command<ReturnShipmentView>,
  ): Promise<ReturnShipmentView> {
    const acting = this.access.assertOperator();
    const correlationId = getContext().correlationId;

    return this.runner.run('resolve_return_shipment', command.fence, null, async (tx, at) => {
      const locked = await this.shipments.lock(tx, acting.organizationId, id);
      if (!locked) throw await this.notMovable(tx, acting.organizationId, id);
      if (!canMove(locked.status, 'RESOLVED')) {
        throw refusal(
          'returnShipment',
          'RETURN_SHIPMENT_NOT_INSPECTED',
          'A return shipment is resolved once, after it was inspected',
          { returnShipmentId: id, status: locked.status },
        );
      }
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== locked.version) {
        throw RastaError.optimisticLockFailed('ReturnShipment', id);
      }

      // Policy first: no disposition is allowed unless the deployment named it (Q-133).
      const allowed = new Set<string>(this.env.INVENTORY_RETURN_DISPOSITIONS_ALLOWED);
      const refused = [...new Set(dto.dispositions.map((row) => row.disposition))].filter(
        (disposition) => !allowed.has(disposition),
      );
      if (refused.length > 0) {
        throw refusal(
          'returnShipment',
          'DISPOSITION_NOT_ALLOWED',
          allowed.size === 0
            ? 'No disposition is allowed: INVENTORY_RETURN_DISPOSITIONS_ALLOWED is not configured'
            : 'A disposition named is not allowed by this deployment',
          { returnShipmentId: id, refused },
        );
      }

      // Arithmetic second: per line, exactly what was received goes somewhere.
      const lines = (await this.shipments.linesOf([locked], tx)).get(locked.id) ?? [];
      const known = new Set(lines.map((line) => line.orderLineId));
      const sent = new Map<string, number>();
      for (const row of dto.dispositions) {
        sent.set(row.orderLineId, (sent.get(row.orderLineId) ?? 0) + row.quantity);
      }
      const balanced =
        [...sent.keys()].every((orderLineId) => known.has(orderLineId)) &&
        lines.every((line) => (sent.get(line.orderLineId) ?? 0) === (line.receivedQuantity ?? 0));
      if (!balanced) {
        throw refusal(
          'returnShipment',
          'DISPOSITIONS_DO_NOT_BALANCE',
          'For every line, the dispositions add up to exactly what was received',
          { returnShipmentId: id },
        );
      }

      const when = new Date(Math.max(at.getTime(), locked.updatedAt.getTime()));
      const moved = await this.shipments.markResolved(tx, locked, acting.userId, when);
      if (!moved) throw RastaError.optimisticLockFailed('ReturnShipment', id);

      const written: ReturnDispositionRow[] = [];
      for (const row of dto.dispositions) {
        written.push(
          await this.shipments.insertDisposition(tx, {
            id: newId(ID_PREFIX.returnDisposition),
            organizationId: moved.organizationId,
            returnShipmentId: moved.id,
            orderLineId: row.orderLineId,
            disposition: row.disposition,
            quantity: row.quantity,
            at: when,
          }),
        );
      }
      const tracked = await this.shipments.insertTrackingEvent(tx, {
        id: newId(ID_PREFIX.returnTrackingEvent),
        organizationId: moved.organizationId,
        returnShipmentId: moved.id,
        type: 'RESOLVED',
        shipmentVersion: moved.version,
        commandKeyHash: command.keyHash,
        actor: acting.userId,
        correlationId,
        at: when,
      });
      await this.publisher.enqueue(tx, {
        eventName: 'RETURN_SHIPMENT_RESOLVED',
        aggregateId: moved.id,
        organizationId: moved.organizationId,
        occurredAt: when,
        payload: {
          ...returnShipmentFacts(moved, tracked.id),
          returnShipmentVersion: RETURN_SHIPMENT_VERSION_OF.RESOLVED,
          dispositions: written.map((row) => ({
            orderLineId: row.orderLineId,
            disposition: row.disposition,
            quantity: row.quantity,
          })),
          resolvedBy: acting.userId,
          resolvedAt: when.toISOString(),
        },
      });
      return toReturnShipmentView(moved, lines, written);
    });
  }

  /**
   * Why a return shipment the acting organization does not own cannot be moved: its sender — one
   * whose roles let it read the shipment — is told it may not (`403`); anybody else learns
   * nothing (`404`).
   */
  private async notMovable(
    tx: ExtendedPrismaClient,
    organizationId: string,
    id: string,
  ): Promise<RastaError> {
    if (this.access.readsAsConsignee()) {
      const asSender = await this.shipments.findVisible(
        { organizationId, asDestination: false, asSender: true },
        id,
        tx,
      );
      if (asSender) {
        return RastaError.forbidden(
          'A return shipment is moved by the owner of its destination warehouse; its sender reads it',
        );
      }
    }
    return RastaError.notFound('ReturnShipment', id);
  }

  // -- reads --------------------------------------------------------------------------------

  async get(id: string): Promise<ReturnShipmentView> {
    const row = await this.visible(id);
    const lines = await this.shipments.linesOf([row]);
    const dispositions = await this.shipments.dispositionsOf([row]);
    return toReturnShipmentView(row, lines.get(row.id) ?? [], dispositions.get(row.id) ?? []);
  }

  /** The status and the tracking history, in lifecycle order, read together in one statement. */
  async tracking(id: string): Promise<ReturnTrackingView> {
    const reader = this.access.assertReturnShipmentReader();
    const tracked = await this.shipments.findTracked(reader, id);
    if (!tracked) throw RastaError.notFound('ReturnShipment', id);
    return toReturnTrackingView(tracked.shipment, tracked.events);
  }

  async list(query: ListReturnShipmentsQuery): Promise<CursorPage<ReturnShipmentView>> {
    const reader = this.access.assertReturnShipmentReader();
    const rows = await this.shipments.listVisible(reader, {
      ...(query.side === undefined ? {} : { side: query.side }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.returnRequestId === undefined ? {} : { returnRequestId: query.returnRequestId }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit: query.limit,
    });
    const page = rows.slice(0, query.limit);
    const lines = await this.shipments.linesOf(page);
    const dispositions = await this.shipments.dispositionsOf(page);
    return pageOf(rows, query.limit, (row) =>
      toReturnShipmentView(row, lines.get(row.id) ?? [], dispositions.get(row.id) ?? []),
    );
  }

  /** Whether the caller may still see this return shipment (the replay of a command). */
  async assertVisible(id: string): Promise<void> {
    await this.visible(id);
  }

  private async visible(id: string): Promise<ReturnShipmentRow> {
    const reader = this.access.assertReturnShipmentReader();
    const row = await this.shipments.findVisible(reader, id);
    if (!row) throw RastaError.notFound('ReturnShipment', id);
    return row;
  }
}

/** What every return-shipment event says about the shipment (`@rasta/contracts`, inventory-returns). */
function returnShipmentFacts(row: ReturnShipmentRow, trackingEventId: string) {
  return {
    returnShipmentId: row.id,
    organizationId: row.organizationId,
    returnRequestId: row.returnRequestId,
    orderId: row.orderId,
    buyerOrganizationId: row.buyerOrganizationId,
    destinationWarehouseId: row.destinationWarehouseId,
    trackingEventId,
  };
}
