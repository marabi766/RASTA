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
import { dispatchReservationIdSchema } from './dto';
import { assertShipmentMatchesRequest } from './return-request-check';
import {
  MARKETPLACE_SERVICE,
  RETURN_REQUEST_SOURCE,
  type ReturnRequestSource,
} from './return-request-source';
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
 * It records what happened to goods — nothing else. Whether the return was *allowed* is
 * marketplace's, which owns the request: before a shipment is recorded, the request is read there
 * and the shipment checked against it — this organization its supplier, its buyer, its order, its
 * lines and quantities, AUTHORIZED — and its dispatch reserved there, which ends the buyer's right
 * to cancel it (A-13, Q-133 (5); Codex r1 on #336). Marketplace still verifies every event
 * published here against the request before mirroring it. It moves no stock — returned goods are not
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
 * `CommandRunner`, as every stock and shipment command — the dispatch's two exchanges with
 * marketplace run before it, never inside: the return shipment (created, or locked and
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
    @Inject(RETURN_REQUEST_SOURCE) private readonly requests: ReturnRequestSource,
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

    // What this service can refuse on its own is refused first, before marketplace is asked: a
    // reservation taken for a dispatch that then fails here would leave the buyer unable to cancel
    // a return whose goods never left (Q-133 (5)).
    await this.assertDispatchable(undefined, acting.organizationId, dto);

    // Then the owner of the return request (A-13): read it and check the shipment against it, then
    // reserve its dispatch there — under the lock a cancellation takes, so the buyer cannot cancel
    // once the goods may be on the road, whether or not marketplace has heard of this shipment
    // yet. Both exchanges run before the transaction, never inside it, and an owner that cannot be
    // asked refuses the dispatch (503/504) with nothing written.
    const request = await this.requests.read(acting.organizationId, dto.returnRequestId);
    if (!request) throw RastaError.notFound('ReturnRequest', dto.returnRequestId);
    assertShipmentMatchesRequest(dto, acting.organizationId, request);
    const reserved = await this.requests.reserve(acting.organizationId, dto.returnRequestId);
    if (!reserved) throw RastaError.notFound('ReturnRequest', dto.returnRequestId);
    // Cancelled (or otherwise moved on) between the read and the reservation.
    if (reserved === 'NOT_DISPATCHABLE') {
      throw refusal(
        'returnShipment',
        'RETURN_REQUEST_NOT_AUTHORIZED',
        'Only an AUTHORIZED return request’s goods are dispatched',
        { returnRequestId: dto.returnRequestId },
      );
    }
    assertShipmentMatchesRequest(dto, acting.organizationId, reserved);
    // A reservation answer that names no reservation reserved nothing this service can record a
    // shipment under: no answer (fail closed).
    const reservationId = reserved.dispatchReservationId;
    if (reservationId === null || !dispatchReservationIdSchema.safeParse(reservationId).success) {
      throw RastaError.upstreamUnavailable(MARKETPLACE_SERVICE);
    }

    return this.runner.run('create_return_shipment', command.fence, null, async (tx, at) => {
      // Under the lock a withdrawal takes (Q-133 (9)(a)): a reservation marketplace's
      // reconciliation withdrew here — after this command reserved it, however long this
      // transaction was delayed — records nothing. The trigger refuses it as well.
      await this.shipments.lockDispatch(tx, acting.organizationId, dto.returnRequestId);
      if (await this.shipments.findWithdrawal(tx, acting.organizationId, reservationId)) {
        throw refusal(
          'returnShipment',
          'RETURN_DISPATCH_WITHDRAWN',
          'The dispatch reservation of this return was withdrawn by a reconciliation',
          { returnRequestId: dto.returnRequestId },
        );
      }
      const warehouse = await this.assertDispatchable(tx, acting.organizationId, dto);

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
        dispatchReservationId: reservationId,
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

  /**
   * The destination warehouse, and that the request has no shipment yet: checked ahead of asking
   * marketplace (no `tx`) and again in the command's transaction, where it counts.
   */
  private async assertDispatchable(
    tx: ExtendedPrismaClient | undefined,
    organizationId: string,
    dto: CreateReturnShipmentDto,
  ) {
    // Another organization's warehouse, or none: 404 — a return arrives in its owner's
    // warehouse and no other (the composite foreign key says the same).
    const warehouse = await this.warehouses.find(organizationId, dto.destinationWarehouseId, tx);
    if (!warehouse) throw RastaError.notFound('Warehouse', dto.destinationWarehouseId);

    // One consignment per return (Q-133): a second dispatch under another key is refused, with
    // the unique index behind this read for two that race.
    const existing = await this.shipments.findByRequest(tx, organizationId, dto.returnRequestId);
    if (existing) {
      throw refusal(
        'returnShipment',
        'RETURN_ALREADY_DISPATCHED',
        'This return request already has a return shipment',
        { returnShipmentId: existing.id },
      );
    }
    return warehouse;
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

      // Policy first: no disposition is allowed unless the deployment named it (Q-133) — and with
      // none named, nothing is resolved at all, an empty set of dispositions included.
      const allowed = new Set<string>(this.env.INVENTORY_RETURN_DISPOSITIONS_ALLOWED);
      const refused = [...new Set(dto.dispositions.map((row) => row.disposition))].filter(
        (disposition) => !allowed.has(disposition),
      );
      if (allowed.size === 0 || refused.length > 0) {
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

      // Nothing arrived: what that resolves to is not decided (Q-133 (4)), so it is resolved —
      // with no disposition — only where the deployment says so, and otherwise refused by name.
      const nothingReceived = lines.every((line) => (line.receivedQuantity ?? 0) === 0);
      if (nothingReceived && !this.env.INVENTORY_RETURN_RESOLVE_NOTHING_RECEIVED) {
        throw refusal(
          'returnShipment',
          'NOTHING_RECEIVED_TO_RESOLVE',
          'Nothing of this return arrived, and this deployment does not resolve such a return ' +
            '(INVENTORY_RETURN_RESOLVE_NOTHING_RECEIVED, Q-133)',
          { returnShipmentId: id },
        );
      }

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

  /**
   * The shipment, its lines and its dispositions, read in one snapshot: a view the database held at
   * one instant.
   */
  async get(id: string): Promise<ReturnShipmentView> {
    const reader = this.access.assertReturnShipmentReader();
    return this.shipments.inSnapshot(async (tx) => {
      const row = await this.shipments.findVisible(reader, id, tx);
      if (!row) throw RastaError.notFound('ReturnShipment', id);
      const lines = await this.shipments.linesOf([row], tx);
      const dispositions = await this.shipments.dispositionsOf([row], tx);
      return toReturnShipmentView(row, lines.get(row.id) ?? [], dispositions.get(row.id) ?? []);
    });
  }

  /** The status and the tracking history, in lifecycle order, read together in one statement. */
  async tracking(id: string): Promise<ReturnTrackingView> {
    const reader = this.access.assertReturnShipmentReader();
    const tracked = await this.shipments.findTracked(reader, id);
    if (!tracked) throw RastaError.notFound('ReturnShipment', id);
    return toReturnTrackingView(tracked.shipment, tracked.events);
  }

  /** A page of shipments with their lines and dispositions, read in one snapshot, as {@link get}. */
  async list(query: ListReturnShipmentsQuery): Promise<CursorPage<ReturnShipmentView>> {
    const reader = this.access.assertReturnShipmentReader();
    return this.shipments.inSnapshot(async (tx) => {
      const rows = await this.shipments.listVisible(
        reader,
        {
          ...(query.side === undefined ? {} : { side: query.side }),
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.returnRequestId === undefined
            ? {}
            : { returnRequestId: query.returnRequestId }),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          limit: query.limit,
        },
        tx,
      );
      const page = rows.slice(0, query.limit);
      const lines = await this.shipments.linesOf(page, tx);
      const dispositions = await this.shipments.dispositionsOf(page, tx);
      return pageOf(rows, query.limit, (row) =>
        toReturnShipmentView(row, lines.get(row.id) ?? [], dispositions.get(row.id) ?? []),
      );
    });
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
