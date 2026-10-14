import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import { commandKeyHash } from '../shared/command';
import type { CursorPage } from '../shared/dto';
import { IdempotencyStore, requiredIdempotencyKey } from '../shared/idempotency';
import { COMMAND_NOTE, SHIPMENT_MOVE_NOTE, SHIPMENT_READ_NOTE } from '../shared/notes';
import {
  createShipmentSchema,
  listShipmentsQuerySchema,
  moveShipmentSchema,
  type CreateShipmentDto,
  type ListShipmentsQuery,
  type MoveShipmentDto,
  type ShipmentView,
  type TrackingView,
} from './dto';
import { ShipmentService } from './shipment.service';

/** The route templates the idempotency store keys on: a closed set, never an id. */
export const CREATE_SHIPMENT_ENDPOINT = 'POST /v1/shipments';
export const DISPATCH_SHIPMENT_ENDPOINT = 'POST /v1/shipments/{id}/dispatch';
export const DELIVER_SHIPMENT_ENDPOINT = 'POST /v1/shipments/{id}/deliver';

const IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  required: true,
  description: '8 to 255 characters. Scoped to the organization.',
};

/**
 * Shipments and their tracking (ADR-056 § 2, § 5). HTTP ↔ DTO and nothing else (AGENTS.md A-10);
 * no handler names a role — who may act and read is configuration (`InventoryAccess`).
 */
@ApiTags('shipments')
@Controller({ path: 'shipments', version: '1' })
export class ShipmentController {
  constructor(
    private readonly shipments: ShipmentService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List shipments leaving or sent to the organization the request acts for, newest first',
    description:
      'Optionally by `side` (`origin` | `consignee`) and by `status`. Each side is listed only ' +
      'as far as the caller’s roles open it. ' +
      SHIPMENT_READ_NOTE,
  })
  async list(
    @Query(zodPipe(listShipmentsQuerySchema)) query: ListShipmentsQuery,
  ): Promise<CursorPage<ShipmentView>> {
    return this.shipments.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one shipment, with its legs', description: SHIPMENT_READ_NOTE })
  async get(@Param('id') id: string): Promise<ShipmentView> {
    return this.shipments.get(id);
  }

  @Get(':id/tracking')
  @ApiOperation({
    summary: 'Track a shipment: its status and what happened to it, in order',
    description:
      'The tracking history — one event per status the shipment reached (CREATED, DISPATCHED, ' +
      'DELIVERED), in lifecycle order (the shipment version each step gave it), never by time; ' +
      'the status and the history are read together, so they always agree. ' +
      SHIPMENT_READ_NOTE,
  })
  async tracking(@Param('id') id: string): Promise<TrackingView> {
    return this.shipments.tracking(id);
  }

  @RequirePlatformUserId()
  @Post()
  @HttpCode(201)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: 'Create a shipment out of one of the owner’s warehouses',
    description:
      'A CREATED shipment from `originWarehouseId` — a warehouse of the organization the request ' +
      'acts for (another’s is 404) — to `consigneeOrganizationId`, with 1 to 10 legs in carrying ' +
      'order. It moves no stock (Q-115): stock leaves through issuing a reservation. The ' +
      'shipment, its legs, its CREATED tracking event and SHIPMENT_CREATED (identifiers only — no ' +
      'carrier) commit in one transaction. ' +
      COMMAND_NOTE,
  })
  async create(
    @Body(zodPipe(createShipmentSchema)) dto: CreateShipmentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ShipmentView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const keyHash = commandKeyHash(CREATE_SHIPMENT_ENDPOINT, key);
    const { result } = await this.idempotency.execute<ShipmentView>(
      CREATE_SHIPMENT_ENDPOINT,
      key,
      dto,
      201,
      (fence) => this.shipments.create(dto, { fence, keyHash }),
      (stored) => this.shipments.assertVisible(stored.id),
    );
    return result;
  }

  @RequirePlatformUserId()
  @Post(':id/dispatch')
  @HttpCode(200)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: 'Dispatch a shipment (CREATED → DISPATCHED): it left its origin warehouse',
    description:
      'Records the DISPATCHED tracking event and SHIPMENT_DISPATCHED. A shipment already ' +
      'dispatched or delivered is 409 `SHIPMENT_NOT_CREATED` (INVALID_STATE_TRANSITION). ' +
      '`expectedVersion` is optional. ' +
      SHIPMENT_MOVE_NOTE +
      ' ' +
      COMMAND_NOTE,
  })
  async dispatch(
    @Param('id') id: string,
    @Body(zodPipe(moveShipmentSchema)) dto: MoveShipmentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ShipmentView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const keyHash = commandKeyHash(DISPATCH_SHIPMENT_ENDPOINT, key);
    const { result } = await this.idempotency.execute<ShipmentView>(
      DISPATCH_SHIPMENT_ENDPOINT,
      key,
      { id, ...dto },
      200,
      (fence) => this.shipments.dispatch(id, dto, { fence, keyHash }),
      (stored) => this.shipments.assertVisible(stored.id),
    );
    return result;
  }

  @RequirePlatformUserId()
  @Post(':id/deliver')
  @HttpCode(200)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary:
      'Deliver a shipment (DISPATCHED → DELIVERED), as its origin warehouse’s owner records it',
    description:
      '`ConfirmDelivery` (docs/04 § 4.11): only an operator of the origin warehouse’s owner ' +
      '(ADR-056 plan step 10) — not the consignee (Q-114). Records the DELIVERED tracking event ' +
      'and SHIPMENT_DELIVERED. A shipment not yet dispatched, or already delivered, is 409 ' +
      '`SHIPMENT_NOT_DISPATCHED` (INVALID_STATE_TRANSITION). `expectedVersion` is optional. ' +
      SHIPMENT_MOVE_NOTE +
      ' ' +
      COMMAND_NOTE,
  })
  async deliver(
    @Param('id') id: string,
    @Body(zodPipe(moveShipmentSchema)) dto: MoveShipmentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ShipmentView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const keyHash = commandKeyHash(DELIVER_SHIPMENT_ENDPOINT, key);
    const { result } = await this.idempotency.execute<ShipmentView>(
      DELIVER_SHIPMENT_ENDPOINT,
      key,
      { id, ...dto },
      200,
      (fence) => this.shipments.deliver(id, dto, { fence, keyHash }),
      (stored) => this.shipments.assertVisible(stored.id),
    );
    return result;
  }
}
