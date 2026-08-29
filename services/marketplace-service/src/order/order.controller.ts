import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RastaError, Roles, zodPipe } from '@rasta/nest-common';
import { IdempotencyStore } from '../shared/idempotency';
import { OrderSagaClient } from '../temporal/saga.client';
import { OrderService } from './order.service';
import {
  cancelOrderSchema,
  confirmReceiptSchema,
  createOrderSchema,
  fulfillOrderSchema,
  listOrdersQuerySchema,
  raiseDisputeSchema,
  resolveDisputeSchema,
  submitReviewSchema,
  type CancelOrderDto,
  type ConfirmReceiptDto,
  type CreateOrderDto,
  type FulfillOrderDto,
  type ListOrdersQuery,
  type RaiseDisputeDto,
  type ResolveDisputeDto,
  type SubmitReviewDto,
} from './dto';

/**
 * The order HTTP surface (`docs/06` § Marketplace).
 *
 * ## Two things every unsafe route here does
 *
 * **It requires an `Idempotency-Key`.** The gateway marks the whole `orders`
 * prefix `requiresIdempotencyKey`, and the service requires it again rather
 * than trusting that: a request that reaches this port directly — another
 * service, a port-forward, a future ingress — must not be able to place two
 * orders by retrying.
 *
 * **It writes the state change before it signals the saga.** The database is
 * the source of truth; the signal is a nudge. Reversing that order would let a
 * workflow act on something that never committed.
 *
 * ## Roles
 *
 * `@Roles` is the coarse first filter. Which *organization* may do a thing is
 * decided in `access.ts` against the record, because the gateway and the guard
 * never see it — and in a marketplace every order has two organizations, each
 * of which may do exactly one half of what can be done (S-03).
 */
@ApiTags('orders')
@Controller({ path: 'orders', version: '1' })
export class OrderController {
  constructor(
    private readonly orders: OrderService,
    private readonly saga: OrderSagaClient,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'PROCUREMENT_USER')
  @ApiOperation({
    summary: 'Place an order',
    description:
      'Prices the order from the current server-side offers — a price in the body is ' +
      'refused, not ignored. Requires an `Idempotency-Key`; the same key with the same ' +
      'body returns the original order without placing a second one.',
  })
  async place(
    @Body(zodPipe(createOrderSchema)) dto: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);

    const order = await this.idempotency.run('POST /v1/orders', key, dto, 201, () =>
      this.orders.place(dto, key),
    );

