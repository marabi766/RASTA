import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowService, Roles, zodPipe } from '@rasta/nest-common';
import { TransactionService } from './transaction.service';
import { IdempotencyStore } from '../shared/idempotency';
import { requireIdempotencyKey } from '../wallet/wallet.controller';
import { assertNotAuditor } from '../access/access';
import {
  toTransactionDetailView,
  toTransactionView,
  type TransactionRowLike,
} from '../shared/views';
import {
  cancelTransactionSchema,
  createTransactionSchema,
  disputeTransactionSchema,
  listTransactionsQuerySchema,
  refundTransactionSchema,
  resolveDisputeSchema,
  type CancelTransactionDto,
  type CreateTransactionDto,
  type DisputeTransactionDto,
  type ListTransactionsQuery,
  type RefundTransactionDto,
  type ResolveDisputeDto,
} from './dto';

/**
 * The transaction API (docs/06 § 6.10).
 *
 * ## Why the lifecycle is four verbs rather than one PATCH
 *
 * `authorise`, `dispute`, `resolve-dispute` and `refund` are domain acts with
 * different authority behind them, not field updates. docs/06 § 6.10 asks for
 * explicit verbs precisely here: a `PATCH { "status": "SETTLED" }` would make
 * settling a transaction look like editing a record, and would put the state
 * machine's rules in the hands of whoever composed the body.
 *
 * Settlement itself is **not** here. It lives at `POST /v1/settlements`
 * (docs/04 § 4.14), because releasing money is a different decision from
 * recording that it may be released — often taken by a different person.
 *
 * ## Every unsafe route here requires an `Idempotency-Key`
 *
 * Including the four that move no money — `authorise-settlement`, `dispute`,
 * `resolve-dispute` and `cancel`. Two reasons, and the second is the one that
 * settled it:
 *
 *   - each is an **irreversible effect** in docs/06 § 6.8's sense: authorising
 *     settlement is what lets money move afterwards, and a dispute halts it
 *     indefinitely.
 *   - the gateway applies `requiresIdempotencyKey` to a whole prefix, because
 *     teaching it which verb under `transactions` moves money would put domain
 *     knowledge in the routing layer — the "hidden monolith" ADR-009 exists to
 *     prevent. So the service accepting a key on some routes and refusing it
 *     on others would make the gateway's rule wrong rather than coarse.
 *
 * Live verification found this: the gateway rejected `authorise-settlement`
 * for a missing key that this controller had no way to accept.
 *
 * ## Service callers
 *
 * `@AllowService('marketplace-service', 'contract-service')` on the paths
 * docs/08 § 8.6 calls as Saga Activities. That is the documented integration
 * for the order flow, and it is what lets the whole hold → settle → commission
 * → reward cycle be exercised today without marketplace-service existing
 * (ADR-032).
 */
