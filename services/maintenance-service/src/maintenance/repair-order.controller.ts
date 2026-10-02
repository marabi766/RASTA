import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { RepairOrderService } from './repair-order.service';
import { IdempotencyStore, optionalIdempotencyKey, type ClaimFence } from './idempotency';
import {
  cancelRepairSchema,
  completeRepairSchema,
  listRepairOrdersQuerySchema,
  recordCostSchema,
  recordLabourSchema,
  recordPartSchema,
  startRepairSchema,
  type CancelRepairDto,
  type CompleteRepairDto,
  type LabourEntryView,
  type ListRepairOrdersQuery,
  type MaintenanceCostView,
  type PartUsageView,
  type RecordCostDto,
  type RecordLabourDto,
  type RecordPartDto,
  type RepairOrderView,
  type StartRepairDto,
} from './dto';

/**
 * The route templates an Idempotency-Key is stored under, one per write: the
 * same key on two different endpoints is two requests. The order id is part of
 * the hashed request, so one key cannot be replayed onto another order.
 */
export const REPAIR_ORDER_ENDPOINTS = {
  start: 'POST /v1/repair-orders/:id/start',
  complete: 'POST /v1/repair-orders/:id/complete',
  cancel: 'POST /v1/repair-orders/:id/cancel',
  parts: 'POST /v1/repair-orders/:id/parts',
  labour: 'POST /v1/repair-orders/:id/labour',
  costs: 'POST /v1/repair-orders/:id/costs',
} as const;

const IDEMPOTENCY_KEY_HEADER = {
  name: 'Idempotency-Key',
  required: false,
  description:
    'Optional here, required at the gateway. 8 to 255 characters, scoped to the organization ' +
    'and the endpoint. The same key with the same body, order and user answers the original ' +
    'response without doing the work again (24 hours by default); the same key with a different ' +
    'body, order or user answers 409 IDEMPOTENCY_KEY_REUSED; a duplicate of a request still in ' +
    'flight answers 409 CONFLICT with Retry-After.',
} as const;

/**
 * HTTP surface for repair orders — the work and what it cost.
 *
 * A repair order is created by referring a request to a workshop
 * (`POST /v1/maintenance-requests/{id}/assign`), not by posting here. That is
 * deliberate: work exists because a machine needs it, and a repair order with
 * no request behind it would be a cost with nothing to justify it.
 *
 * Every write below is restricted to the roles that can commit the
 * organization to a cost. docs/09 § 9.3 gives `WORKSHOP` its own permissions
 * over the orders referred to it; serving that role means reading across a
 * tenant boundary, which this platform has no model for, so it is deferred
 * rather than approximated (ADR-029, docs/24 Q-25). Today a fleet manager
 * records the workshop's work — which, for a village workshop with no platform
 * account, is also how the paperwork actually arrives.
 */
@ApiTags('repair-orders')
@Controller({ path: 'repair-orders', version: '1' })
export class RepairOrderController {
  constructor(
    private readonly repairOrders: RepairOrderService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  /**
   * Runs a write under its `Idempotency-Key`, if it has one (docs/06 § 6.8).
   *
   * The caller's right to the order is established first, so a stored response
   * is only ever replayed to somebody who could have caused it; the claim, the
   * work, its outbox rows and the stored response then commit in one
   * transaction (`idempotency.ts`). No key: the work runs as it always did.
   */
  private async idempotently<T extends { id: string }>(
    endpoint: string,
    orderId: string,
    dto: object,
    rawKey: string | undefined,
    successStatus: number,
    work: (fence?: ClaimFence<T>) => Promise<T>,
  ): Promise<T> {
    const key = optionalIdempotencyKey(rawKey);
    if (key === undefined) return work();
    await this.repairOrders.assertAccessible(orderId);
    const { result } = await this.idempotency.execute<T>(
      endpoint,
      key,
      { repairOrderId: orderId, ...dto },
      successStatus,
      (fence) => work(fence),
    );
    return result;
  }

  // ---- Reads --------------------------------------------------------------

  @Get()
  @ApiOperation({
    summary: 'List repair orders, newest first',
    description:
      'Filter by `maintenanceRequestId`, `assetId`, `workshopOrganizationId` and `status`. ' +
      'Cursor-paginated.',
  })
  list(@Query(zodPipe(listRepairOrdersQuerySchema)) query: ListRepairOrdersQuery) {
    return this.repairOrders.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one repair order with its parts, labour and cost lines',
    description:
      'Every cost line names what produced it: a part, a labour entry, or a person. That ' +
      'provenance is what makes the total auditable rather than merely trusted.',
  })
  get(@Param('id') id: string) {
    return this.repairOrders.get(id);
  }

  // ---- Work ---------------------------------------------------------------

