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
import { IdempotencyStore, targeted } from '../shared/idempotency';
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
 * ## Why the transition routes declare 200 explicitly
 *
 * Nest answers a POST with 201 by default, which would be wrong twice over
 * here: these commands change an existing order rather than creating anything,
 * and the status recorded for an idempotent replay is 200 — so the default
 * meant a retry answered with a different status than the original call. Only
 * `POST /orders` and `POST /orders/{id}/reviews` create a resource, and only
 * those two return 201.
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
  @HttpCode(HttpStatus.OK)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'SUPPLIER', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'Accept an order',
    description: 'The supplier accepts. Only the supplying organization may.',
  })
  async confirm(@Param('id') id: string, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.command('POST /v1/orders/:id/confirm', id, idempotencyKey, undefined, {
      work: () => this.orders.confirm(id),
      signal: ['orderConfirmed'],
    });
  }

  @Post(':id/fulfill')
  @HttpCode(HttpStatus.OK)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'SUPPLIER', 'ORGANIZATION_ADMIN')
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
    return this.command('POST /v1/orders/:id/fulfill', id, idempotencyKey, dto, {
      work: () => this.orders.fulfill(id, dto),
      signal: ['orderFulfilled'],
    });
  }

  @Post(':id/confirm-receipt')
  @HttpCode(HttpStatus.OK)
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
    return this.command('POST /v1/orders/:id/confirm-receipt', id, idempotencyKey, dto, {
      work: () => this.orders.confirmReceipt(id, dto),
      signal: ['receiptConfirmed'],
    });
  }

  @Post(':id/disputes')
  @HttpCode(HttpStatus.OK)
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
    return this.command('POST /v1/orders/:id/disputes', id, idempotencyKey, dto, {
      work: () => this.orders.raiseDispute(id, dto),
      signal: ['orderDisputed', dto.reason],
    });
  }

  @Post(':id/disputes/resolve')
  @HttpCode(HttpStatus.OK)
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
    return this.command('POST /v1/orders/:id/disputes/resolve', id, idempotencyKey, dto, {
      work: () => this.orders.resolveDispute(id, dto),
      signal: ['disputeResolved', dto.outcome],
    });
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
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
    return this.command('POST /v1/orders/:id/cancel', id, idempotencyKey, dto, {
      work: () => this.orders.cancel(id, dto),
      signal: ['orderCancelled', dto.reason],
    });
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
    return this.idempotency.run('POST /v1/orders/:id/reviews', key, targeted(id, dto), 201, () =>
      this.orders.submitReview(id, dto),
    );
  }

  /**
   * One command on one existing order: run it at most once, then tell the saga.
   *
   * Written once so that the two properties below cannot be forgotten by the
   * next route. Both exist because of one defect: the key was stored under the
   * route template and hashed over the body alone, and the saga was signalled
   * unconditionally for the URL's id. A buyer who confirmed receipt on its own
   * order X with key K could send the same K and body to
   * `/orders/Y/confirm-receipt`, get X's stored response — so no party check
   * and no transition check ever ran against Y — and still deliver
   * `receiptConfirmed` to Y's saga, any tenant's. With `cancel` the saga's
   * compensation then refunded Y's money while Y's order row never moved.
   *
   * **The order id is part of the request identity** ({@link targeted}). Key K
   * reused on another order is the documented `409 IDEMPOTENCY_KEY_REUSED`,
   * not a replay.
   *
   * **The saga is signalled only when the command ran in this request.** A
   * replay ran nothing, so it has nothing to tell the saga: the original
   * request already signalled, and signalling again would hand the workflow a
   * command no check approved — a replayed dispute, arriving after the dispute
   * was resolved, would halt a settlement the operator had released. A signal
   * lost in the original request is the workflow's to recover, by re-reading
   * the order on its timer (ADR-039), not a client retry's. The workflow does
   * not do that re-read yet; it is tracked with the saga's other failure
   * windows.
   */
  private async command<T>(
    endpoint: string,
    id: string,
    idempotencyKey: string | undefined,
    body: unknown,
    step: { work: () => Promise<T>; signal: [name: string, ...args: unknown[]] },
  ): Promise<T> {
    const key = requireIdempotencyKey(idempotencyKey);
    const { result, executed } = await this.idempotency.execute(
      endpoint,
      key,
      targeted(id, body),
      200,
      step.work,
    );
    if (executed) await this.saga.signal(id, ...step.signal);
    return result;
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
