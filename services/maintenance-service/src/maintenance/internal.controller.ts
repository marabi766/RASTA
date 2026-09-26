import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AllowService, zodPipe } from '@rasta/nest-common';
import {
  MaintenanceFactService,
  SOURCE_FACT_CALLER,
  requestIdParamSchema,
  type MaintenanceRequestFactView,
} from './source-fact';

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
