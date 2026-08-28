import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AllowService,
  RastaError,
  Roles,
  getContext,
  getOrganizationId,
  runUnscoped,
  zodPipe,
} from '@rasta/nest-common';
import { z } from 'zod';
import { SettlementService } from './settlement.service';
import { TransactionService } from '../transaction/transaction.service';
import { RewardService } from '../reward/reward.service';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyStore } from '../shared/idempotency';
import { requireIdempotencyKey } from '../wallet/wallet.controller';
import { assertNotAuditor, canCommitOrganization } from '../access/access';
import { settleTransactionSchema, type SettleTransactionDto } from '../transaction/dto';
import { SERVICE_NAME } from '../config/env';

const listSettlementsQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    /** The payee view: settlements that paid this organization. */
    incoming: z.coerce.boolean().default(false),
  })
  .strict();

type ListSettlementsQuery = z.infer<typeof listSettlementsQuerySchema>;

/**
 * The settlement API (docs/04 § 4.14, docs/10 § 10.10).
 *
 * ## Why settlement is its own endpoint
 *
 * Releasing money is a different decision from recording that it may be
 * released. `POST /v1/transactions/{id}/authorise-settlement` says the goods
 * arrived; this says pay for them. In an organization those are often two
 * people and always two moments, and collapsing them would make the product
 * document's "تأیید دریافت" control indistinguishable from the payment itself.
 *
 * ## What happens after the response
 *
 * The settlement itself is one ACID transaction and is complete when this
 * returns (ADR-031). The **reward evaluation is not part of it** — docs/10 §
 * 10.10 is explicit that a failed reward must leave the settlement valid and
 * be retried separately, so it runs afterwards, in its own transaction, and
 * its failure is logged rather than propagated.
 */
