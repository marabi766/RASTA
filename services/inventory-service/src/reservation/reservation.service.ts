import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import { InventoryAccess, type Acting } from '../access/access';
import type { InventoryEnv } from '../config/env';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { reservationOverdrawn, stockOverdrawn, type Command } from '../shared/command';
import { CommandRunner } from '../shared/command-runner';
import { pageOf, type CursorPage } from '../shared/dto';
import { refusal } from '../shared/refusal';
import { reservationFacts, stockFacts } from '../stock/facts';
import { StockRepository, ascending, type StockItemRow } from '../stock/stock.repository';
import { ENV } from '../tokens';
import type {
  EndReservationDto,
  ListReservationsQuery,
  ReservationBatchView,
  ReservationView,
  ReserveStockDto,
} from './dto';
import { ExpiryBacklog, ReservationExpiry, type ExpiryBatch } from './expiry';
import { ReservationRepository, type ReservationRow } from './reservation.repository';
import { canMove, isDue } from './reservation.state-machine';
import { toReservationView } from './views';

/**
 * Reservations (ADR-056 § 3): `ReserveStock`, `ReleaseReservation` and `IssueStock`.
 *
 * Each is one transaction (`CommandRunner`) that locks the stock items it touches **in ascending
 * id order** before it writes anything, expires their due reservations, decides under those locks,
 * and writes the balance, the movement, the reservation and the event together. The capacity
 * check here answers a clean `422`; the database's `CHECK (reserved_quantity <= on_hand_quantity)`
 * refuses an oversell even if it did not.
 *
 * A reservation is found first by its owner (another owner's is `404`, ADR-056 § 5 negatives 2
 * and 4 — in PR 1 the holder is the owner, Q-104), then its stock item is locked, then the
 * reservation itself: item before reservation on every path, so no two commands wait in a cycle.
 */
@Injectable()
export class ReservationService {
  constructor(
    private readonly reservations: ReservationRepository,
    private readonly stock: StockRepository,
    private readonly expiry: ReservationExpiry,
    private readonly access: InventoryAccess,
    private readonly publisher: EventPublisher,
    private readonly runner: CommandRunner,
    @Inject(ENV) private readonly env: InventoryEnv,
  ) {}

  // -- reserve ------------------------------------------------------------------------------

  /** Reserves every line, or none. One reservation per line, returned in the lines' order. */
  async reserve(
    dto: ReserveStockDto,
    command: Command<ReservationBatchView>,
  ): Promise<ReservationBatchView> {
    const acting = this.access.assertOperator();
    const correlationId = getContext().correlationId;

    return this.runner.run('reserve', command.fence, reservationOverdrawn, async (tx, at) => {
      const holder = dto.holderOrganizationId ?? acting.organizationId;
      if (holder !== acting.organizationId) {
        throw refusal(
          'reservation',
          'HOLDER_NOT_OWNER',
          'A reservation is held for the warehouse owner in this version',
        );
      }
      const expiresAt = this.expiryOf(dto.expiresAt, at);

      const wanted = ascending(dto.lines.map((line) => line.stockItemId));
      const locked = await this.stock.lockInOrder(tx, acting.organizationId, wanted);
      if (locked.length !== wanted.length) {
        const missing = wanted.find((id) => !locked.some((item) => item.id === id));
        throw RastaError.notFound('StockItem', missing);
      }
      if (new Set(locked.map((item) => item.warehouseId)).size > 1) {
        throw refusal(
          'reservation',
          'LINES_SPAN_WAREHOUSES',
          'A reservation holds stock of one warehouse',
        );
      }

      const quantityOf = new Map(dto.lines.map((line) => [line.stockItemId, line.quantity]));
      const asked = (item: StockItemRow): number => quantityOf.get(item.id) as number;
      // A line beyond on hand never fits, whatever expires: expiry gives back reserved, never
      // on hand. Final, before any expiry runs.
      const beyond = locked.find((item) => asked(item) > item.onHandQuantity);
      if (beyond) throw insufficientStock(beyond.id);

      const batches: ExpiryBatch[] = [];
      for (const item of locked) {
        batches.push(await this.expiry.expireDue(tx, item, at, correlationId, 'command'));
      }
      const items: StockItemRow[] = batches.map((batch) => batch.item);
      const short = batches.filter(({ item }) => asked(item) > item.availableQuantity);
      // Short even with every due reservation past the batch expired: live reservations hold
      // what is missing, and the refusal is final (`ReservationExpiry`).
      const sure = short.find(
        ({ item, backlogQuantity }) => asked(item) > item.availableQuantity + backlogQuantity,
      );
      if (sure) throw insufficientStock(sure.item.id);
      // Short only while the backlog still holds stock: expired, it makes room — not sure yet.
      if (short.length > 0) {
        throw new ExpiryBacklog(
          acting.organizationId,
          short.map(({ item }) => item.id),
        );
      }

      const made = new Map<string, ReservationView>();
      for (const item of items) {
        const reservation = await this.reserveLine(tx, {
          acting,
          item,
          quantity: asked(item),
          holder,
          orderReference: dto.orderReference ?? null,
          expiresAt,
          keyHash: command.keyHash,
          correlationId,
          at,
        });
        made.set(item.id, toReservationView(reservation));
      }
      return {
        reservations: dto.lines.map((line) => made.get(line.stockItemId) as ReservationView),
      };
    });
  }

