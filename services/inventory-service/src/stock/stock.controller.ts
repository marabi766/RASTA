import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import { commandKeyHash } from '../shared/command';
import type { CursorPage } from '../shared/dto';
import { IdempotencyStore, requiredIdempotencyKey } from '../shared/idempotency';
import { COMMAND_NOTE, READ_NOTE, STOCK_COMMAND_NOTE } from '../shared/notes';
import {
  adjustStockSchema,
  listMovementsQuerySchema,
  listStockQuerySchema,
  receiveStockSchema,
  type AdjustStockDto,
  type ListMovementsQuery,
  type ListStockQuery,
  type ReceiveStockDto,
  type StockChangeView,
  type StockItemView,
  type StockMovementView,
} from './dto';
import { StockService } from './stock.service';

/** The route templates the idempotency store keys on: a closed set, never an id. */
export const RECEIVE_STOCK_ENDPOINT = 'POST /v1/stock/receipts';
export const ADJUST_STOCK_ENDPOINT = 'POST /v1/stock/adjustments';

/**
 * Stock balances and the ledger. HTTP ↔ DTO and nothing else (AGENTS.md A-10); no handler names
 * a role. `movements` is declared before `:id` so the router never reads it as an id; the
 * reservations live in `ReservationController`, registered before this one for the same reason.
 */
@ApiTags('stock')
@Controller({ path: 'stock', version: '1' })
export class StockController {
  constructor(
    private readonly stock: StockService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List stock items and their balances, newest first',
    description:
      'Optionally of one warehouse (`warehouseId`) or one product (`productId`). Each item shows ' +
      'on hand, reserved and available (on hand − reserved, never negative). ' +
      READ_NOTE,
  })
  async list(
    @Query(zodPipe(listStockQuerySchema)) query: ListStockQuery,
  ): Promise<CursorPage<StockItemView>> {
    return this.stock.list(query);
  }

  @Get('movements')
  @ApiOperation({
    summary: 'List stock movements — the append-only ledger — newest first',
    description:
      'Of one stock item (`stockItemId`), one warehouse (`warehouseId`) or all of the owner’s. ' +
      'Each movement states its deltas, the balance it left and the item’s ledger position ' +
      '(`itemVersion`, 1, 2, 3, … per item); the balance is always the sum of its movements. ' +
      READ_NOTE,
  })
  async movements(
    @Query(zodPipe(listMovementsQuerySchema)) query: ListMovementsQuery,
  ): Promise<CursorPage<StockMovementView>> {
    return this.stock.movements(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one stock item and its balance', description: READ_NOTE })
  async get(@Param('id') id: string): Promise<StockItemView> {
    return this.stock.get(id);
  }

  @RequirePlatformUserId()
  @Post('receipts')
  @HttpCode(201)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 255 characters. Scoped to the organization.',
  })
  @ApiOperation({
    summary: 'Receive stock into a warehouse (on hand grows)',
    description:
      'Adds `quantity` to on hand of the product in the warehouse, creating the stock item on ' +
      'its first receipt, and records a RECEIPT movement and STOCK_RECEIVED. A warehouse of ' +
      'another organization is 404. A balance past the largest quantity stored is 422 ' +
      '`QUANTITY_OUT_OF_RANGE`. ' +
      STOCK_COMMAND_NOTE +
      ' ' +
      COMMAND_NOTE,
  })
  async receive(
    @Body(zodPipe(receiveStockSchema)) dto: ReceiveStockDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<StockChangeView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const keyHash = commandKeyHash(RECEIVE_STOCK_ENDPOINT, key);
    const { result } = await this.idempotency.execute<StockChangeView>(
      RECEIVE_STOCK_ENDPOINT,
      key,
      dto,
      201,
      (fence) => this.stock.receive(dto, { fence, keyHash }),
      (stored) => this.stock.assertVisible(stored.stockItem.id),
    );
    return result;
  }

  @RequirePlatformUserId()
  @Post('adjustments')
  @HttpCode(201)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 255 characters. Scoped to the organization.',
  })
  @ApiOperation({
    summary: 'Adjust on hand by a signed quantity (a count, a loss, a direct issue)',
    description:
      'Changes on hand by `quantityDelta` and records an ADJUSTMENT movement and STOCK_ADJUSTED — ' +
      'also ADR-056’s direct issue without a reservation. On hand may not fall below what is ' +
      'reserved (422 `ON_HAND_WOULD_BE_NEGATIVE`) nor pass the largest quantity stored (422 ' +
      '`QUANTITY_OUT_OF_RANGE`). No reason code or second approval is required: none is decided ' +
      '(Q-109); the operator, the movement and its event are the record. A stock item of ' +
      'another organization is 404. ' +
      STOCK_COMMAND_NOTE +
      ' ' +
      COMMAND_NOTE,
  })
  async adjust(
    @Body(zodPipe(adjustStockSchema)) dto: AdjustStockDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<StockChangeView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const keyHash = commandKeyHash(ADJUST_STOCK_ENDPOINT, key);
    const { result } = await this.idempotency.execute<StockChangeView>(
      ADJUST_STOCK_ENDPOINT,
      key,
      dto,
      201,
      (fence) => this.stock.adjust(dto, { fence, keyHash }),
      (stored) => this.stock.assertVisible(stored.stockItem.id),
    );
    return result;
  }
}
