import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { PaymentService } from './payment.service';
import { IdempotencyStore } from '../shared/idempotency';
import { requireIdempotencyKey } from '../wallet/wallet.controller';
import { assertNotAuditor } from '../access/access';
import { toPaymentIntentView, type PaymentIntentRow } from '../shared/views';
import {
  listPaymentsQuerySchema,
  refundPaymentSchema,
  type ListPaymentsQuery,
  type RefundPaymentDto,
} from './dto';

/**
 * Payment intents — the record of every attempt to move money across the
 * platform boundary (ADR-024).
 *
 * **Every row this API returns has `simulated: true`.** There is no bank, no
 * PSP and no custody of funds in this MVP. The field is on every response
 * rather than documented once, because a client that renders a payment
 * confirmation without it is making a claim the platform is not allowed to
 * make.
 *
 * Creating an intent is not here: an intent is created by topping a wallet up
 * (`POST /v1/wallets/{id}/top-up`), because a payment with no wallet behind it
 * has nowhere to land.
 */
@ApiTags('payment-intents')
@Controller({ path: 'payment-intents', version: '1' })
export class PaymentController {
  constructor(
    private readonly payments: PaymentService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Get()
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'Payment intents for this organization, newest first',
    description:
      'Every intent carries the provider that handled it and whether that provider was ' +
      'simulated, so a historical payment still says what it was after the platform switches ' +
      'providers.',
  })
  async list(@Query(zodPipe(listPaymentsQuerySchema)) query: ListPaymentsQuery) {
    assertNotAuditor();
    const rows = await this.payments.list(query.limit, query.cursor);
    return { items: rows.map((row) => toPaymentIntentView(row as PaymentIntentRow)) };
  }

  @Get(':id')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({ summary: 'One payment intent' })
  async get(@Param('id') id: string) {
    assertNotAuditor();
    const row = await this.payments.get(id);
    return toPaymentIntentView(row as PaymentIntentRow);
  }

  @Post(':id/refund')
  @HttpCode(200)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Refund a captured top-up',
    description:
      'Posts a **reversal** of the top-up journal — the ledger only correction (AGENTS.md ' +
      'A-06). History is untouched: the top-up and its reversal both remain, which is what an ' +
      'auditor needs to see. Refused with 422 INSUFFICIENT_BALANCE when the money has since ' +
      'been spent, because refunding it would drive the wallet negative. Requires an ' +
      '`Idempotency-Key`.',
  })
  async refund(
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(zodPipe(refundPaymentSchema)) dto: RefundPaymentDto,
  ) {
    assertNotAuditor();
    const key = requireIdempotencyKey(idempotencyKey);

    return this.idempotency.run(`POST /v1/payment-intents/:id/refund`, key, dto, 200, async () => {
      const result = await this.payments.refund(id, dto.reason);
      return {
        paymentIntentId: result.paymentIntentId,
        reversalJournalId: result.reversalJournalId,
        amountMinor: result.amountMinor.toString(),
        currency: result.currency,
        provider: result.provider,
        simulated: result.simulated,
        refundedAt: result.refundedAt.toISOString(),
        balances: {
          ledgerBalanceMinor: result.balances.ledgerBalanceMinor.toString(),
          pendingBalanceMinor: result.balances.pendingBalanceMinor.toString(),
          availableBalanceMinor: result.balances.availableBalanceMinor.toString(),
        },
      };
    });
  }
}