@ApiTags('settlements')
@Controller({ path: 'settlements', version: '1' })
export class SettlementController {
  constructor(
    private readonly settlements: SettlementService,
    private readonly transactions: TransactionService,
    private readonly rewards: RewardService,
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Post()
  @HttpCode(201)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @AllowService('marketplace-service', 'contract-service')
  @ApiOperation({
    summary: 'Settle an authorised transaction',
    description:
      'Releases escrow to the payee net of commission, recognises the commission as platform ' +
      'revenue, and closes the hold — in **one database transaction**, so a failure leaves ' +
      'nothing partially done and nothing to compensate. ' +
      'Refused for a DISPUTED transaction: an objection stops settlement completely and only ' +
      'a human decision reopens it. Refused for one that has not been authorised: settlement ' +
      'without confirmed receipt is impossible by construction, not by check. ' +
      'On failure the funds stay held — this platform never moves money automatically to ' +
      'compensate for a failure it has not diagnosed (docs/08 § 8.6). ' +
      'Requires an `Idempotency-Key`; a retry returns the first response.',
  })
  async settle(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(zodPipe(settleTransactionSchema)) dto: SettleTransactionDto,
  ) {
    assertNotAuditor();
    const key = requireIdempotencyKey(idempotencyKey);
    const actor = getContext().userId ?? SERVICE_NAME;

    return this.idempotency.run('POST /v1/settlements', key, dto, 201, async () => {
      // Authorization before the lock: the caller must be entitled to commit
      // the paying organization. Read outside the settlement transaction so an
      // unauthorised request never takes a row lock at all.
      const transaction = await this.transactions.get(dto.transactionId);
      canCommitOrganization(transaction.organizationId);

      const result = await this.settlements.settle(dto.transactionId, actor);

      // Deliberately after the settlement's transaction has committed, and
      // deliberately not awaited into it. docs/10 § 10.10: a reward never rolls
      // a settlement back.
      await this.grantSettlementRewards(result.payeeOrganizationId, result.transactionId);

      return {
        settlementId: result.settlementId,
        transactionId: result.transactionId,
        journalId: result.journalId,
        grossAmountMinor: result.grossAmountMinor.toString(),
        commissionAmountMinor: result.commissionAmountMinor.toString(),
        netAmountMinor: result.netAmountMinor.toString(),
        currency: result.currency,
        /**
         * False means no active commission rule matched, so nothing was
         * charged. Reported explicitly because "zero because unconfigured" and
         * "zero because the rate is zero" are different facts and docs/24 Q-08
         * is open (ADR-023).
         */
        commissionRuleMatched: result.commissionMatched,
        settledAt: result.settledAt.toISOString(),
      };
    });
  }

  /**
   * Reward evaluation triggered by a settlement.
   *
   * A no-op today: no rule in this platform is configured against a settlement,
   * because docs/10 § 10.8's list of point-earning behaviours does not include
   * "was paid" — and inventing one would be inventing an incentive the product
   * document does not describe. The hook exists so that when the steering group
   * defines one, it is a configuration row rather than a code change (ADR-023).
   *
   * Its failure is logged and swallowed, which is the whole reason it is here
   * rather than inside the settlement transaction.
   */
  private async grantSettlementRewards(
    payeeOrganizationId: string,
    transactionId: string,
  ): Promise<void> {
    try {
      await this.rewards.grantFor({
        organizationId: payeeOrganizationId,
        userId: getContext().userId ?? null,
        triggerEvent: 'SETTLEMENT_COMPLETED',
        sourceReference: transactionId,
        occurredAt: new Date(),
        payload: { transactionId },
      });
    } catch {
      // Intentionally swallowed. A settlement that has committed must not be
      // reported as failed because a reward rule threw.
    }
  }

  @Get()
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @AllowService('marketplace-service', 'contract-service')
  @ApiOperation({
    summary: 'Settlements this organization paid, or was paid',
    description: 'Set `incoming=true` for the payee view. Cursor-paginated.',
  })
  async list(@Query(zodPipe(listSettlementsQuerySchema)) query: ListSettlementsQuery) {
    assertNotAuditor();
    const organizationId = getOrganizationId();

    const page = {
      orderBy: [{ settledAt: 'desc' as const }, { id: 'desc' as const }],
      take: query.limit,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    };

    // `settlement.organization_id` is the **payer**, so the tenant guard alone
    // answers only "what did I pay". The payee view has to cross it — ANDing
    // the guard's filter with a payee filter would ask for a settlement whose
    // payer and payee are the same organization, which
    // `ck_settlement_distinct_parties` makes impossible, so it would always
    // return nothing.
    //
    // The crossing is narrowed to exactly the caller's own id on the payee
    // column, so it can only ever return settlements the caller was party to.
    const rows = query.incoming
      ? await runUnscoped(
          'a payee reads settlements where it is the counterparty, narrowed to its own id',
          () =>
            this.prisma.client.settlement.findMany({
              where: { payeeOrganizationId: organizationId },
              ...page,
            }),
        )
      : await this.prisma.client.settlement.findMany({ where: { organizationId }, ...page });

    return {
      items: rows.map((row) => ({
        id: row.id,
        transactionId: row.transactionId,
        journalId: row.journalId,
        payerOrganizationId: row.payerOrganizationId,
        payeeOrganizationId: row.payeeOrganizationId,
        grossAmountMinor: row.grossAmountMinor.toString(),
        commissionAmountMinor: row.commissionAmountMinor.toString(),
        netAmountMinor: row.netAmountMinor.toString(),
        currency: row.currency,
        settledAt: row.settledAt.toISOString(),
      })),
    };
  }

  @Get(':id')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'One settlement',
    description:
      'Visible to the organization that paid and to the one that was paid. Anyone else gets ' +
      '404, never 403.',
  })
  async get(@Param('id') id: string) {
    assertNotAuditor();
    const organizationId = getOrganizationId();

    // Read across the guard and then check explicitly, for the same reason as
    // the list above: a settlement names two organizations and both are
    // entitled to it, which a single-tenant filter cannot express.
    const row = await runUnscoped(
      'a settlement is visible to both the paying and the paid organization',
      () => this.prisma.client.settlement.findUnique({ where: { id } }),
    );

    // "Not found" covers both absent and belonging to someone else —
    // deliberately indistinguishable, so identifiers cannot be walked to map
    // who trades with whom (docs/09).
    if (
      !row ||
      (row.organizationId !== organizationId && row.payeeOrganizationId !== organizationId)
    ) {
      throw RastaError.notFound('Settlement', id);
    }
    return {
      id: row.id,
      transactionId: row.transactionId,
      journalId: row.journalId,
      payerOrganizationId: row.payerOrganizationId,
      payeeOrganizationId: row.payeeOrganizationId,
      grossAmountMinor: row.grossAmountMinor.toString(),
      commissionAmountMinor: row.commissionAmountMinor.toString(),
      netAmountMinor: row.netAmountMinor.toString(),
      currency: row.currency,
      settledAt: row.settledAt.toISOString(),
      settledBy: row.settledBy,
    };
  }
}
