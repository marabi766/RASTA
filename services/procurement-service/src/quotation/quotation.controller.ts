import { Body, Controller, Headers, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePlatformUserId, zodPipe } from '@rasta/nest-common';
import { IdempotencyStore, requiredIdempotencyKey } from '../shared/idempotency';
import {
  putQuotationSchema,
  withdrawQuotationSchema,
  type PutQuotationDto,
  type QuotationReceiptView,
  type WithdrawQuotationDto,
} from './dto';
import { QuotationService } from './quotation.service';

/** The route templates the idempotency store keys on: a closed set, never an id. */
export const PUT_QUOTATION_ENDPOINT = 'PUT /v1/rfqs/{id}/quotations/mine';
export const WITHDRAW_QUOTATION_ENDPOINT = 'POST /v1/rfqs/{id}/quotations/mine/withdraw';

const IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  required: true,
  description: '8 to 255 characters. Scoped to the organization.',
} as const;

const SUPPLIER_NOTE =
  'An invited supplier’s person only: a role PROCUREMENT_SUPPLIER_ROLES names (default SUPPLIER) ' +
  'in the organization the RFQ invites — another role is 403 before anything is read; AUDITOR, the ' +
  'platform administrator (even beside SUPPLIER) and a service token are 403. An RFQ that does not ' +
  'invite the caller’s organization, of any other organization, or that does not exist is the same ' +
  '404, and nothing is written (S-03). Before the deadline only: the RFQ is share-locked, then the ' +
  'database clock read — at or after quotationClosingAt, or an RFQ no longer PUBLISHED, is 422 ' +
  'QUOTATION_WINDOW_CLOSED, also when the database refuses the write on its own clock. Requires an ' +
  '`Idempotency-Key` (docs/06 § 6.8; 400 without one): the same key with the same request from the ' +
  'same user answers the original receipt; with another request or user 409 ' +
  'IDEMPOTENCY_KEY_REUSED. The request is recognised by a keyed, salted digest bound to the ' +
  'organization and the user, never a plain hash of the price. The answer is the receipt and the ' +
  'state, never the content (ADR-066 § 4); no price, answer or note reaches an event or a log.';

/**
 * An invited supplier's sealed quotation on an RFQ (ADR-070 § 4, plan PR 8). HTTP ↔ DTO only
 * (A-10); who may act and when is `QuotationService`.
 */
@ApiTags('rfqs')
@Controller({ path: 'rfqs', version: '1' })
export class QuotationController {
  constructor(
    private readonly quotations: QuotationService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @RequirePlatformUserId()
  @Put(':id/quotations/mine')
  @HttpCode(200)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: 'Seal the caller organization’s quotation on an RFQ, or its next revision',
    description:
      'Without expectedRevision, the first quotation (one per organization and RFQ: 409 ' +
      'ALREADY_EXISTS when it has one, a withdrawn one included); with it, the next revision of ' +
      'the caller’s own (none: 404; moved: 409 OPTIMISTIC_LOCK_FAILED; withdrawn: 422 ' +
      'QUOTATION_NOT_SUBMITTED; past PROCUREMENT_QUOTATION_MAX_REVISIONS: 422 ' +
      'QUOTATION_REVISION_LIMIT). The content is judged against the RFQ before anything is sealed ' +
      'or written: one answer per criterion (422 UNKNOWN_CRITERION / CRITERION_UNANSWERED), and ' +
      'unitPriceMinor × the RFQ’s totalQuantity at most 2^63 − 1 (422 ' +
      'QUOTATION_AMOUNT_OUT_OF_RANGE). The supplier’s standing is then asked of supplier-service ' +
      '— an approved GOODS_SUPPLY qualification and no open suspension, or 422 ' +
      'SUPPLIER_NOT_ELIGIBLE; unreachable 503 UPSTREAM_UNAVAILABLE, slower than ' +
      'PROCUREMENT_SUPPLIER_REQUEST_TIMEOUT_MS 504 — and the instant of its answer kept with the ' +
      'receipt. The content is sealed under the RFQ’s key (ADR-066 § 2), the RFQ’s receipt chain ' +
      'extended (ADR-066 § 3), and QUOTATION_SUBMITTED / QUOTATION_REVISED published with the ' +
      `receipt, its predecessor and the digests. ${SUPPLIER_NOTE}`,
  })
  async put(
    @Param('id') id: string,
    @Body(zodPipe(putQuotationSchema)) dto: PutQuotationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<QuotationReceiptView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<QuotationReceiptView>(
      PUT_QUOTATION_ENDPOINT,
      key,
      { id, ...dto },
      200,
      (fence) => this.quotations.put(id, dto, fence),
      (stored) => this.quotations.assertReplayVisible(stored),
      this.quotations.requestHasher(),
    );
    return result;
  }

  @RequirePlatformUserId()
  @Post(':id/quotations/mine/withdraw')
  @HttpCode(200)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: 'Withdraw the caller organization’s quotation on an RFQ',
    description:
      'SUBMITTED → WITHDRAWN at the revision the caller read (moved: 409 OPTIMISTIC_LOCK_FAILED; ' +
      'already withdrawn: 422 QUOTATION_NOT_SUBMITTED; none: 404). Final: no second quotation on ' +
      'the RFQ. The standing is not asked again. QUOTATION_WITHDRAWN names the quotation and the ' +
      `revision; it extends no receipt chain. ${SUPPLIER_NOTE}`,
  })
  async withdraw(
    @Param('id') id: string,
    @Body(zodPipe(withdrawQuotationSchema)) dto: WithdrawQuotationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<QuotationReceiptView> {
    const key = requiredIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<QuotationReceiptView>(
      WITHDRAW_QUOTATION_ENDPOINT,
      key,
      { id, ...dto },
      200,
      (fence) => this.quotations.withdraw(id, dto, fence),
      (stored) => this.quotations.assertReplayVisible(stored),
      this.quotations.requestHasher(),
    );
    return result;
  }
}
