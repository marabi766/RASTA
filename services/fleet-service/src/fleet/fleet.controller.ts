import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { UsageService } from './usage.service';
import { AvailabilityService } from './availability.service';
import { ENV } from '../tokens';
import type { FleetEnv } from '../config/env';
import {
  availabilityQuerySchema,
  declareAvailabilitySchema,
  listUsageQuerySchema,
  recordUsageSchema,
  utilizationQuerySchema,
  type AvailabilityQuery,
  type DeclareAvailabilityDto,
  type ListUsageQuery,
  type RecordUsageDto,
  type UtilizationQuery,
} from './dto';

/**
 * Usage records.
 *
 * A top-level resource rather than `/v1/assets/{assetId}/usage` for the same
 * routing reason as assignments (ADR-026): the gateway matches on the first
 * path segment, and `assets/` belongs to asset-service.
 */
@ApiTags('usage-records')
@Controller({ path: 'usage-records', version: '1' })
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  @ApiOperation({
    summary: 'List usage records, newest first',
    description:
      'Filter by `assetId`, `driverId`, `source` and a `from`/`to` window over the period end. ' +
      'A caller holding only DRIVER or OPERATOR sees their own records. Cursor-paginated.',
  })
  list(@Query(zodPipe(listUsageQuerySchema)) query: ListUsageQuery) {
    return this.usage.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one usage record' })
  get(@Param('id') id: string) {
    return this.usage.get(id);
  }

  @Post()
  // Operators and drivers are exactly who should be filing readings — they are
  // the ones at the machine. The service narrows them to the machine they are
  // actually holding.
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN', 'OPERATOR', 'DRIVER')
  @ApiOperation({
    summary: 'Record machine usage',
    description:
      'At least one of `hours` or `kilometres` is required. Publishes USAGE_RECORDED, which ' +
      'drives usage-based maintenance schedules. Send `clientReference` to make the submission ' +
      'replay-safe: resending the same reference returns the original record and publishes ' +
      'nothing further, which is what lets the field application queue readings offline.',
  })
  record(@Body(zodPipe(recordUsageSchema)) dto: RecordUsageDto) {
    return this.usage.record(dto);
  }
}

/**
 * Fleet-wide views: availability and utilization.
 *
 * Both are read models over data this service already holds. Neither is an
 * analytics engine — cross-domain reporting belongs to analytics-service
 * (docs/04 § 4.15).
 */
@ApiTags('fleet')
@Controller({ path: 'fleet', version: '1' })
export class FleetController {
  constructor(
    private readonly availability: AvailabilityService,
    @Inject(ENV) private readonly env: FleetEnv,
  ) {}

  @Get('availability')
  @ApiOperation({
    summary: 'Which machines can be dispatched',
    description:
      'Composes facts owned by four services and names the owner of every blocker, so an ' +
      'operator knows whether to call the workshop, renew a policy, or end an assignment. ' +
      'Pass `availableOnly=true` for only the dispatchable ones, or `at` for a point in time.',
  })
  list(@Query(zodPipe(availabilityQuerySchema)) query: AvailabilityQuery) {
    return this.availability.list(query);
  }

  @Post('availability')
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Declare a machine available or unavailable for a period',
    description:
      'A declaration supersedes the previous one for the same machine. It cannot make an ' +
      'otherwise-blocked machine dispatchable: declaring a machine free does not renew its ' +
      'insurance, so the declaration sits alongside the other blockers rather than overriding ' +
      'them.',
  })
  declare(@Body(zodPipe(declareAvailabilitySchema)) dto: DeclareAvailabilityDto) {
    return this.availability.declare(dto);
  }

  @Post('availability/:id/revoke')
  @HttpCode(200)
  @Roles('ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Withdraw an availability declaration',
    description:
      'The window is kept, not deleted: "why was this machine unavailable last March?" is a ' +
      'question a fleet manager will be asked.',
  })
  revoke(@Param('id') id: string) {
    return this.availability.revoke(id);
  }

  @Get('utilization')
  @ApiOperation({
    summary: 'How much of the available time each machine worked',
    description:
      'Defaults to the last configured window. `utilizationPercent` is null — never zero — ' +
      'when the window holds no readings at all: "we have no data" and "the machine sat idle" ' +
      'are different facts.',
  })
  utilization(@Query(zodPipe(utilizationQuerySchema)) query: UtilizationQuery) {
    return this.availability.utilization(
      query,
      this.env.UTILIZATION_DEFAULT_WINDOW_DAYS,
      this.env.UTILIZATION_AVAILABLE_HOURS_PER_DAY,
    );
  }
}
