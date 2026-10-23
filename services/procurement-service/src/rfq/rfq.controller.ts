import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import { IdempotencyStore, requiredIdempotencyKey } from '../shared/idempotency';
import type { CursorPage } from '../demand/dto';
import {
  cancelRfqSchema,
  issueRfqSchema,
  listRfqsQuerySchema,
  type CancelRfqDto,
  type IssueRfqDto,
  type ListRfqsQuery,
  type RfqView,
} from './dto';
import { RfqService } from './rfq.service';

/** The route templates the idempotency store keys on: a closed set, never an id. */
export const ISSUE_RFQ_ENDPOINT = 'POST /v1/aggregations/{id}/rfq';
export const CLOSE_RFQ_ENDPOINT = 'POST /v1/rfqs/{id}/close';
export const CANCEL_RFQ_ENDPOINT = 'POST /v1/rfqs/{id}/cancel';

const IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  required: true,
  description: '8 to 255 characters. Scoped to the organization.',
} as const;

const COMMAND_NOTE =
  'Requires an `Idempotency-Key` (docs/06 § 6.8): without one, or with one outside 8 to 255 ' +
  'characters, 400 VALIDATION_FAILED and nothing is done. The same key with the same request from ' +
  'the same user answers the original response and does nothing again; the same key with another ' +
  'request or user is 409 IDEMPOTENCY_KEY_REUSED; a duplicate that arrives while the first is ' +
  'still being processed waits for its answer and past a few seconds is 409 CONFLICT with ' +
  'Retry-After. The caller must be a signed-in person with a platform user id (403 otherwise).';

const BUYER_COMMAND_NOTE =
  'The buyer’s own RFQ only, by a role PROCUREMENT_RFQ_ISSUER_ROLES names (default ' +
  'ORGANIZATION_ADMIN) in its organization: another role of the buyer is 403 INSUFFICIENT_ROLE; an ' +
  'invited supplier, any third organization and an id that does not exist are the same 404 (S-03). ' +
  'AUDITOR, the platform administrator and a service token are refused (403) before anything is read.';

const READ_NOTE =
  'The buyer reads its own RFQs by a role PROCUREMENT_DEMAND_ROLES or PROCUREMENT_RFQ_ISSUER_ROLES ' +
  'names (`docs/09`: PROCUREMENT_USER has rfq:read); another role of the buyer is 403. An invited ' +
  'supplier reads the RFQs that invite its organization, by a role PROCUREMENT_SUPPLIER_ROLES ' +
  'names (default SUPPLIER): the product, the total quantity, the criteria and the deadline — never ' +
  'the other invitees, the cancellation’s text, nor who registered the demands. Anyone else — an ' +
  'organization the RFQ does not invite, a third organization, an id that does not exist — gets the ' +
  'same 404 (S-03). AUDITOR, the platform administrator (SYSTEM_ADMIN) and a service token are ' +
  'refused (403) before anything is read.';

/**
 * Issuing an RFQ from a READY aggregation (ADR-070 § 3, plan PR 6). HTTP ↔ DTO only (A-10); who
 * may act is `ProcurementAccess`, from configuration.
 */
