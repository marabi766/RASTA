import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowService, RastaError, Roles, zodPipe } from '@rasta/nest-common';
import { WalletService } from './wallet.service';
import { PaymentService } from '../payment/payment.service';
import { IdempotencyStore } from '../shared/idempotency';
import { assertNotAuditor, assertWalletVisible } from '../access/access';
import { toHoldView, toWalletView, type HoldRow, type WalletRow } from '../shared/views';
import {
  listHoldsQuerySchema,
  walletQuerySchema,
  type ListHoldsQuery,
  type WalletQuery,
} from './dto';
import { topUpSchema, type TopUpDto } from '../payment/dto';

/**
 * The wallet API (docs/06 § 6.10).
 *
 * ## Two rules visible in every decorator on this class
 *
 * **`AUDITOR` appears in no `@Roles` list, anywhere.** The product document
 * gives the province oversight role aggregate access only, "بدون دسترسی به
 * جزئیات تراکنش‌های فردی" (docs/09 § 9.3, docs/10 § 10.13). It is enforced at
 * the gateway, here, and again in `access.ts` — three times, because a rule
 * this consequential should not depend on one file staying correct.
 *
 * **Every unsafe endpoint requires an `Idempotency-Key`.** A retried top-up
 * that charges twice is the failure this exists to prevent (docs/06 § 6.8).
 * The gateway rejects a missing key at the edge; this class rejects it again,
 * because a service must not depend on its caller having been filtered.
 */
@ApiTags('wallets')
@Controller({ path: 'wallets', version: '1' })
export class WalletController {
  constructor(
    private readonly wallets: WalletService,
    private readonly payments: PaymentService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  // ---- Provider disclosure -------------------------------------------------

  /**
   * What payment provider is configured, and whether it moves real money.
   *
   * Declared *before* `:id`, because Nest matches routes in declaration order
   * and `provider` would otherwise be read as a wallet id.
   *
   * This endpoint exists because ADR-024 requires the simulated nature of MVP
   * payments to be visible "در کد، UI، مستند، Demo یا ارائه". A UI cannot show
   * "حالت نمایشی" honestly unless it can ask.
   */
  @Get('provider')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'Which payment provider is in use, and whether it is simulated',
    description:
      'In this MVP the provider is always simulated: there is no bank connection, no custody ' +
      'of funds and no real money movement (ADR-024). A client showing a payment flow must ' +
      'surface this.',
  })
  provider() {
    assertNotAuditor();
    return this.payments.describeProvider();
  }

  // ---- Reads ---------------------------------------------------------------

  @Get('me')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @AllowService('marketplace-service', 'contract-service', 'procurement-service')
  @ApiOperation({
    summary: 'The active organization wallet, opening it on first use',
    description:
      'Returns available, pending and total balances. `available` is what can be spent now; ' +
      '`pending` is what is committed to obligations and sits in escrow. Both are derived from ' +
      'the ledger, and `available = total − pending` is enforced by a database constraint ' +
      '(ADR-034).',
  })
  async me(@Query(zodPipe(walletQuerySchema)) query: WalletQuery) {
    assertNotAuditor();
    const wallet = await this.wallets.getOrOpen(query.currency);
    return toWalletView(wallet as WalletRow);
  }

  @Get(':id')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'One wallet',
    description: 'Returns 404 for a wallet in another organization — never 403.',
  })
  async get(@Param('id') id: string) {
    const wallet = await this.wallets.getById(id);
    assertWalletVisible(wallet);
    return toWalletView(wallet as WalletRow);
  }

  @Get(':id/holds')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'Escrow holds on this wallet',
    description:
      'Filter by `status`. An ACTIVE hold is money committed to an obligation and not yet ' +
      'settled; the sum of them is the wallet pending balance.',
  })
  async holds(
    @Param('id') id: string,
    @Query(zodPipe(listHoldsQuerySchema)) query: ListHoldsQuery,
  ) {
    const wallet = await this.wallets.getById(id);
    assertWalletVisible(wallet);
    const rows = await this.wallets.listHolds(id, query.status);
    return { items: rows.map((row) => toHoldView(row as HoldRow)) };
  }

  // ---- Writes --------------------------------------------------------------

  @Post(':id/top-up')
  @HttpCode(201)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'Add funds through the payment provider — simulated in this MVP',
    description:
      '**No real money moves.** The provider is a deterministic simulation (ADR-024); the ' +
      'response says so on every call. Requires an `Idempotency-Key`: a retry returns the ' +
      'first response and does not charge again. The wallet is credited only on capture, ' +
      'never on authorisation, so a failed capture leaves no balance to claw back.',
  })
  async topUp(
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(zodPipe(topUpSchema.omit({ idempotencyKey: true }).partial({ instrument: true })))
    body: Omit<TopUpDto, 'idempotencyKey'>,
  ) {
    assertNotAuditor();
    const key = requireIdempotencyKey(idempotencyKey);

    return this.idempotency.run('POST /v1/wallets/:id/top-up', key, body, 201, async () => {
      const result = await this.payments.topUp(id, { ...body, idempotencyKey: key });
      return {
        paymentIntentId: result.paymentIntentId,
        transactionId: result.transactionId,
        journalId: result.journalId,
        status: result.status,
        amountMinor: result.amountMinor.toString(),
        currency: result.currency,
        provider: result.provider,
        simulated: result.simulated,
        ...(result.failureReason ? { failureReason: result.failureReason } : {}),
        balances: result.balances
          ? {
              ledgerBalanceMinor: result.balances.ledgerBalanceMinor.toString(),
              pendingBalanceMinor: result.balances.pendingBalanceMinor.toString(),
              availableBalanceMinor: result.balances.availableBalanceMinor.toString(),
            }
          : null,
      };
    });
  }
}

/**
 * Refuses an unsafe financial request that carries no idempotency key.
 *
 * `400 VALIDATION_FAILED`, exactly as docs/06 § 6.8's table specifies. The
 * gateway already rejects it at the edge; this is the same check inside the
 * service, because Zero Trust means a service does not assume it was only
 * reached through the gateway (ADR-020).
 */
export function requireIdempotencyKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key || key.length < 8) {
    throw RastaError.validation(
      [
        {
          path: 'headers.idempotency-key',
          message: 'An Idempotency-Key of at least 8 characters is required on financial writes',
        },
      ],
      'Missing Idempotency-Key',
    );
  }
  return key;
}