  @Post(':id/start')
  @HttpCode(200)
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'The machine goes into the workshop',
    description:
      'Publishes MAINTENANCE_STARTED, which withdraws the machine from service: asset-service ' +
      'moves it to IN_MAINTENANCE and fleet-service stops it being assigned to a driver. ' +
      'Returns 409 if the repair has already started or been cancelled.',
  })
  @ApiHeader(IDEMPOTENCY_KEY_HEADER)
  start(
    @Param('id') id: string,
    @Body(zodPipe(startRepairSchema)) dto: StartRepairDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotently<RepairOrderView>(
      REPAIR_ORDER_ENDPOINTS.start,
      id,
      dto,
      idempotencyKey,
      200,
      (fence) => this.repairOrders.start(id, dto, fence),
    );
  }

  @Post(':id/complete')
  @HttpCode(200)
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'The work is finished',
    description:
      'Publishes REPAIR_COMPLETED with what this workshop charged, and MAINTENANCE_COMPLETED, ' +
      'which returns the machine to service. The request moves to COMPLETED, not APPROVED — ' +
      'nothing settles until an owner has looked at the bill. Set `returnedToServiceAt` when ' +
      'the machine was collected later than it was repaired; downtime counts to that moment. ' +
      'Optionally send `expectedTotalCostMinor`, the order total you were shown: if a part or ' +
      'a charge was recorded since, the completion is refused with 422 and nothing changes.',
  })
  @ApiHeader(IDEMPOTENCY_KEY_HEADER)
  complete(
    @Param('id') id: string,
    @Body(zodPipe(completeRepairSchema)) dto: CompleteRepairDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotently<RepairOrderView>(
      REPAIR_ORDER_ENDPOINTS.complete,
      id,
      dto,
      idempotencyKey,
      200,
      (fence) => this.repairOrders.complete(id, dto, fence),
    );
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Withdraw the referral',
    description:
      'The request stays open and can be referred elsewhere — a workshop turning a job down is ' +
      'not the job going away. Cost already recorded is kept.',
  })
  @ApiHeader(IDEMPOTENCY_KEY_HEADER)
  cancel(
    @Param('id') id: string,
    @Body(zodPipe(cancelRepairSchema)) dto: CancelRepairDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotently<RepairOrderView>(
      REPAIR_ORDER_ENDPOINTS.cancel,
      id,
      dto,
      idempotencyKey,
      200,
      (fence) => this.repairOrders.cancel(id, dto, fence),
    );
  }

  // ---- Cost ---------------------------------------------------------------

  @Post(':id/parts')
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Record a part fitted during the repair',
    description:
      'Writes the part and its cost line together, so a PART cost can never exist without the ' +
      'part it came from. The repair order and request totals are recomputed from the lines in ' +
      'the same transaction, under a row lock, so two people entering parts at once cannot lose ' +
      'one of them. This records consumption, not stock: `sourceReference` points at the order ' +
      'or stock movement in the service that owns it. Publishes REPAIR_PART_RECORDED in the same ' +
      'transaction.',
  })
  @ApiHeader(IDEMPOTENCY_KEY_HEADER)
  recordPart(
    @Param('id') id: string,
    @Body(zodPipe(recordPartSchema)) dto: RecordPartDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotently<PartUsageView>(
      REPAIR_ORDER_ENDPOINTS.parts,
      id,
      dto,
      idempotencyKey,
      201,
      (fence) => this.repairOrders.recordPart(id, dto, fence),
    );
  }

  @Post(':id/labour')
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Record labour spent on the repair',
    description:
      'Hours times rate, rounded once. `technician` is free text — a village workshop mechanic ' +
      'has no account on this platform, and requiring one would block the entry. It stays in ' +
      'this service: REPAIR_LABOUR_RECORDED, published in the same transaction, does not carry it.',
  })
  @ApiHeader(IDEMPOTENCY_KEY_HEADER)
  recordLabour(
    @Param('id') id: string,
    @Body(zodPipe(recordLabourSchema)) dto: RecordLabourDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotently<LabourEntryView>(
      REPAIR_ORDER_ENDPOINTS.labour,
      id,
      dto,
      idempotencyKey,
      201,
      (fence) => this.repairOrders.recordLabour(id, dto, fence),
    );
  }

  @Post(':id/costs')
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Record a cost that is neither a part nor metered labour',
    description:
      'A call-out fee, a diagnostic charge, a third-party invoice. `PART` and `LABOUR` are not ' +
      'accepted here: those lines are written by recording the work itself, which is what keeps ' +
      'the provenance on a cost line meaningful. Publishes REPAIR_COST_RECORDED in the same ' +
      'transaction.',
  })
  @ApiHeader(IDEMPOTENCY_KEY_HEADER)
  recordCost(
    @Param('id') id: string,
    @Body(zodPipe(recordCostSchema)) dto: RecordCostDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.idempotently<MaintenanceCostView>(
      REPAIR_ORDER_ENDPOINTS.costs,
      id,
      dto,
      idempotencyKey,
      201,
      (fence) => this.repairOrders.recordCost(id, dto, fence),
    );
  }
}
