import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { RequestService } from './request.service';
import { RepairOrderService } from './repair-order.service';
import { IdempotencyStore, optionalIdempotencyKey } from './idempotency';
import {
  approveRequestSchema,
  assignWorkshopSchema,
  cancelRequestSchema,
  createRequestSchema,
  listRequestsQuerySchema,
  type ApproveRequestDto,
  type AssignWorkshopDto,
  type CancelRequestDto,
  type CreateRequestDto,
  type ListRequestsQuery,
} from './dto';

/**
 * HTTP surface for maintenance requests.
 *
 * The one endpoint worth pausing over is `approve`. It is the product
 * document's mandatory control — settlement is impossible without it (docs/17)
 * — so it is restricted to the roles that can commit the organization to a
 * cost, and it is the only place in this service that produces the event
 * economic-service will one day settle behind (ADR-028).
 */
/** The route template an Idempotency-Key is stored under (#157). */
export const CREATE_REQUEST_ENDPOINT = 'POST /v1/maintenance-requests';

@ApiTags('maintenance-requests')
@Controller({ path: 'maintenance-requests', version: '1' })
export class RequestController {
  constructor(
    private readonly requests: RequestService,
    private readonly repairOrders: RepairOrderService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  // ---- Reads --------------------------------------------------------------

  @Get()
  @ApiOperation({
    summary: 'List maintenance requests, newest first',
    description:
      'Filter by `assetId`, `status`, `type`, `severity`, `scheduleId`, `openOnly` and a ' +
      '`from`/`to` window over the report time. `assetId` is how a machine maintenance history ' +
      'is read. A caller holding only DRIVER or OPERATOR sees the requests they reported. ' +
      'Cursor-paginated.',
  })
  list(@Query(zodPipe(listRequestsQuerySchema)) query: ListRequestsQuery) {
    return this.requests.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one request with its referrals and cost breakdown',
    description: 'Returns 404 for a request in another organization — never 403.',
  })
  get(@Param('id') id: string) {
    return this.requests.get(id);
  }

  // ---- Writes -------------------------------------------------------------

  @Post()
  // Operators and drivers are exactly who should be reporting a fault — they
  // are the ones at the machine. What they may do afterwards is narrowed in
  // `access.ts`, and why it is narrowed the way it is, is documented there.
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN', 'OPERATOR', 'DRIVER')
  @ApiOperation({
    summary: 'Raise maintenance work — planned or a breakdown',
    description:
      'A `CORRECTIVE` request must state a severity and publishes BREAKDOWN_REPORTED as well ' +
      'as MAINTENANCE_CREATED. A second open request of the same type for the same machine is ' +
      'refused with 422 — the duplicate-report control the product document requires — and the ' +
      'rule is enforced by a partial unique index, so a concurrent duplicate is refused the ' +
      'same way as a sequential one. Set `outOfServiceAt` when the machine stopped being usable ' +
      'before anyone could look at it; downtime is measured from there, not from the repair. ' +
      'An optional `Idempotency-Key` makes a retry safe (#157): the same key with the same ' +
      'body from the same user answers the original 201 without raising the work again — even ' +
      'if that request has since been closed — for 24 hours by default; the same key with a ' +
      'different body answers 409 IDEMPOTENCY_KEY_REUSED.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional, 8 to 255 characters. Scoped to the organization: the same key in two ' +
      'organizations is two requests.',
  })
  async create(
    @Body(zodPipe(createRequestSchema)) dto: CreateRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = optionalIdempotencyKey(idempotencyKey);
    if (key === undefined) return this.requests.create(dto);
    const { result } = await this.idempotency.execute(CREATE_REQUEST_ENDPOINT, key, dto, 201, () =>
      this.requests.create(dto),
    );
    return result;
  }

  @Post(':id/assign')
  @HttpCode(201)
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Refer the work to a workshop',
    description:
      'Creates a repair order and publishes WORKSHOP_ASSIGNED. A request may hold only one live ' +
      'referral, enforced by a partial unique index; cancel the first to refer the work ' +
      'elsewhere. Workshop qualification is not yet verified — supplier-service owns that and ' +
      'is not deployed (ADR-029).',
  })
  assign(@Param('id') id: string, @Body(zodPipe(assignWorkshopSchema)) dto: AssignWorkshopDto) {
    return this.repairOrders.assign(id, dto);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Approve the work and its cost',
    description:
      'The control the product document makes mandatory before settlement. Only a COMPLETED ' +
      'request can be approved, and approval is terminal. Send `expectedTotalCostMinor` to be ' +
      'refused with 422 if the cost changed between the screen and the button. Publishes ' +
      'MAINTENANCE_APPROVED with a per-category cost breakdown, which is the only event that ' +
      'authorises settlement.',
  })
  approve(@Param('id') id: string, @Body(zodPipe(approveRequestSchema)) dto: ApproveRequestDto) {
    return this.requests.approve(id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Abandon the work',
    description:
      'Cancels any live referral with it and publishes MAINTENANCE_CANCELLED, so consumers that ' +
      'saw MAINTENANCE_CREATED stop believing the work is outstanding. Cost already recorded is ' +
      'kept: it was really incurred. An approved request cannot be cancelled — it has already ' +
      'authorised settlement.',
  })
  cancel(@Param('id') id: string, @Body(zodPipe(cancelRequestSchema)) dto: CancelRequestDto) {
    return this.requests.cancel(id, dto);
  }
}