  private async reserveLine(
    tx: ExtendedPrismaClient,
    input: {
      acting: Acting;
      item: StockItemRow;
      quantity: number;
      holder: string;
      orderReference: string | null;
      expiresAt: Date | null;
      keyHash: string;
      correlationId: string;
      at: Date;
    },
  ): Promise<ReservationRow> {
    const { acting, at } = input;
    const moved = await this.stock.move(
      tx,
      input.item,
      { onHand: 0, reserved: input.quantity },
      acting.userId,
      at,
    );
    const reservation = await this.reservations.insert(tx, {
      id: newId(ID_PREFIX.reservation),
      organizationId: moved.organizationId,
      warehouseId: moved.warehouseId,
      stockItemId: moved.id,
      holderOrganizationId: input.holder,
      orderReference: input.orderReference,
      quantity: input.quantity,
      expiresAt: input.expiresAt,
      commandKeyHash: input.keyHash,
      actor: acting.userId,
      correlationId: input.correlationId,
      at,
    });
    const movement = await this.stock.insertMovement(tx, {
      id: newId(ID_PREFIX.movement),
      item: moved,
      type: 'RESERVE',
      onHandDelta: 0,
      reservedDelta: input.quantity,
      reservationId: reservation.id,
      sourceReference: input.orderReference,
      commandKeyHash: input.keyHash,
      correlationId: input.correlationId,
      actor: acting.userId,
      at,
    });
    await this.publisher.enqueue(tx, {
      eventName: 'STOCK_RESERVED',
      aggregateId: moved.id,
      organizationId: moved.organizationId,
      occurredAt: at,
      payload: {
        ...stockFacts(moved, movement.id),
        ...reservationFacts(reservation),
        expiresAt: reservation.expiresAt?.toISOString() ?? null,
        reservedBy: acting.userId,
        reservedAt: at.toISOString(),
      },
    });
    return reservation;
  }

  /**
   * `expiresAt`, if given, lies after the transaction's instant and at most
   * INVENTORY_RESERVATION_MAX_TTL_SECONDS after it — the database's clock, the one expiry is
   * judged by.
   */
  private expiryOf(expiresAt: string | undefined, at: Date): Date | null {
    if (expiresAt === undefined) return null;
    const instant = new Date(expiresAt);
    const latest = at.getTime() + this.env.INVENTORY_RESERVATION_MAX_TTL_SECONDS * 1000;
    if (instant.getTime() <= at.getTime() || instant.getTime() > latest) {
      throw refusal(
        'reservation',
        'EXPIRY_OUT_OF_RANGE',
        'expiresAt must be in the future and within the longest reservation allowed',
      );
    }
    return instant;
  }

  // -- release and issue --------------------------------------------------------------------

  /** Ends an ACTIVE reservation without the stock leaving: reserved falls, on hand does not. */
  async release(
    id: string,
    dto: EndReservationDto,
    command: Command<ReservationView>,
  ): Promise<ReservationView> {
    return this.end('release', id, dto, command);
  }

  /** Consumes a whole ACTIVE reservation: the stock leaves, on hand and reserved both fall (Q-107). */
  async issue(
    id: string,
    dto: EndReservationDto,
    command: Command<ReservationView>,
  ): Promise<ReservationView> {
    return this.end('issue', id, dto, command);
  }

