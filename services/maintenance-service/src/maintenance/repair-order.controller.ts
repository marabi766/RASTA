import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { RepairOrderService } from './repair-order.service';
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
  type ListRepairOrdersQuery,
  type RecordCostDto,
  type RecordLabourDto,
  type RecordPartDto,
  type StartRepairDto,
} from './dto';

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
  constructor(private readonly repairOrders: RepairOrderService) {}

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
  start(@Param('id') id: string, @Body(zodPipe(startRepairSchema)) dto: StartRepairDto) {
    return this.repairOrders.start(id, dto);
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
      'the machine was collected later than it was repaired; downtime counts to that moment.',
  })
  complete(@Param('id') id: string, @Body(zodPipe(completeRepairSchema)) dto: CompleteRepairDto) {
    return this.repairOrders.complete(id, dto);
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
  cancel(@Param('id') id: string, @Body(zodPipe(cancelRepairSchema)) dto: CancelRepairDto) {
    return this.repairOrders.cancel(id, dto);
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
      'or stock movement in the service that owns it.',
  })
  recordPart(@Param('id') id: string, @Body(zodPipe(recordPartSchema)) dto: RecordPartDto) {
    return this.repairOrders.recordPart(id, dto);
  }

  @Post(':id/labour')
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Record labour spent on the repair',
    description:
      'Hours times rate, rounded once. `technician` is free text — a village workshop mechanic ' +
      'has no account on this platform, and requiring one would block the entry.',
  })
  recordLabour(@Param('id') id: string, @Body(zodPipe(recordLabourSchema)) dto: RecordLabourDto) {
    return this.repairOrders.recordLabour(id, dto);
  }

  @Post(':id/costs')
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Record a cost that is neither a part nor metered labour',
    description:
      'A call-out fee, a diagnostic charge, a third-party invoice. `PART` and `LABOUR` are not ' +
      'accepted here: those lines are written by recording the work itself, which is what keeps ' +
      'the provenance on a cost line meaningful.',
  })
  recordCost(@Param('id') id: string, @Body(zodPipe(recordCostSchema)) dto: RecordCostDto) {
    return this.repairOrders.recordCost(id, dto);
  }
}
