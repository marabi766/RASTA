import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AllowService, zodPipe } from '@rasta/nest-common';
import {
  SOURCE_FACT_CALLER,
  UsageFactService,
  usageRecordIdParamSchema,
  type UsageRecordFactView,
} from './source-fact';
import {
  CLEARANCE_CALLER,
  TransferClearanceService,
  clearanceArrival,
  assetIdParamSchema,
  fenceIdSchema,
  transferClearanceSchema,
  type TransferClearanceDto,
  type TransferClearanceView,
} from './transfer-clearance';

/**
 * The internal source-of-truth read (ADR-061 § 4). See `source-fact.ts`.
 * HTTP to DTO only.
 */
@ApiTags('fleet-internal')
@Controller({ path: 'internal/usage-records', version: '1' })
export class FleetInternalController {
  constructor(private readonly facts: UsageFactService) {}

  @Get(':id')
  @AllowService(SOURCE_FACT_CALLER)
  @ApiParam({
    name: 'id',
    description: 'The usage record’s own identifier.',
    schema: { type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' },
  })
  @ApiOperation({
    summary: 'State a usage record as its owner records it (internal)',
    description:
      'Reserved for `economic-service`’s service token; every other service and every user ' +
      'token is refused. The organization is the one signed into the token, and a record in ' +
      'any other organization answers `404`. Returns the record’s organization, asset, ' +
      'period, quantities and the user who recorded it — what the reward consumer needs ' +
      'instead of trusting the event.',
  })
  get(@Param('id', zodPipe(usageRecordIdParamSchema)) id: string): Promise<UsageRecordFactView> {
    return this.facts.usageFact(id);
  }
}

/**
 * Whether a machine can be transferred, and the fence that keeps the answer
 * true until it is (ADR-062). See `transfer-clearance.ts`. HTTP to DTO only.
 */
@ApiTags('fleet-internal')
@Controller({ path: 'internal/assets', version: '1' })
export class FleetTransferClearanceController {
  constructor(private readonly clearance: TransferClearanceService) {}

  @Post(':assetId/transfer-clearance')
  @HttpCode(200)
  @AllowService(CLEARANCE_CALLER)
  @ApiParam({ name: 'assetId', schema: { type: 'string', maxLength: 64 } })
  @ApiOperation({
    summary: 'Count open assignments on a machine and, if none, fence it for a transfer (internal)',
    description:
      'Reserved for `asset-service`’s service token; every other service and every user token ' +
      'is refused. The organization is the one signed into the token. Answers `clear` and a ' +
      'count only, for that organization; a machine the replica places in another organization ' +
      'answers `404`. When clear, no assignment can start on the machine until the transfer ' +
      'lands, the fence is released, or it expires. `409` while another transfer holds a fence.',
  })
  clear(
    @Req() request: object,
    @Param('assetId', zodPipe(assetIdParamSchema)) assetId: string,
    @Body(zodPipe(transferClearanceSchema)) dto: TransferClearanceDto,
  ): Promise<TransferClearanceView> {
    // The bound runs from arrival, stamped before any guard (review #127 round 4, #1).
    return this.clearance.clear(assetId, dto, clearanceArrival(request));
  }

  @Delete(':assetId/transfer-clearance/:fenceId')
  @HttpCode(204)
  @AllowService(CLEARANCE_CALLER)
  @ApiOperation({
    summary: 'Release the fence of a transfer that did not happen (internal)',
    description:
      'Reserved for `asset-service`. Removes only the fence with this id placed by the ' +
      'organization signed into the token. Idempotent.',
  })
  release(
    @Param('assetId', zodPipe(assetIdParamSchema)) assetId: string,
    @Param('fenceId', zodPipe(fenceIdSchema)) fenceId: string,
  ): Promise<void> {
    return this.clearance.release(assetId, fenceId);
  }
}
