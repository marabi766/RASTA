import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AllowService } from '@rasta/nest-common';
import {
  TENDER_EVIDENCE_CALLER,
  TenderEvidenceService,
  type TenderChainView,
} from './tender-evidence.service';

/**
 * The tender's receipt chain and head (ADR-066 § 2-3), internal.
 *
 * Under `/v1/internal/…`, a first path segment the gateway routes nowhere, so it is
 * unreachable from outside the cluster by construction; `@AllowService` and
 * `assertEvidenceCaller` close it inside. HTTP to service only.
 */
@ApiTags('audit-internal')
@Controller({ path: 'internal/tender-evidence', version: '1' })
export class TenderEvidenceController {
  constructor(private readonly evidence: TenderEvidenceService) {}

  @Get(':tenderId/chain')
  @AllowService(TENDER_EVIDENCE_CALLER)
  @ApiParam({
    name: 'tenderId',
    schema: { type: 'string', maxLength: 128, pattern: '^[0-9A-Za-z_-]+$' },
  })
  @ApiOperation({
    summary: 'A tender’s bid-receipt chain and its head, as announced (internal)',
    description:
      'Reserved for `construction-service` with a token signed for no tenant; every other ' +
      'service, every user token and a tenant-signed token are refused. The head is held ' +
      'here, outside construction-service’s database, so opening bids can be checked ' +
      'against something it cannot rewrite. Digests and identifiers only. An unknown ' +
      'tender answers an empty chain whose head is the genesis.',
  })
  chain(@Param('tenderId') tenderId: string): Promise<TenderChainView> {
    return this.evidence.chainOf(tenderId);
  }
}
