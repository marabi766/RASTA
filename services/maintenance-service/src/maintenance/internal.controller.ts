import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AllowService, zodPipe } from '@rasta/nest-common';
import {
  MaintenanceFactService,
  SOURCE_FACT_CALLER,
  requestIdParamSchema,
  type MaintenanceRequestFactView,
} from './source-fact';
import {
  CLEARANCE_CALLER,
  TransferClearanceService,
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
@ApiTags('maintenance-internal')
@Controller({ path: 'internal/maintenance-requests', version: '1' })
export class MaintenanceInternalController {
  constructor(private readonly facts: MaintenanceFactService) {}

  @Get(':id')
  @AllowService(SOURCE_FACT_CALLER)
  @ApiParam({
    name: 'id',
    description: 'The maintenance request’s own identifier.',
    schema: { type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' },
  })
  @ApiOperation({
    summary: 'State a maintenance request as its owner records it (internal)',
    description:
      'Reserved for `economic-service`’s service token; every other service and every user ' +
      'token is refused. The organization is the one signed into the token, and a request ' +
      'in any other organization answers `404`. Returns the status, the approval, the total ' +
      'and currency, the settling workshop and the completion — what a consumer needs to ' +
      'check a maintenance event before it creates an obligation or a reward.',
  })
  get(@Param('id', zodPipe(requestIdParamSchema)) id: string): Promise<MaintenanceRequestFactView> {
    return this.facts.requestFact(id);
  }
}

/**
 * Whether a machine can be transferred, and the fence that keeps the answer
 * true until it is (ADR-062). See `transfer-clearance.ts`. HTTP to DTO only.
 */
@ApiTags('maintenance-internal')
@Controller({ path: 'internal/assets', version: '1' })
export class MaintenanceTransferClearanceController {
  constructor(private readonly clearance: TransferClearanceService) {}

  @Post(':assetId/transfer-clearance')
  @HttpCode(200)
  @AllowService(CLEARANCE_CALLER)
  @ApiParam({ name: 'assetId', schema: { type: 'string', maxLength: 64 } })
  @ApiOperation({
    summary: 'Count open maintenance work on a machine and, if none, fence it for a transfer (internal)',
    description:
      'Reserved for `asset-service`’s service token; every other service and every user token ' +
      'is refused. The organization is the one signed into the token. Answers `clear` and a ' +
      'count only, for that organization; a machine the replica places in another organization ' +
      'answers `404`. When clear, no maintenance request can be raised on the machine until the transfer ' +
      'lands, the fence is released, or it expires. `409` while another transfer holds a fence.',
  })
  clear(
    @Param('assetId', zodPipe(assetIdParamSchema)) assetId: string,
    @Body(zodPipe(transferClearanceSchema)) dto: TransferClearanceDto,
  ): Promise<TransferClearanceView> {
    return this.clearance.clear(assetId, dto);
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
