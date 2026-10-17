import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowService, zodPipe } from '@rasta/nest-common';
import { DISPATCH_FENCE_CALLER, ReturnDispatchFenceService } from './dispatch-fence';
import {
  withdrawDispatchSchema,
  type DispatchWithdrawalView,
  type ReturnRequestShipmentView,
  type WithdrawDispatchDto,
} from './dto';

const CALLER_RULE =
  'Reserved for `marketplace-service`’s service token, sent in `X-Internal-Token` with no ' +
  '`Authorization` header and signed for the return request’s **supplier** — the organization in ' +
  'whose books its shipment would be; every other service and every user token is 403, and so is ' +
  'a token signed for no organization.';

/**
 * The internal routes the owner of return requests asks (ADR-061 § 4, Q-133 (9)). See
 * `dispatch-fence.ts`. HTTP ↔ DTO only (AGENTS.md A-10).
 */
@ApiTags('return-requests-internal')
@Controller({ path: 'internal/return-requests', version: '1' })
export class InternalReturnRequestController {
  constructor(private readonly fence: ReturnDispatchFenceService) {}

  @Get(':id/return-shipment')
  @AllowService(DISPATCH_FENCE_CALLER)
  @ApiOperation({
    summary: 'State whether a return request has a return shipment here (internal)',
    description:
      `${CALLER_RULE} Answers the return shipment recorded for the request, whatever its status, ` +
      'or `returnShipment: null` when there is none — never 404, so a missing route or a proxy ' +
      'can never be read as "none". Asked by marketplace before an AUTHORIZED return is ' +
      'cancelled (Q-133 (9)). Nothing is written.',
  })
  shipmentOf(@Param('id') id: string): Promise<ReturnRequestShipmentView> {
    return this.fence.shipmentOf(id);
  }

  @Post(':id/dispatch-withdrawal')
  @HttpCode(200)
  @AllowService(DISPATCH_FENCE_CALLER)
  @ApiOperation({
    summary:
      'Withdraw a dispatch reservation of a return request, unless it has a shipment (internal)',
    description:
      `${CALLER_RULE} Under the lock a return shipment of the request is recorded under: if the ` +
      'request has a return shipment here, `outcome: DISPATCHED` names it and nothing is ' +
      'written; otherwise the reservation is recorded as withdrawn (`outcome: WITHDRAWN`) and no ' +
      'return shipment carrying it is ever recorded — a later dispatch under it is 409 ' +
      '`RETURN_DISPATCH_WITHDRAWN`. Idempotent: a reservation already withdrawn answers as it ' +
      'was. Marketplace releases its reservation only on WITHDRAWN (Q-133 (9)(a)). No ' +
      'Idempotency-Key: the withdrawal is its own idempotency.',
  })
  withdraw(
    @Param('id') id: string,
    @Body(zodPipe(withdrawDispatchSchema)) dto: WithdrawDispatchDto,
  ): Promise<DispatchWithdrawalView> {
    return this.fence.withdraw(id, dto);
  }
}
