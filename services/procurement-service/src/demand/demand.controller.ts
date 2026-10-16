import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import { IdempotencyStore, requiredIdempotencyKey } from '../shared/idempotency';
import {
  listAggregationsQuerySchema,
  listDemandsQuerySchema,
  submitDemandSchema,
  withdrawDemandSchema,
  type AggregationView,
  type CursorPage,
  type DemandView,
  type ListAggregationsQuery,
  type ListDemandsQuery,
  type SubmitDemandDto,
  type WithdrawDemandDto,
} from './dto';
import { DemandService } from './demand.service';

/** The route templates the idempotency store keys on: a closed set, never an id. */
export const SUBMIT_DEMAND_ENDPOINT = 'POST /v1/demand-requests';
export const WITHDRAW_DEMAND_ENDPOINT = 'POST /v1/demand-requests/{id}/withdraw';

export const BUYER_NOTE =
  'Closed by default (S-02). The buyer’s own organization only: a person holding a role ' +
  'PROCUREMENT_DEMAND_ROLES names (default PROCUREMENT_USER, ORGANIZATION_ADMIN) in the organization ' +
  'the request acts for. A demand or aggregation of any other organization, and one that does not ' +
  'exist, are both 404, never 403 (S-03). AUDITOR, the platform administrator (SYSTEM_ADMIN, ' +
  'whatever organization it selected) and a service token are refused (403) before anything is read.';

const COMMAND_NOTE =
  'Requires an `Idempotency-Key` (docs/06 § 6.8): without one, or with one outside 8 to 255 ' +
  'characters, 400 VALIDATION_FAILED and nothing is done. The same key with the same body from ' +
  'the same user answers the original response and does nothing again; the same key with ' +
  'another body or user is 409 IDEMPOTENCY_KEY_REUSED; a duplicate that arrives while the first ' +
  'is still being processed waits for its answer and past a few seconds is 409 CONFLICT with ' +
  'Retry-After. The caller must be a signed-in person with a platform user id (403 otherwise).';

/**
 * The demand API (ADR-070 § 2, COM-007 PR 1). HTTP ↔ DTO and nothing else (AGENTS.md A-10); no
 * handler names a role — who may act is `ProcurementAccess`, from configuration.
 */
@ApiTags('demand-requests')
@Controller({ path: 'demand-requests', version: '1' })
export class DemandController {
  constructor(
    private readonly demands: DemandService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @RequirePlatformUserId()
  @Post()
  @HttpCode(201)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 255 characters. Scoped to the organization.',
  })
  @ApiOperation({
    summary: 'Register a need of the caller’s organization; it joins the open window',
    description:
      'Joins the OPEN aggregation of (organization, productId), or opens one with the first ' +
      'demand, under the aggregation’s row lock and the database clock read after it. The window ' +
      'is half-open, [openedAt, closesAt): a demand at or after closesAt never joins it — that ' +
      'same request ends the window (READY when it holds a demand and reaches its threshold; ' +
      'otherwise its snapshot’s policy: EXTEND moves it on and the demand joins it, REFER and ' +
      'CLOSE end it) and the demand joins the window that follows. A demand that would take the ' +
      'total of the window it joins past 2147483647 is 422 AGGREGATION_QUANTITY_LIMIT_EXCEEDED ' +
      'and writes nothing. productId is opaque and never ' +
      'checked against marketplace (Q-105, Q-120). DEMAND_SUBMITTED carries identifiers, the ' +
      `quantity and instants only — never the note. ${BUYER_NOTE} ${COMMAND_NOTE}`,
  })
  async submit(
    @Body(zodPipe(submitDemandSchema)) dto: SubmitDemandDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<DemandView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<DemandView>(
      SUBMIT_DEMAND_ENDPOINT,
      key,
      dto,
      201,
      (fence) => this.demands.submit(dto, fence),
      (stored) => this.demands.assertDemandVisible(stored.id),
    );
    return result;
  }

  @Get()
  @ApiOperation({
    summary: 'List the caller organization’s demands, newest first',
    description: `The caller organization’s demands only. ${BUYER_NOTE}`,
  })
  async list(
    @Query(zodPipe(listDemandsQuerySchema)) query: ListDemandsQuery,
  ): Promise<CursorPage<DemandView>> {
    return this.demands.listDemands(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one demand', description: BUYER_NOTE })
  async get(@Param('id') id: string): Promise<DemandView> {
    return this.demands.getDemand(id);
  }

  @RequirePlatformUserId()
  @Post(':id/withdraw')
  @HttpCode(200)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 to 255 characters. Scoped to the organization.',
  })
  @ApiOperation({
    summary: 'Withdraw a demand while its window is open, with a reason',
    description:
      'SUBMITTED → WITHDRAWN, only while its aggregation is OPEN and before closesAt by the ' +
      'database clock (422 `AGGREGATION_WINDOW_ENDED` after: the demand set is frozen); a demand ' +
      'that is not SUBMITTED is 422 `DEMAND_NOT_SUBMITTED`; `expectedVersion` that is not the ' +
      'current version is 409 OPTIMISTIC_LOCK_FAILED. The reason is required and stays with the ' +
      'demand; there is no edit — withdraw and submit again. The window keeps its other demands ' +
      `and its end. ${BUYER_NOTE} ${COMMAND_NOTE}`,
  })
  async withdraw(
    @Param('id') id: string,
    @Body(zodPipe(withdrawDemandSchema)) dto: WithdrawDemandDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<DemandView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<DemandView>(
      WITHDRAW_DEMAND_ENDPOINT,
      key,
      { id, ...dto },
      200,
      (fence) => this.demands.withdraw(id, dto, fence),
      (stored) => this.demands.assertDemandVisible(stored.id),
    );
    return result;
  }
}

/** The aggregation API (ADR-070 § 2): read only in PR 1 — the window's end is the system's. */
@ApiTags('aggregations')
@Controller({ path: 'aggregations', version: '1' })
export class AggregationController {
  constructor(private readonly demands: DemandService) {}

  @Get()
  @ApiOperation({
    summary: 'List the caller organization’s aggregations, newest first',
    description:
      'The caller organization’s aggregations (status=OPEN lists the open windows). A window ' +
      'whose closesAt has passed stays OPEN here until a demand for its product ends it (the ' +
      `sweeper that ends it on time is ADR-070 plan PR 2). ${BUYER_NOTE}`,
  })
  async list(
    @Query(zodPipe(listAggregationsQuerySchema)) query: ListAggregationsQuery,
  ): Promise<CursorPage<AggregationView>> {
    return this.demands.listAggregations(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Read one aggregation',
    description: `With the setting snapshot taken when the window opened. ${BUYER_NOTE}`,
  })
  async get(@Param('id') id: string): Promise<AggregationView> {
    return this.demands.getAggregation(id);
  }
}