@ApiTags('aggregations')
@Controller({ path: 'aggregations', version: '1' })
export class AggregationRfqController {
  constructor(
    private readonly rfqs: RfqService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @RequirePlatformUserId()
  @Post(':id/rfq')
  @HttpCode(201)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary:
      'Issue the RFQ of a READY aggregation: READY → RFQ_ISSUED and a PUBLISHED RFQ, at once',
    description:
      'A human command — nothing is issued automatically (ADR-070 § 3, ADR-043). procurementNature, ' +
      'quotationClosingAt, the criteria and the invitees are required and have no default. Before ' +
      'anything is written: the aggregation as the caller read it (`expectedVersion` that is not ' +
      'the current version is 409 OPTIMISTIC_LOCK_FAILED; one that is not READY 422 ' +
      'AGGREGATION_NOT_READY; a READY one whose end is still being recorded 409 CONFLICT with ' +
      'Retry-After); each invited organization’s standing, asked of supplier-service now — an ' +
      'approved GOODS_SUPPLY qualification and no open suspension, or 422 INVITEE_NOT_ELIGIBLE; ' +
      'supplier-service unreachable or answering anything but its contract is 503 ' +
      'UPSTREAM_UNAVAILABLE (504 UPSTREAM_TIMEOUT past PROCUREMENT_SUPPLIER_REQUEST_TIMEOUT_MS), ' +
      'and nothing is written; the buyer itself is 422 INVITEE_IS_BUYER, more than ' +
      'PROCUREMENT_RFQ_MAX_INVITEES (default 200) 422 INVITEE_LIMIT_EXCEEDED. The RFQ’s sealing ' +
      'key pair is made then, its private half wrapped by a KEK of PROCUREMENT_RFQ_KEKS (none ' +
      'configured: 503). Then, under the aggregation’s row lock, the same checks again, the ' +
      'deadline against the database clock (not after it: 422 QUOTATION_CLOSING_NOT_IN_FUTURE), and ' +
      'in one transaction the RFQ with its frozen criteria and invitations, the aggregation READY → ' +
      'RFQ_ISSUED and RFQ_ISSUED (identifiers, the quantity, the nature, the deadline, the invitees, ' +
      'the criteria by count and digest — never a label). One RFQ per aggregation. ' +
      'The caller holds a role PROCUREMENT_RFQ_ISSUER_ROLES names (default ORGANIZATION_ADMIN) in ' +
      'the organization the request acts for — any other role is 403 INSUFFICIENT_ROLE before ' +
      'anything is read — and the aggregation is that organization’s: one of any other ' +
      'organization and one that does not exist are both 404 (S-03). AUDITOR, the platform ' +
      `administrator and a service token are refused (403) before anything is read. ${COMMAND_NOTE}`,
  })
  async issue(
    @Param('id') id: string,
    @Body(zodPipe(issueRfqSchema)) dto: IssueRfqDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<RfqView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<RfqView>(
      ISSUE_RFQ_ENDPOINT,
      key,
      { id, ...dto },
      201,
      (fence) => this.rfqs.issue(id, dto, fence),
      (stored) => this.rfqs.assertIssueVisible(stored.id),
    );
    return result;
  }
}

/** The RFQ API (ADR-070 § 3, § 10; plan PR 6): reads for both sides, the buyer's close and cancel. */
@ApiTags('rfqs')
@Controller({ path: 'rfqs', version: '1' })
export class RfqController {
  constructor(
    private readonly rfqs: RfqService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List RFQs, newest first: the caller organization’s (side=BUYER) or the ones it is invited to (side=SUPPLIER)',
    description: `side is required. ${READ_NOTE}`,
  })
  async list(
    @Query(zodPipe(listRfqsQuerySchema)) query: ListRfqsQuery,
  ): Promise<CursorPage<RfqView>> {
    return this.rfqs.listRfqs(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Read one RFQ, as its buyer or as an invited supplier',
    description: READ_NOTE,
  })
  async get(@Param('id') id: string): Promise<RfqView> {
    return this.rfqs.getRfq(id);
  }

  @RequirePlatformUserId()
  @Post(':id/close')
  @HttpCode(200)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: 'Close an RFQ at or after its quotation deadline',
    description:
      'PUBLISHED → CLOSED, only at or after quotationClosingAt by the database clock read under the ' +
      'RFQ’s lock (before it: 422 QUOTATION_DEADLINE_NOT_REACHED). The command the close sweeper ' +
      'runs on its own within PROCUREMENT_RFQ_CLOSE_SWEEP_INTERVAL_MS of the deadline; idempotent — ' +
      'an RFQ already closed answers as it is, with no second RFQ_CLOSED. A cancelled RFQ is 422 ' +
      'RFQ_CANCELLED. Closing discloses nothing and needs no new role. ' +
      `${BUYER_COMMAND_NOTE} ${COMMAND_NOTE}`,
  })
  async close(
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<RfqView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<RfqView>(
      CLOSE_RFQ_ENDPOINT,
      key,
      { id },
      200,
      (fence) => this.rfqs.close(id, fence),
      (stored) => this.rfqs.assertCommandVisible(stored.id),
    );
    return result;
  }

  @RequirePlatformUserId()
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: 'Cancel an RFQ, with a closed reason code and a reason',
    description:
      'Any status but AWARDED → CANCELLED (ADR-070 § 3): an AWARDED or CANCELLED RFQ is 422 ' +
      'RFQ_NOT_CANCELLABLE; `expectedVersion` that is not the current version is 409 ' +
      'OPTIMISTIC_LOCK_FAILED. The aggregation stays RFQ_ISSUED (Q-121 (4)): its requesters ' +
      'register new demands. RFQ_CANCELLED carries the code, never the reason. ' +
      `${BUYER_COMMAND_NOTE} ${COMMAND_NOTE}`,
  })
  async cancel(
    @Param('id') id: string,
    @Body(zodPipe(cancelRfqSchema)) dto: CancelRfqDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<RfqView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<RfqView>(
      CANCEL_RFQ_ENDPOINT,
      key,
      { id, ...dto },
      200,
      (fence) => this.rfqs.cancel(id, dto, fence),
      (stored) => this.rfqs.assertCommandVisible(stored.id),
    );
    return result;
  }
}
