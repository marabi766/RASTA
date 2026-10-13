import { Injectable } from '@nestjs/common';
import { RastaError, getContext } from '@rasta/nest-common';
import { InventoryAccess } from '../access/access';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { ReservationExpiry } from '../reservation/expiry';
import type { Command } from '../shared/command';
import { stockOverdrawn } from '../shared/command';
import { CommandRunner } from '../shared/command-runner';
import { MAX_QUANTITY, pageOf, type CursorPage } from '../shared/dto';
import { refusal } from '../shared/refusal';
import { WarehouseRepository } from '../warehouse/warehouse.repository';
import type {
  AdjustStockDto,
  ListMovementsQuery,
  ListStockQuery,
  ReceiveStockDto,
  StockChangeView,
  StockItemView,
  StockMovementView,
} from './dto';
import { stockFacts } from './facts';
import { StockRepository } from './stock.repository';
import { toStockItemView, toStockMovementView } from './views';

/**
 * Stock balances and the two commands that change on hand without a reservation (ADR-056 § 3):
 * `ReceiveStock` and `AdjustStock` — the latter also ADR-056's "direct issue without a
 * reservation". Each is one transaction under the stock item's row lock (`CommandRunner`); the
 * reads are the owner's, tenant-guarded.
 */
@Injectable()
export class StockService {
  constructor(
    private readonly stock: StockRepository,
    private readonly warehouses: WarehouseRepository,
    private readonly expiry: ReservationExpiry,
    private readonly access: InventoryAccess,
    private readonly publisher: EventPublisher,
    private readonly runner: CommandRunner,
  ) {}

  // -- commands -----------------------------------------------------------------------------

  /** Stock arrived: on hand grows. The stock item is created on its product's first receipt. */
  async receive(dto: ReceiveStockDto, command: Command<StockChangeView>): Promise<StockChangeView> {
    const acting = this.access.assertOperator();
    // Another owner's warehouse — or none — is 404 before anything is claimed or written.
    if (!(await this.warehouses.find(acting.organizationId, dto.warehouseId))) {
      throw RastaError.notFound('Warehouse', dto.warehouseId);
    }
    const correlationId = getContext().correlationId;

    return this.runner.run('receive', command.fence, stockOverdrawn, async (tx, at) => {
      const itemId = await this.stock.ensureItem(tx, {
        id: newId(ID_PREFIX.stockItem),
        organizationId: acting.organizationId,
        warehouseId: dto.warehouseId,
        productId: dto.productId,
        actor: acting.userId,
        at,
      });
      const locked = await this.stock.lock(tx, acting.organizationId, itemId);
      if (!locked) throw RastaError.notFound('StockItem', itemId);
      const item = await this.expiry.expireDue(tx, locked, at, correlationId, 'command');

      if (item.onHandQuantity + dto.quantity > MAX_QUANTITY) {
        throw refusal(
          'stock',
          'QUANTITY_OUT_OF_RANGE',
          'On hand would pass the largest quantity stored',
          {
            stockItemId: item.id,
          },
        );
      }
      const moved = await this.stock.move(
        tx,
        item,
        { onHand: dto.quantity, reserved: 0 },
        acting.userId,
        at,
      );
      const movement = await this.stock.insertMovement(tx, {
        id: newId(ID_PREFIX.movement),
        item: moved,
        type: 'RECEIPT',
        onHandDelta: dto.quantity,
        reservedDelta: 0,
        reservationId: null,
        sourceReference: dto.sourceReference ?? null,
        commandKeyHash: command.keyHash,
        correlationId,
        actor: acting.userId,
        at,
      });
      await this.publisher.enqueue(tx, {
        eventName: 'STOCK_RECEIVED',
        aggregateId: moved.id,
        organizationId: moved.organizationId,
        occurredAt: at,
        payload: {
          ...stockFacts(moved, movement.id),
          quantity: dto.quantity,
          sourceReference: dto.sourceReference ?? null,
          receivedBy: acting.userId,
          receivedAt: at.toISOString(),
        },
      });
      return { stockItem: toStockItemView(moved), movement: toStockMovementView(movement) };
    });
  }

