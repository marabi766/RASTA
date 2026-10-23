import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowService } from '@rasta/nest-common';
import { DISPATCH_SOURCE_CALLER, ReturnDispatchSourceService } from './dispatch-source';
import type { ReturnDispatchSourceView } from './dto';

/** The route templates, for the documentation: a closed set, never an id. */
export const RETURN_DISPATCH_READ_ENDPOINT = 'GET /v1/internal/returns/{id}';
export const RETURN_DISPATCH_RESERVE_ENDPOINT =
  'POST /v1/internal/returns/{id}/dispatch-reservation';

const CALLER_RULE =
  'Reserved for `inventory-service`’s service token, sent in `X-Internal-Token` with no ' +
  '`Authorization` header and signed for the **supplier** — the organization that receives the ' +
  'goods; every other service and every user token is 403, and so is a token signed for no ' +
  'organization. A request of any other supplier (its buyer included) answers 404, exactly as one ' +
  'that does not exist.';

/**
 * The internal source-of-truth routes of a return request, for the service that records its goods
 * (ADR-061 § 4, Q-133 (5)). See `dispatch-source.ts`. HTTP ↔ DTO only (AGENTS.md A-10).
 */
@ApiTags('returns-internal')
@Controller({ path: 'internal/returns', version: '1' })
export class InternalReturnController {
  constructor(private readonly source: ReturnDispatchSourceService) {}

  @Get(':id')
  @AllowService(DISPATCH_SOURCE_CALLER)
  @ApiOperation({
    summary: 'State a return request as its owner records it, for dispatch (internal)',
    description:
      `${CALLER_RULE} Returns the stored request, whatever its status: its order, buyer, ` +
      'supplier, status, lines (order line, product, quantity), when its dispatch was reserved, ' +
      'and whether this deployment accepts a shipment naming fewer lines or units than were ' +
      'authorized (MARKETPLACE_RETURN_PARTIAL_DISPATCH_ALLOWED, Q-133 (8)). Never the buyer’s ' +
      'reason. The reader checks a shipment against this answer and must refuse a request that ' +
      'is not AUTHORIZED. Nothing is written.',
  })
  read(@Param('id') id: string): Promise<ReturnDispatchSourceView> {
    return this.source.read(id);
  }

  @Post(':id/dispatch-reservation')
  @HttpCode(HttpStatus.OK)
  @AllowService(DISPATCH_SOURCE_CALLER)
  @ApiOperation({
    summary: 'Reserve the dispatch of an AUTHORIZED return request (internal)',
    description:
      `${CALLER_RULE} Under the request’s row lock — the lock a cancellation takes — records that ` +
      'the supplier’s inventory is about to send its goods: from then on the buyer cannot cancel ' +
      'it, even while it still reads AUTHORIZED (Q-133 (5)). Each reservation has its own id ' +
      '(`dispatchReservationId`, `RDR_<ULID>`): the shipment is recorded under it, and a ' +
      'reconciliation withdraws exactly it (Q-133 (9)(a)). Idempotent: a reserved request ' +
      'answers as it stands. A request that is not AUTHORIZED — not yet decided, rejected, ' +
      'cancelled, or already moved on by its shipment’s event — is 422 BUSINESS_RULE_VIOLATION ' +
      'and nothing is written. No body; answers the request as `GET` does.',
  })
  reserve(@Param('id') id: string): Promise<ReturnDispatchSourceView> {
    return this.source.reserve(id);
  }
}
