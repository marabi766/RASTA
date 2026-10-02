import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { zodPipe } from '@rasta/nest-common';
import { TenderOpenService } from './tender-open.service';
import { listBidAccessLogQuerySchema, type ListBidAccessLogQuery } from './bid-opening.dto';

const OWNER_NOTE =
  'Owner side: the roles of CONSTRUCTION_TENDER_OPEN_ROLES, by default the tender owner’s role set ' +
  '(CONSTRUCTION_PROJECT_ROLES) — docs/24 Q-85, ADR-066 § 4. SYSTEM_ADMIN, AUDITOR, a service token and ' +
  'a member of any organization that bid on the tender are refused. A tender of another organization ' +
  'answers 404, never 403, and the attempt is logged under its owner.';

const AUDIT_NOTE =
  'Every call is audited in the same transaction: a bid_access_log row and BID_ACCESSED per bid read, ' +
  'with the purpose and the outcome; a refused call commits a REFUSED row and then answers the refusal.';

/**
 * The owner's side of the bids of a tender: opening them, reading them, and the log of
 * who read them (ADR-065, ADR-066 § 4-5). HTTP ↔ DTO and nothing else (AGENTS.md A-10).
 */
@ApiTags('bids')
@Controller({ version: '1' })
export class BidOpeningController {
  constructor(private readonly opening: TenderOpenService) {}

  @Post('tenders/:id/open-bids')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Open the bids of a CLOSED tender (CLOSED → EVALUATING)',
    description:
      'Only after the tender is CLOSED, judged on the database clock after the tender lock; a tender ' +
      'still PUBLISHED, even past its deadline, is 422 (BUSINESS_RULE_VIOLATION, `NOT_CLOSED`) — closing ' +
      'is the sweeper’s. The receipt chain and its head are read from audit-service (a request signed ' +
      'for the owner’s organization and the tender) and every bid is opened against **those** receipts, ' +
      'never against this service’s own: audit-service unreachable is 503/504 (UPSTREAM_UNAVAILABLE), ' +
      'not yet caught up with the newest receipts is 503 (retry), and a chain or a bid that differs ' +
      'from the evidence is 422 `INTEGRITY` — nothing is opened in any of them. Opening is atomic: ' +
      'every standing bid becomes OPENED and the tender EVALUATING, with BIDS_OPENED (ids and counts ' +
      'only). Opening again answers the same view with `alreadyOpened: true` and writes nothing. ' +
      `${AUDIT_NOTE} ${OWNER_NOTE}`,
  })
  async open(@Param('id') id: string) {
    return this.opening.open(id);
  }

  @Get('tenders/:id/bids')
  @ApiOperation({
    summary: 'The tender’s bids as the owner may see them',
    description:
      'Before the opening: how many bids stand and when each was received — not who, not what; the ' +
      'key is not touched. After it: every opened bid with its content, read again from the sealed ' +
      'bytes against audit-service’s receipts on every call (same refusals as opening). ' +
      `${AUDIT_NOTE} ${OWNER_NOTE}`,
  })
  async list(@Param('id') id: string) {
    return this.opening.listBids(id);
  }

  @Get('tenders/:id/bids/:bidId')
  @ApiOperation({
    summary: 'One opened bid, with its content',
    description:
      'Before the opening there is nothing to read: 422 `NOT_OPENED`. A bid that does not exist, or ' +
      `was withdrawn, is 404. ${AUDIT_NOTE} ${OWNER_NOTE}`,
  })
  async get(@Param('id') id: string, @Param('bidId') bidId: string) {
    return this.opening.getBid(id, bidId);
  }

  @Get('tenders/:id/bid-access-log')
  @ApiOperation({
    summary: 'Who read the tender’s bids, and why',
    description:
      'The append-only log of every read, granted or refused, newest first: the reader, a closed ' +
      'purpose (OPEN_BIDS, COUNT_BIDS, LIST_BIDS, READ_BID, OWN_BID_RECEIPT) and the outcome — never ' +
      `content. Reading the log is not itself logged. ${OWNER_NOTE}`,
  })
  async accessLog(
    @Param('id') id: string,
    @Query(zodPipe(listBidAccessLogQuerySchema)) query: ListBidAccessLogQuery,
  ) {
    return this.opening.listAccessLog(id, query);
  }
}