    // After the order is committed. A saga started before the commit could
    // observe an order that then rolls back.
    await this.saga.start(order.id);
    return order;
  }

  @Get()
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'PROCUREMENT_USER', 'SUPPLIER')
  @ApiOperation({
    summary: 'List orders',
    description:
      'Scoped to the caller organization. `role=SUPPLIER` lists orders where the caller ' +
      'is the seller; the default lists orders it placed.',
  })
  async list(@Query(zodPipe(listOrdersQuerySchema)) query: ListOrdersQuery) {
    return this.orders.list(query);
  }

  @Get(':id')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'PROCUREMENT_USER', 'SUPPLIER')
  @ApiOperation({
    summary: 'Read one order',
    description:
      'Either party may read it. An organization that is neither gets 404 rather than ' +
      '403, because refusing by name would confirm the order exists.',
  })
  async get(@Param('id') id: string) {
    return this.orders.get(id);
  }

  @Post(':id/confirm')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'SUPPLIER')
  @ApiOperation({
    summary: 'Accept an order',
    description: 'The supplier accepts. Only the supplying organization may.',
  })
  async confirm(@Param('id') id: string, @Headers('idempotency-key') idempotencyKey?: string) {
    const key = requireIdempotencyKey(idempotencyKey);
    const order = await this.idempotency.run('POST /v1/orders/:id/confirm', key, { id }, 200, () =>
      this.orders.confirm(id),
    );
    await this.saga.signal(id, 'orderConfirmed');
    return order;
  }

  @Post(':id/fulfill')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'SUPPLIER')
  @ApiOperation({
    summary: 'Record fulfilment',
    description:
      'The supplier records delivery. The order then waits for the buyer — nothing here ' +
      'releases money, and no timer will.',
  })
  async fulfill(
    @Param('id') id: string,
    @Body(zodPipe(fulfillOrderSchema)) dto: FulfillOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    const order = await this.idempotency.run('POST /v1/orders/:id/fulfill', key, dto, 200, () =>
      this.orders.fulfill(id, dto),
    );
    await this.saga.signal(id, 'orderFulfilled');
    return order;
  }

  @Post(':id/confirm-receipt')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'PROCUREMENT_USER')
  @ApiOperation({
    summary: 'Confirm receipt',
    description:
      'The only command that permits settlement. Only the **buying** organization may ' +
      'issue it — not the supplier, who would be confirming their own delivery, and not ' +
      'a platform operator, who was not there.',
  })
  async confirmReceipt(
    @Param('id') id: string,
    @Body(zodPipe(confirmReceiptSchema)) dto: ConfirmReceiptDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    const order = await this.idempotency.run(
      'POST /v1/orders/:id/confirm-receipt',
      key,
      dto,
      200,
      () => this.orders.confirmReceipt(id, dto),
    );
    await this.saga.signal(id, 'receiptConfirmed');
    return order;
  }

  @Post(':id/disputes')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'PROCUREMENT_USER')
  @ApiOperation({
    summary: 'Raise a dispute',
    description:
      'Stops settlement completely, on both this service and economic-service. Requires ' +
      'a reason of at least a sentence: whoever resolves it needs to know what it is about.',
  })
  async dispute(
    @Param('id') id: string,
    @Body(zodPipe(raiseDisputeSchema)) dto: RaiseDisputeDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    const order = await this.idempotency.run('POST /v1/orders/:id/disputes', key, dto, 200, () =>
      this.orders.raiseDispute(id, dto),
    );
    await this.saga.signal(id, 'orderDisputed');
    return order;
  }

  @Post(':id/disputes/resolve')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Resolve a dispute',
    description:
      'A platform operator decides. `SETTLE` returns the order to the settlement path; ' +
      '`REFUND` cancels it and compensates. Neither moves money here.',
  })
  async resolveDispute(
    @Param('id') id: string,
    @Body(zodPipe(resolveDisputeSchema)) dto: ResolveDisputeDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    const order = await this.idempotency.run(
      'POST /v1/orders/:id/disputes/resolve',
      key,
      dto,
      200,
      () => this.orders.resolveDispute(id, dto),
    );
    await this.saga.signal(id, 'disputeResolved', dto.outcome);
    return order;
  }

  @Post(':id/cancel')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'PROCUREMENT_USER')
  @ApiOperation({
    summary: 'Cancel an order',
    description:
      "Moves the order to CANCELLING. The refund is the saga's compensation step, so " +
      'the order is not CANCELLED until the money has actually come back.',
  })
  async cancel(
    @Param('id') id: string,
    @Body(zodPipe(cancelOrderSchema)) dto: CancelOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    const order = await this.idempotency.run('POST /v1/orders/:id/cancel', key, dto, 200, () =>
      this.orders.cancel(id, dto),
    );
    await this.saga.signal(id, 'orderCancelled', dto.reason);
    return order;
  }

  @Post(':id/reviews')
  @HttpCode(HttpStatus.CREATED)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'PROCUREMENT_USER')
  @ApiOperation({
    summary: 'Review a completed order',
    description:
      'Only after the order is COMPLETED, and only once. A rating on an order that was ' +
      'never delivered would be a rating of nothing.',
  })
  async review(
    @Param('id') id: string,
    @Body(zodPipe(submitReviewSchema)) dto: SubmitReviewDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.idempotency.run('POST /v1/orders/:id/reviews', key, dto, 201, () =>
      this.orders.submitReview(id, dto),
    );
  }
}

/**
 * Refuses an unsafe request that arrived without a key.
 *
 * `400 VALIDATION_FAILED` exactly as `docs/06` § 6.8's table specifies. The
 * gateway enforces this for the whole prefix too; both exist because the
 * gateway is not the only way to reach this port.
 */
export function requireIdempotencyKey(value: string | undefined): string {
  if (!value || value.trim().length < 8) {
    throw RastaError.validation(
      [
        {
          path: 'Idempotency-Key',
          code: 'required',
          message: 'This operation requires an Idempotency-Key header of at least 8 characters',
        },
      ],
      'Idempotency-Key is required for this operation',
    );
  }
  return value.trim();
}