@ApiTags('transactions')
@Controller({ path: 'transactions', version: '1' })
export class TransactionController {
  constructor(
    private readonly transactions: TransactionService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  // ---- Reads ---------------------------------------------------------------

  @Get()
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @AllowService('marketplace-service', 'contract-service', 'procurement-service')
  @ApiOperation({
    summary: 'List transactions, newest first',
    description:
      'By default the transactions this organization owes. Set `includeIncoming=true` for the ' +
      'payee view — what it is owed. Filter by status, type, source reference and an ' +
      '`occurredAt` window. Cursor-paginated.',
  })
  async list(@Query(zodPipe(listTransactionsQuerySchema)) query: ListTransactionsQuery) {
    assertNotAuditor();
    const result = await this.transactions.list({
      ...query,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
    return {
      items: result.items.map((row) => toTransactionView(row as TransactionRowLike)),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  @Get(':id')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @AllowService('marketplace-service', 'contract-service', 'procurement-service')
  @ApiOperation({
    summary: 'One transaction, with its legs, commission and settlement',
    description:
      'Visible to the payer and to the payee. Anyone else gets 404, never 403 — a 403 would ' +
      'confirm that the transaction exists.',
  })
  async get(@Param('id') id: string) {
    const transaction = await this.transactions.get(id);
    return toTransactionDetailView(transaction as never);
  }

  // ---- Writes --------------------------------------------------------------

  @Post()
  @HttpCode(201)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @AllowService('marketplace-service', 'contract-service', 'procurement-service')
  @ApiOperation({
    summary: 'Record an obligation, optionally holding the funds for it',
    description:
      'With `holdFunds=true` the money is moved into escrow in the same transaction, so there ' +
      'is no window in which the obligation exists and the funds are still spendable. ' +
      'Refused with 422 INSUFFICIENT_BALANCE if the wallet cannot cover it — and the whole ' +
      'request rolls back, leaving no orphaned obligation. Requires an `Idempotency-Key`.',
  })
  async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(zodPipe(createTransactionSchema)) dto: CreateTransactionDto,
  ) {
    assertNotAuditor();
    const key = requireIdempotencyKey(idempotencyKey);

    return this.idempotency.run('POST /v1/transactions', key, dto, 201, async () => {
      const created = await this.transactions.create({ ...dto, idempotencyKey: key });
      return toTransactionDetailView(created as never);
    });
  }

  @Post(':id/authorise-settlement')
  @HttpCode(200)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @AllowService('marketplace-service', 'contract-service')
  @ApiOperation({
    summary: 'Confirm receipt — authorise the transaction to be settled',
    description:
      'The product document control: settlement happens after the user confirms receipt ' +
      '(docs/10 § 10.5). Separate from settlement itself, because confirming that goods ' +
      'arrived and releasing the money are two decisions, often by two people.',
  })
  async authorise(
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    assertNotAuditor();
    const key = requireIdempotencyKey(idempotencyKey);

    return this.idempotency.run(
      'POST /v1/transactions/:id/authorise-settlement',
      key,
      { id },
      200,
      async () =>
        toTransactionDetailView((await this.transactions.authoriseSettlement(id)) as never),
    );
  }

  @Post(':id/dispute')
  @HttpCode(200)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @AllowService('marketplace-service')
  @ApiOperation({
    summary: 'Register an objection — settlement stops completely',
    description:
      'A registered objection halts settlement entirely and indefinitely (docs/10 § 10.5). ' +
      'There is no timeout that clears it and no automatic resolution: the state machine has ' +
      'no path from DISPUTED to SETTLED. A human resolves it, or the funds are refunded.',
  })
  async dispute(
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(zodPipe(disputeTransactionSchema)) dto: DisputeTransactionDto,
  ) {
    assertNotAuditor();
    const key = requireIdempotencyKey(idempotencyKey);

    return this.idempotency.run('POST /v1/transactions/:id/dispute', key, dto, 200, async () =>
      toTransactionDetailView((await this.transactions.dispute(id, dto)) as never),
    );
  }

  @Post(':id/resolve-dispute')
  @HttpCode(200)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN')
  @AllowService('marketplace-service')
  @ApiOperation({
    summary: 'Resolve a dispute back into the settlement queue',
    description:
      'Records who decided and what they decided, and unblocks settlement. It does not settle: ' +
      'releasing the money stays a separate, deliberate act. ' +
      'Reachable by marketplace-service, whose order saga mirrors a dispute onto the ' +
      'transaction and must be able to mirror the resolution back — otherwise a dispute ' +
      'decided in the supplier’s favour could never settle. The decision itself is still a ' +
      'platform-operator act: marketplace-service only reaches here after its own ' +
      '`assertDisputeResolver` has required a platform role of the person who decided.',
  })
  async resolveDispute(
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(zodPipe(resolveDisputeSchema)) dto: ResolveDisputeDto,
  ) {
    assertNotAuditor();
    const key = requireIdempotencyKey(idempotencyKey);

    return this.idempotency.run(
      'POST /v1/transactions/:id/resolve-dispute',
      key,
      dto,
      200,
      async () =>
        toTransactionDetailView((await this.transactions.resolveDispute(id, dto)) as never),
    );
  }

  @Post(':id/refund')
  @HttpCode(200)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @AllowService('marketplace-service')
  @ApiOperation({
    summary: 'Return escrowed funds to the payer',
    description:
      'The cancellation branch of the hold cycle (docs/10 § 10.5). Posts a refund journal ' +
      'rather than reversing the hold: the hold really happened and was then cancelled, and an ' +
      'auditor needs to be able to tell those apart. Requires an `Idempotency-Key`.',
  })
  async refund(
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(zodPipe(refundTransactionSchema)) dto: RefundTransactionDto,
  ) {
    assertNotAuditor();
    const key = requireIdempotencyKey(idempotencyKey);

    return this.idempotency.run(`POST /v1/transactions/:id/refund`, key, dto, 200, async () => {
      const result = await this.transactions.refund(id, dto.reason);
      return toTransactionDetailView(result as never);
    });
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN')
  @AllowService('marketplace-service')
  @ApiOperation({
    summary: 'Abandon a transaction nothing has moved against',
    description:
      'Only from CREATED. Once funds are held the correct act is a refund, which returns them ' +
      'explicitly rather than leaving them in escrow behind a cancelled obligation.',
  })
  async cancel(
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(zodPipe(cancelTransactionSchema)) dto: CancelTransactionDto,
  ) {
    assertNotAuditor();
    const key = requireIdempotencyKey(idempotencyKey);

    return this.idempotency.run('POST /v1/transactions/:id/cancel', key, dto, 200, async () =>
      toTransactionDetailView((await this.transactions.cancel(id, dto.reason)) as never),
    );
  }
}