  /**
   * On hand corrected by a signed delta. Never below what is reserved — a reservation is a
   * promise the stock must still keep — and never past the largest quantity stored. No reason
   * code and no second approval: none is decided (Q-109); the operator, the movement and its
   * event are the record.
   */
  async adjust(dto: AdjustStockDto, command: Command<StockChangeView>): Promise<StockChangeView> {
    const acting = this.access.assertOperator();
    const correlationId = getContext().correlationId;

    return this.runner.run('adjust', command.fence, stockOverdrawn, async (tx, at) => {
      const locked = await this.stock.lock(tx, acting.organizationId, dto.stockItemId);
      if (!locked) throw RastaError.notFound('StockItem', dto.stockItemId);
      const item = await this.expiry.expireDue(tx, locked, at, correlationId, 'command');

      const onHandAfter = item.onHandQuantity + dto.quantityDelta;
      if (onHandAfter < item.reservedQuantity) {
        throw refusal(
          'stock',
          'ON_HAND_WOULD_BE_NEGATIVE',
          'On hand would fall below what is reserved',
          {
            stockItemId: item.id,
          },
        );
      }
      if (onHandAfter > MAX_QUANTITY) {
        throw refusal(
          'stock',
          'QUANTITY_OUT_OF_RANGE',
          'On hand would pass the largest quantity stored',
          {
            stockItemId: item.id,
          },
        );
      }
      const moved = await this.stock.move(
        tx,
        item,
        { onHand: dto.quantityDelta, reserved: 0 },
        acting.userId,
        at,
      );
      const movement = await this.stock.insertMovement(tx, {
        id: newId(ID_PREFIX.movement),
        item: moved,
        type: 'ADJUSTMENT',
        onHandDelta: dto.quantityDelta,
        reservedDelta: 0,
        reservationId: null,
        sourceReference: dto.sourceReference ?? null,
        commandKeyHash: command.keyHash,
        correlationId,
        actor: acting.userId,
        at,
      });
      await this.publisher.enqueue(tx, {
        eventName: 'STOCK_ADJUSTED',
        aggregateId: moved.id,
        organizationId: moved.organizationId,
        occurredAt: at,
        payload: {
          ...stockFacts(moved, movement.id),
          quantityDelta: dto.quantityDelta,
          sourceReference: dto.sourceReference ?? null,
          adjustedBy: acting.userId,
          adjustedAt: at.toISOString(),
        },
      });
      return { stockItem: toStockItemView(moved), movement: toStockMovementView(movement) };
    });
  }

  // -- reads --------------------------------------------------------------------------------

  async get(id: string): Promise<StockItemView> {
    const { organizationId } = this.access.assertReader();
    const row = await this.stock.findItem(organizationId, id);
    if (!row) throw RastaError.notFound('StockItem', id);
    return toStockItemView(row);
  }

  async list(query: ListStockQuery): Promise<CursorPage<StockItemView>> {
    const { organizationId } = this.access.assertReader();
    const rows = await this.stock.listItems(organizationId, {
      ...(query.warehouseId === undefined ? {} : { warehouseId: query.warehouseId }),
      ...(query.productId === undefined ? {} : { productId: query.productId }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit: query.limit,
    });
    return pageOf(rows, query.limit, toStockItemView);
  }

  /** The ledger, newest first: of one item, of one warehouse, or of the owner's every item. */
  async movements(query: ListMovementsQuery): Promise<CursorPage<StockMovementView>> {
    const { organizationId } = this.access.assertReader();
    const rows = await this.stock.listMovements(organizationId, {
      ...(query.stockItemId === undefined ? {} : { stockItemId: query.stockItemId }),
      ...(query.warehouseId === undefined ? {} : { warehouseId: query.warehouseId }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit: query.limit,
    });
    return pageOf(rows, query.limit, toStockMovementView);
  }

  /** Whether the caller may still see this stock item (the replay of a command). */
  async assertVisible(id: string): Promise<void> {
    await this.get(id);
  }
}