  private async end(
    kind: 'release' | 'issue',
    id: string,
    dto: EndReservationDto,
    command: Command<ReservationView>,
  ): Promise<ReservationView> {
    const acting = this.access.assertOperator();
    const found = await this.reservations.find(acting.organizationId, id);
    if (!found) throw RastaError.notFound('StockReservation', id);
    const correlationId = getContext().correlationId;
    const status = kind === 'release' ? 'RELEASED' : 'CONSUMED';

    return this.runner.run(kind, command.fence, stockOverdrawn, async (tx, at) => {
      const locked = await this.stock.lock(tx, acting.organizationId, found.stockItemId);
      if (!locked) throw RastaError.notFound('StockReservation', id);
      // An expiry that is due is honoured first: a reservation past its time is EXPIRED, and
      // releasing or issuing it is then refused like any other ended one. A backlog left past
      // the batch only lowers reserved, which neither a release nor an issue depends on.
      const { item } = await this.expiry.expireDue(tx, locked, at, correlationId, 'command');
      const reservation = await this.reservations.lock(tx, acting.organizationId, id);
      if (!reservation) throw RastaError.notFound('StockReservation', id);
      // This one may be due and still past the batch: it is expired all the same.
      const current = isDue(reservation, at) ? 'EXPIRED' : reservation.status;
      if (!canMove(current, status)) {
        throw refusal(
          'reservation',
          'RESERVATION_NOT_ACTIVE',
          'The reservation has already been issued, released or expired',
          { reservationId: id, status: current },
        );
      }
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== reservation.version) {
        throw RastaError.optimisticLockFailed('StockReservation', id);
      }
      const ended = await this.reservations.end(tx, reservation, status, acting.userId, at);
      if (!ended) throw RastaError.optimisticLockFailed('StockReservation', id);

      const deltas =
        kind === 'release'
          ? { onHand: 0, reserved: -ended.quantity }
          : { onHand: -ended.quantity, reserved: -ended.quantity };
      const moved = await this.stock.move(tx, item, deltas, acting.userId, at);
      const movement = await this.stock.insertMovement(tx, {
        id: newId(ID_PREFIX.movement),
        item: moved,
        type: kind === 'release' ? 'RELEASE' : 'ISSUE',
        onHandDelta: deltas.onHand,
        reservedDelta: deltas.reserved,
        reservationId: ended.id,
        sourceReference: ended.orderReference,
        commandKeyHash: command.keyHash,
        correlationId,
        actor: acting.userId,
        at,
      });
      const facts = { ...stockFacts(moved, movement.id), ...reservationFacts(ended) };
      if (kind === 'release') {
        await this.publisher.enqueue(tx, {
          eventName: 'STOCK_RELEASED',
          aggregateId: moved.id,
          organizationId: moved.organizationId,
          occurredAt: at,
          payload: {
            ...facts,
            reason: 'RELEASED',
            releasedBy: acting.userId,
            releasedAt: at.toISOString(),
          },
        });
      } else {
        await this.publisher.enqueue(tx, {
          eventName: 'STOCK_ISSUED',
          aggregateId: moved.id,
          organizationId: moved.organizationId,
          occurredAt: at,
          payload: { ...facts, issuedBy: acting.userId, issuedAt: at.toISOString() },
        });
      }
      return toReservationView(ended);
    });
  }

  // -- reads --------------------------------------------------------------------------------

  async get(id: string): Promise<ReservationView> {
    const { organizationId } = this.access.assertReader();
    const row = await this.reservations.find(organizationId, id);
    if (!row) throw RastaError.notFound('StockReservation', id);
    return toReservationView(row);
  }

  async list(query: ListReservationsQuery): Promise<CursorPage<ReservationView>> {
    const { organizationId } = this.access.assertReader();
    const rows = await this.reservations.list(organizationId, {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.stockItemId === undefined ? {} : { stockItemId: query.stockItemId }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit: query.limit,
    });
    return pageOf(rows, query.limit, toReservationView);
  }

  /** Whether the caller may still see this reservation (the replay of a command). */
  async assertVisible(id: string): Promise<void> {
    await this.get(id);
  }
}

/** The final refusal of a line the stock item cannot hold. */
function insufficientStock(stockItemId: string): RastaError {
  return refusal(
    'reservation',
    'INSUFFICIENT_AVAILABLE_STOCK',
    'Not enough stock is available to reserve',
    { stockItemId },
  );
}
