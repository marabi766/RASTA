import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import { TenderOpenService } from './tender-open.service';
import { listBidAccessLogQuerySchema, type ListBidAccessLogQuery } from './bid-opening.dto';

const OWNER_NOTE =
  'Owner side: the roles of CONSTRUCTION_TENDER_OPEN_ROLES, by default the tender owner’s role set ' +
  '(CONSTRUCTION_PROJECT_ROLES) — docs/24 Q-85, ADR-066 § 4. SYSTEM_ADMIN, AUDITOR and CONTRACTOR (each ' +
  'refused whenever present, whatever other role the user holds), a service token and a member of any ' +
  'organization that bid on the tender (on every route here, the access log included; judged on the ' +
  'token and on identity-service now, which cannot be reached: 502/504, nothing shown) are refused. A ' +
  'tender of another organization answers 404, never 403, whatever roles the caller holds: ownership ' +
  'is checked before any role, so a contractor of another organization gets exactly what a missing ' +
  'tender gets; the attempt is logged under its owner. 403 is only ever answered to a member of the ' +
  'owning organization.';

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
  @RequirePlatformUserId()
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
      'every standing bid becomes OPENED and the tender EVALUATING, with BIDS_OPENED (a count and a ' +
      'digest of the bid ids only; the ids are read with GET /tenders/:id/bids). With four-eyes on ' +
      '(CONSTRUCTION_TENDER_OPEN_FOUR_EYES, default true — Q-91, provisional) this call is the ' +
      'second person’s approval of a proposal another user made: no proposal is 422 ' +
      '`PROPOSAL_REQUIRED`, the proposer approving their own is 422 `SECOND_PERSON_REQUIRED` — the ' +
      'same person under another user id included (issuer and subject are compared, #188) — and a ' +
      'proposal that names no stable identity is 422 `ACTOR_IDENTITY_UNKNOWN` and is cleared by that ' +
      'approval (`BID_OPENING_PROPOSAL_WITHDRAWN`, reason `PROPOSER_IDENTITY_UNKNOWN`) so that anyone ' +
      'eligible may propose again. A token without `rasta_uid` is 403 on this route, on proposing and on withdrawing. ' +
      'Opening again answers the same view with `alreadyOpened: true` and writes nothing. ' +
      `${AUDIT_NOTE} ${OWNER_NOTE}`,
  })
  async open(@Param('id') id: string) {
    return this.opening.open(id);
  }

  @Post('tenders/:id/open-bids/proposal')
  @RequirePlatformUserId()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Propose opening the bids of a CLOSED tender (four-eyes, the first person)',
    description:
      'Records that the caller proposes opening the bids; a second authorised user then approves with ' +
      '`POST /tenders/:id/open-bids`. The first proposal stands: proposing again answers it with ' +
      '`alreadyProposed: true`. Neither proposer nor approver may be a member of an organization that ' +
      'bid. Reads and opens nothing; a tender not yet CLOSED is 422 `NOT_CLOSED`. ' +
      OWNER_NOTE,
  })
  async propose(@Param('id') id: string) {
    return this.opening.proposeOpening(id);
  }

  @Post('tenders/:id/open-bids/proposal/withdraw')
  @RequirePlatformUserId()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw the proposal to open the bids (four-eyes; the proposer only)',
    description:
      'The proposer takes their proposal back, so another eligible user can propose afresh; nobody ' +
      'else may (403). The proposer is recognised by the user id they proposed under or, where it ' +
      'shows them, by their stable identity (issuer and subject, #188). No proposal is 422 `NO_PROPOSAL`; a tender not CLOSED, or already opened, is ' +
      '422 `NOT_CLOSED`. Audited like the proposal (an access row, BID_ACCESSED) with ' +
      '`BID_OPENING_PROPOSAL_WITHDRAWN`. An approval that finds the proposer a member of a bidding ' +
      'organization refuses (403) and clears the proposal the same way, as does one that finds no ' +
      'stable identity on record for the proposer (422 `ACTOR_IDENTITY_UNKNOWN`, reason ' +
      '`PROPOSER_IDENTITY_UNKNOWN`). ' +
      OWNER_NOTE,
  })
  async withdrawProposal(@Param('id') id: string) {
    return this.opening.withdrawProposal(id);
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
      'purpose (OPEN_BIDS, PROPOSE_OPENING, WITHDRAW_PROPOSAL, COUNT_BIDS, LIST_BIDS, READ_BID, OWN_BID_RECEIPT) and the outcome — never ' +
      `content. Reading the log is not itself logged. ${OWNER_NOTE}`,
  })
  async accessLog(
    @Param('id') id: string,
    @Query(zodPipe(listBidAccessLogQuerySchema)) query: ListBidAccessLogQuery,
  ) {
    return this.opening.listAccessLog(id, query);
  }
}
