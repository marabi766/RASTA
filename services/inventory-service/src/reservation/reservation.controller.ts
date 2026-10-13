import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import { commandKeyHash } from '../shared/command';
import type { CursorPage } from '../shared/dto';
import { IdempotencyStore, requiredIdempotencyKey } from '../shared/idempotency';
import { COMMAND_NOTE, READ_NOTE, STOCK_COMMAND_NOTE } from '../shared/notes';
import {
  endReservationSchema,
  listReservationsQuerySchema,
  reserveStockSchema,
  type EndReservationDto,
  type ListReservationsQuery,
  type ReservationBatchView,
  type ReservationView,
  type ReserveStockDto,
} from './dto';
import { ReservationService } from './reservation.service';

/** The route templates the idempotency store keys on: a closed set, never an id. */
export const RESERVE_STOCK_ENDPOINT = 'POST /v1/stock/reservations';
export const RELEASE_RESERVATION_ENDPOINT = 'POST /v1/stock/reservations/{id}/release';
export const ISSUE_RESERVATION_ENDPOINT = 'POST /v1/stock/reservations/{id}/issue';

const ENDED_NOTE =
  'A reservation that is no longer ACTIVE — issued, released, or past its `expiresAt` (expired ' +
  'first, under the same lock) — is 409 `RESERVATION_NOT_ACTIVE` (INVALID_STATE_TRANSITION). ' +
  'A reservation of another organization, even on the same stock item, is 404 (ADR-056 § 5).';

/**
 * Reservations. HTTP ↔ DTO and nothing else (AGENTS.md A-10); no handler names a role. Registered
 * before `StockController`, so `GET /v1/stock/reservations` is never read as a stock item id.
 */
@ApiTags('reservations')
@Controller({ path: 'stock/reservations', version: '1' })
export class ReservationController {
  constructor(
    private readonly reservations: ReservationService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List reservations, newest first',
    description:
      'Optionally by `status` and by `stockItemId`. In this version the holder is the owner ' +
      '(Q-104), so these are the owner’s reservations. ' +
      READ_NOTE,
  })
  async list(
    @Query(zodPipe(listReservationsQuerySchema)) query: ListReservationsQuery,
  ): Promise<CursorPage<ReservationView>> {
    return this.reservations.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one reservation', description: READ_NOTE })
  async get(@Param('id') id: string): Promise<ReservationView> {
    return this.reservations.get(id);
  }

  @RequirePlatformUserId()
  @Post()
  @HttpCode(201)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 255 characters. Scoped to the organization.',
  })
  @ApiOperation({
    summary: 'Reserve stock: every line, or none',
    description:
      'Reserves each line’s quantity of its stock item for the holder — reserved grows, on hand ' +
      'does not — and records a RESERVE movement and STOCK_RESERVED per line. All or nothing: ' +
      'a line short of available stock reserves none (422 `INSUFFICIENT_AVAILABLE_STOCK`); lines ' +
      'of two warehouses are 422 `LINES_SPAN_WAREHOUSES`; an `expiresAt` not in the future or ' +
      'past the longest reservation allowed is 422 `EXPIRY_OUT_OF_RANGE`; a holder other than ' +
      'the owner is 422 `HOLDER_NOT_OWNER` (Q-104). A stock item of another organization is 404. ' +
      'Under any number of concurrent requests the stock is never over-reserved: available ' +
      'never falls below zero. ' +
      STOCK_COMMAND_NOTE +
      ' ' +
      COMMAND_NOTE,
  })
  async reserve(
    @Body(zodPipe(reserveStockSchema)) dto: ReserveStockDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ReservationBatchView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const keyHash = commandKeyHash(RESERVE_STOCK_ENDPOINT, key);
    const { result } = await this.idempotency.execute<ReservationBatchView>(
      RESERVE_STOCK_ENDPOINT,
      key,
      dto,
      201,
      (fence) => this.reservations.reserve(dto, { fence, keyHash }),
      async (stored) => {
        for (const reservation of stored.reservations) {
          await this.reservations.assertVisible(reservation.id);
        }
      },
    );
    return result;
  }

  @RequirePlatformUserId()
  @Post(':id/release')
  @HttpCode(200)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 255 characters. Scoped to the organization.',
  })
  @ApiOperation({
    summary: 'Release a reservation (ACTIVE → RELEASED): the stock stays',
    description:
      'Reserved falls by the reservation’s quantity, on hand does not; a RELEASE movement and ' +
      'STOCK_RELEASED (`reason: RELEASED`). `expectedVersion` is optional. ' +
      ENDED_NOTE +
      ' ' +
      STOCK_COMMAND_NOTE +
      ' ' +
      COMMAND_NOTE,
  })
  async release(
    @Param('id') id: string,
    @Body(zodPipe(endReservationSchema)) dto: EndReservationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ReservationView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const keyHash = commandKeyHash(RELEASE_RESERVATION_ENDPOINT, key);
    const { result } = await this.idempotency.execute<ReservationView>(
      RELEASE_RESERVATION_ENDPOINT,
      key,
      { id, ...dto },
      200,
      (fence) => this.reservations.release(id, dto, { fence, keyHash }),
      (stored) => this.reservations.assertVisible(stored.id),
    );
    return result;
  }

  @RequirePlatformUserId()
  @Post(':id/issue')
  @HttpCode(200)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 255 characters. Scoped to the organization.',
  })
  @ApiOperation({
    summary: 'Issue a reservation (ACTIVE → CONSUMED): the stock leaves',
    description:
      'Consumes the **whole** reservation — on hand and reserved both fall by its quantity — and ' +
      'records an ISSUE movement and STOCK_ISSUED. There is no partial issue (Q-107): a smaller ' +
      'need is a release and a new reservation. `expectedVersion` is optional. ' +
      ENDED_NOTE +
      ' ' +
      STOCK_COMMAND_NOTE +
      ' ' +
      COMMAND_NOTE,
  })
  async issue(
    @Param('id') id: string,
    @Body(zodPipe(endReservationSchema)) dto: EndReservationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ReservationView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const keyHash = commandKeyHash(ISSUE_RESERVATION_ENDPOINT, key);
    const { result } = await this.idempotency.execute<ReservationView>(
      ISSUE_RESERVATION_ENDPOINT,
      key,
      { id, ...dto },
      200,
      (fence) => this.reservations.issue(id, dto, { fence, keyHash }),
      (stored) => this.reservations.assertVisible(stored.id),
    );
    return result;
  }
}
