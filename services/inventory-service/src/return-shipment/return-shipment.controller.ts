import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import { commandKeyHash } from '../shared/command';
import type { CursorPage } from '../shared/dto';
import { IdempotencyStore, requiredIdempotencyKey } from '../shared/idempotency';
import {
  COMMAND_NOTE,
  RETURN_SHIPMENT_MOVE_NOTE,
  RETURN_SHIPMENT_READ_NOTE,
} from '../shared/notes';
import {
  createReturnShipmentSchema,
  listReturnShipmentsQuerySchema,
  inspectReturnShipmentSchema,
  receiveReturnShipmentSchema,
  resolveReturnShipmentSchema,
  type CreateReturnShipmentDto,
  type ListReturnShipmentsQuery,
  type InspectReturnShipmentDto,
  type ReceiveReturnShipmentDto,
  type ResolveReturnShipmentDto,
  type ReturnShipmentView,
  type ReturnTrackingView,
} from './dto';
import { ReturnShipmentService } from './return-shipment.service';

/** The route templates the idempotency store keys on: a closed set, never an id. */
export const CREATE_RETURN_SHIPMENT_ENDPOINT = 'POST /v1/return-shipments';
export const RECEIVE_RETURN_SHIPMENT_ENDPOINT = 'POST /v1/return-shipments/{id}/receive';
export const INSPECT_RETURN_SHIPMENT_ENDPOINT = 'POST /v1/return-shipments/{id}/inspection';
export const RESOLVE_RETURN_SHIPMENT_ENDPOINT = 'POST /v1/return-shipments/{id}/resolution';

const IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  required: true,
  description: '8 to 255 characters. Scoped to the organization.',
};

/**
 * Return shipments and their tracking (ADR-048 § 2, § 3). HTTP ↔ DTO and nothing else (AGENTS.md
 * A-10); no handler names a role — who may act and read is configuration (`InventoryAccess`).
 *
 * `docs/06` plans `POST /v1/return-shipments`; its reads and the receipt are this change's, under
 * the same prefix — `/v1/returns/*` belongs to marketplace at the gateway.
 */
