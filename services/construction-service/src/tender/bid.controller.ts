import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { zodPipe } from '@rasta/nest-common';
import { BidService } from './bid.service';
import {
  listOpenTendersQuerySchema,
  reviseBidSchema,
  submitBidSchema,
  withdrawBidSchema,
  type ListOpenTendersQuery,
  type ReviseBidDto,
  type SubmitBidDto,
  type WithdrawBidDto,
} from './bid.dto';

const BIDDER_NOTE =
  'Bidder side: the `CONTRACTOR` role in the organization the request acts for (docs/24 Q-85). ' +
  'No other role is accepted — SYSTEM_ADMIN and AUDITOR included, which have no access to a bid ' +
  'through the API (ADR-066 § 4). A tender the caller may not see answers 404, never 403.';

/**
 * The bidder's side of a tender: what it may bid on, and its own bid (ADR-065,
 * ADR-066). HTTP ↔ DTO and nothing else (AGENTS.md A-10).
 */
@ApiTags('bids')
@Controller({ version: '1' })
export class BidController {
  constructor(private readonly bids: BidService) {}

  @Get('open-tenders')
  @ApiOperation({
    summary: 'PUBLISHED tenders the caller’s organization may bid on',
    description:
      'Public tenders, and RESTRICTED ones the organization is invited to — never its own. ' +
      `Newest first. ${BIDDER_NOTE}`,
  })
  async listOpenTenders(@Query(zodPipe(listOpenTendersQuerySchema)) query: ListOpenTendersQuery) {
    return this.bids.listOpenTenders(query);
  }

  @Get('open-tenders/:id')
  @ApiOperation({
    summary: 'One tender the caller may bid on, with its frozen criteria',
    description: `Anything the caller may not bid on is 404. ${BIDDER_NOTE}`,
  })
  async getOpenTender(@Param('id') id: string) {
    return this.bids.getOpenTender(id);
  }

  @Post('tenders/:id/bids')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Submit the caller’s organization’s one bid',
    description:
      'Refused 422 (BUSINESS_RULE_VIOLATION), naming every reason, outside `[bidOpeningAt, ' +
      'bidClosingAt)` judged on the database clock after the tender lock (a bid at the closing ' +
      'instant is refused), while the organization is not eligible (qualified for CONTRACTING and ' +
      'not suspended; an organization unknown to this service is not eligible), for the owner’s own ' +
      'tender, for an unknown criterion code, or for a bid over the size limit. A second bid is 409 ' +
      '(replace it with PUT). The content is sealed to the tender’s key and never returned: the ' +
      'answer is the receipt, the new head of the tender’s chain, also published on BID_SUBMITTED. ' +
      BIDDER_NOTE,
  })
  async submit(@Param('id') id: string, @Body(zodPipe(submitBidSchema)) dto: SubmitBidDto) {
    return this.bids.submit(id, dto);
  }

  @Get('tenders/:id/bids/mine')
  @ApiOperation({
    summary: 'The caller’s own receipt, revision and status on a tender',
    description:
      'No content: before the opening nobody reads it, the bidder included (ADR-066 § 4). Every call ' +
      'is audited in the same transaction — a `bid_access_log` row and BID_ACCESSED, granted or ' +
      'refused; a refused read is logged and then answers 404. ' +
      BIDDER_NOTE,
  })
  async mine(@Param('id') id: string) {
    return this.bids.getMine(id);
  }

  @Put('tenders/:id/bids/:bidId')
  @ApiOperation({
    summary: 'Replace the bid before the deadline (revision + 1)',
    description:
      '`expectedRevision` must equal the bid’s current revision (409 OPTIMISTIC_LOCK_FAILED). The ' +
      'same window, eligibility and sealing rules as the submission; publishes BID_REVISED with the ' +
      `new head. A withdrawn bid cannot be replaced (422). ${BIDDER_NOTE}`,
  })
  async revise(
    @Param('id') id: string,
    @Param('bidId') bidId: string,
    @Body(zodPipe(reviseBidSchema)) dto: ReviseBidDto,
  ) {
    return this.bids.revise(id, bidId, dto);
  }

  @Post('tenders/:id/bids/:bidId/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw the bid before the deadline; terminal',
    description:
      'Serialised against the closing of the tender on its row lock. After the deadline it is 422; ' +
      'there is no return after a withdrawal. Publishes BID_WITHDRAWN. ' +
      BIDDER_NOTE,
  })
  async withdraw(
    @Param('id') id: string,
    @Param('bidId') bidId: string,
    @Body(zodPipe(withdrawBidSchema)) dto: WithdrawBidDto,
  ) {
    return this.bids.withdraw(id, bidId, dto);
  }
}
