import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AllowService, zodPipe } from '@rasta/nest-common';
import {
  SOURCE_FACT_CALLER,
  UsageFactService,
  usageRecordIdParamSchema,
  type UsageRecordFactView,
} from './source-fact';

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
