import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AllowService } from '@rasta/nest-common';
import { RFQ_EVIDENCE_CALLER, RfqEvidenceService, type RfqChainView } from './rfq-evidence.service';

/**
 * An RFQ's quotation-receipt chain and head (ADR-070 § 4, ADR-066 § 2-3), internal.
 *
 * Under `/v1/internal/…`, a first path segment the gateway routes nowhere, so it is
 * unreachable from outside the cluster by construction; `@AllowService` and
 * `assertRfqEvidenceCaller` close it inside. HTTP to service only.
 */
@ApiTags('audit-internal')
@Controller({ path: 'internal/rfq-evidence', version: '1' })
export class RfqEvidenceController {
  constructor(private readonly evidence: RfqEvidenceService) {}

  @Get(':rfqId/chain')
  @AllowService(RFQ_EVIDENCE_CALLER)
  @ApiParam({
    name: 'rfqId',
    schema: { type: 'string', maxLength: 128, pattern: '^[0-9A-Za-z_-]+$' },
  })
  @ApiOperation({
    summary: 'An RFQ’s quotation-receipt chain and its head, as announced (internal)',
    description:
      'Reserved for `procurement-service` with a token signed for the buyer’s (RFQ owner’s) ' +
      'organization; every other service, every user token and a token signed for no ' +
      'tenant are refused. The lookup is scoped by that organization and the RFQ, so ' +
      'another organization’s RFQ answers as if nothing was announced. The head is ' +
      'held here, outside procurement-service’s database, so opening quotations can be ' +
      'checked against something it cannot rewrite. Digests and identifiers only. An ' +
      'unknown RFQ answers an empty chain whose head is the genesis.',
  })
  chain(@Param('rfqId') rfqId: string): Promise<RfqChainView> {
    return this.evidence.chainOf(rfqId);
  }
}