@ApiTags('return-shipments')
@Controller({ path: 'return-shipments', version: '1' })
export class ReturnShipmentController {
  constructor(
    private readonly shipments: ReturnShipmentService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List return shipments coming to, or sent by, the organization the request acts for',
    description:
      'Newest first, optionally by `side` (`destination` | `sender`), `status` and ' +
      '`returnRequestId`. Each side is listed only as far as the caller’s roles open it. ' +
      RETURN_SHIPMENT_READ_NOTE,
  })
  async list(
    @Query(zodPipe(listReturnShipmentsQuerySchema)) query: ListReturnShipmentsQuery,
  ): Promise<CursorPage<ReturnShipmentView>> {
    return this.shipments.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Read one return shipment, with its lines',
    description: RETURN_SHIPMENT_READ_NOTE,
  })
  async get(@Param('id') id: string): Promise<ReturnShipmentView> {
    return this.shipments.get(id);
  }

  @Get(':id/tracking')
  @ApiOperation({
    summary: 'Track a return shipment: its status and what happened to it, in order',
    description:
      'One event per status reached (IN_TRANSIT, RECEIVED), in lifecycle order (the shipment ' +
      'version each step gave it), never by time; the status and the history are read together, ' +
      'so they always agree. ' +
      RETURN_SHIPMENT_READ_NOTE,
  })
  async tracking(@Param('id') id: string): Promise<ReturnTrackingView> {
    return this.shipments.tracking(id);
  }

  @RequirePlatformUserId()
  @Post()
  @HttpCode(201)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: 'Record goods of a return as on their way to one of the owner’s warehouses',
    description:
      'An IN_TRANSIT return shipment into `destinationWarehouseId` — a warehouse of the ' +
      'organization the request acts for (another’s is 404) — from `buyerOrganizationId`, for ' +
      '`returnRequestId`, with 1 to 50 order lines and their quantities. One return shipment per ' +
      'return request: a second is 409 `RETURN_ALREADY_DISPATCHED`. It moves no stock. The ' +
      'shipment, its lines, its IN_TRANSIT tracking event and RETURN_SHIPMENT_DISPATCHED ' +
      '(identifiers and quantities only — no carrier) commit in one transaction. ' +
      RETURN_SHIPMENT_MOVE_NOTE +
      ' ' +
      COMMAND_NOTE,
  })
  async create(
    @Body(zodPipe(createReturnShipmentSchema)) dto: CreateReturnShipmentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ReturnShipmentView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const keyHash = commandKeyHash(CREATE_RETURN_SHIPMENT_ENDPOINT, key);
    const { result } = await this.idempotency.execute<ReturnShipmentView>(
      CREATE_RETURN_SHIPMENT_ENDPOINT,
      key,
      dto,
      201,
      (fence) => this.shipments.dispatch(dto, { fence, keyHash }),
      (stored) => this.shipments.assertVisible(stored.id),
    );
    return result;
  }

  @RequirePlatformUserId()
  @Post(':id/receive')
  @HttpCode(200)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: 'Receive a return shipment (IN_TRANSIT → RECEIVED): the goods arrived',
    description:
      'Records how many of each line arrived (0 up to the quantity dispatched; exactly the ' +
      'dispatched lines, each once), the RECEIVED tracking event and RETURN_SHIPMENT_RECEIVED. ' +
      'Received goods are not stock: returned goods are not sellable until inspection ends ' +
      '(ADR-048 § 4). A return shipment already received is 409 `RETURN_SHIPMENT_NOT_IN_TRANSIT` ' +
      '(INVALID_STATE_TRANSITION). `expectedVersion` is optional. ' +
      RETURN_SHIPMENT_MOVE_NOTE +
      ' ' +
      COMMAND_NOTE,
  })
  async receive(
    @Param('id') id: string,
    @Body(zodPipe(receiveReturnShipmentSchema)) dto: ReceiveReturnShipmentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ReturnShipmentView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const keyHash = commandKeyHash(RECEIVE_RETURN_SHIPMENT_ENDPOINT, key);
    const { result } = await this.idempotency.execute<ReturnShipmentView>(
      RECEIVE_RETURN_SHIPMENT_ENDPOINT,
      key,
      { id, ...dto },
      200,
      (fence) => this.shipments.receive(id, dto, { fence, keyHash }),
      (stored) => this.shipments.assertVisible(stored.id),
    );
    return result;
  }

  @RequirePlatformUserId()
  @Post(':id/inspection')
  @HttpCode(200)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: 'Record the inspection of a return shipment (RECEIVED → INSPECTED)',
    description:
      'The received goods were examined. An optional `note` (kept here, shown to the readers, ' +
      'never on an event) and an optional `reportDocumentId` — the report is a file in ' +
      'document-service, referenced by id. Records the INSPECTED tracking event and ' +
      'RETURN_SHIPMENT_INSPECTED. The goods are still not stock (ADR-048 § 4). A return shipment ' +
      'not yet received, or inspected already, is 409 `RETURN_SHIPMENT_NOT_RECEIVED` ' +
      '(INVALID_STATE_TRANSITION). `expectedVersion` is optional. ' +
      RETURN_SHIPMENT_MOVE_NOTE +
      ' ' +
      COMMAND_NOTE,
  })
  async inspect(
    @Param('id') id: string,
    @Body(zodPipe(inspectReturnShipmentSchema)) dto: InspectReturnShipmentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ReturnShipmentView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const keyHash = commandKeyHash(INSPECT_RETURN_SHIPMENT_ENDPOINT, key);
    const { result } = await this.idempotency.execute<ReturnShipmentView>(
      INSPECT_RETURN_SHIPMENT_ENDPOINT,
      key,
      { id, ...dto },
      200,
      (fence) => this.shipments.inspect(id, dto, { fence, keyHash }),
      (stored) => this.shipments.assertVisible(stored.id),
    );
    return result;
  }

  @RequirePlatformUserId()
  @Post(':id/resolution')
  @HttpCode(200)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary:
      'Resolve a return shipment: give every received unit an outcome (INSPECTED → RESOLVED)',
    description:
      'Per line, its received units by disposition (RESTOCK, REPAIR, REPLACE, ' +
      'RETURN_TO_SUPPLIER, SCRAP, RECYCLE) — only those named in ' +
      'INVENTORY_RETURN_DISPOSITIONS_ALLOWED, which is empty by default (Q-133): 422 ' +
      '`DISPOSITION_NOT_ALLOWED`. For every line the quantities add up to exactly what was ' +
      'received: 422 `DISPOSITIONS_DO_NOT_BALANCE`. Records the RESOLVED tracking event and ' +
      'RETURN_SHIPMENT_RESOLVED. **This records an outcome and nothing else**: no stock is ' +
      'received into a balance (RESTOCK included) and no refund is requested — a refund is ' +
      'economic-service’s and has no operation for a settled order yet (Q-76). A return shipment ' +
      'not yet inspected, or resolved already, is 409 `RETURN_SHIPMENT_NOT_INSPECTED` ' +
      '(INVALID_STATE_TRANSITION). `expectedVersion` is optional. ' +
      RETURN_SHIPMENT_MOVE_NOTE +
      ' ' +
      COMMAND_NOTE,
  })
  async resolve(
    @Param('id') id: string,
    @Body(zodPipe(resolveReturnShipmentSchema)) dto: ResolveReturnShipmentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ReturnShipmentView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const keyHash = commandKeyHash(RESOLVE_RETURN_SHIPMENT_ENDPOINT, key);
    const { result } = await this.idempotency.execute<ReturnShipmentView>(
      RESOLVE_RETURN_SHIPMENT_ENDPOINT,
      key,
      { id, ...dto },
      200,
      (fence) => this.shipments.resolve(id, dto, { fence, keyHash }),
      (stored) => this.shipments.assertVisible(stored.id),
    );
    return result;
  }
}
