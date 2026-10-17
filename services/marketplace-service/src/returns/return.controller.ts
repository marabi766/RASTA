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
import { Roles, zodPipe } from '@rasta/nest-common';
import {
  IdempotencyStore,
  requireIdempotencyKey,
  targeted,
  type RecordResponse,
} from '../shared/idempotency';
import {
  cancelReturnSchema,
  createReturnSchema,
  decideReturnSchema,
  listReturnsQuerySchema,
  type CancelReturnDto,
  type CreateReturnDto,
  type DecideReturnDto,
  type ListReturnsQuery,
  type ReturnRequestView,
} from './dto';
import type { ReturnCommand } from './return-access';
import { ReturnService } from './return.service';

/**
 * The return-request HTTP surface (`docs/06` § Reverse logistics; ADR-048).
 *
 * `docs/06` plans `POST /v1/orders/{id}/returns`, `GET /v1/returns/{id}` and
 * `POST /v1/returns/{id}/decisions`; this is those three, plus two the table does not list and
 * this change adds: `GET /v1/returns` (a party's own requests) and `POST /v1/returns/{id}/cancellation`
 * (the buyer withdraws — ADR-048 § 3 allows `CANCELLED` before `RESOLVED`), and
 * `POST /v1/returns/{id}/dispatch-reconciliation` (either party asks inventory to settle a dispatch
 * reservation, Q-133 (9)(a)).
 *
 * Every unsafe route requires an `Idempotency-Key`, here as at the gateway (a request that reaches
 * this port directly must not be able to file two requests by retrying), and stores its response
 * with the write. A replay is re-authorized before the stored response is returned (#253).
 *
 * `@Roles` is the coarse first filter; which organization may do a thing is decided against the
 * record in `return-access.ts` — the buyer asks and withdraws, the supplier decides.
 *
 * Nothing here moves money or goods. There is no refund route: a refund is economic-service's, and
 * no return status is one (ADR-048 § 3).
 */
@ApiTags('returns')
@Controller({ path: 'orders/:orderId/returns', version: '1' })
export class OrderReturnsController {
  constructor(
    private readonly returns: ReturnService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'PROCUREMENT_USER')
  @ApiOperation({
    summary: 'Ask to return goods of a completed order',
    description:
      'Only the buying organization, only for a COMPLETED order, and only inside the configured ' +
      'return window (none is configured by default, and then this is refused). Requires an ' +
      '`Idempotency-Key`; the same key with the same body returns the original request.',
  })
  async request(
    @Param('orderId') orderId: string,
    @Body(zodPipe(createReturnSchema)) dto: CreateReturnDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ReturnRequestView> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.idempotency.run<ReturnRequestView>(
      'POST /v1/orders/:id/returns',
      key,
      // The order is part of the request's identity: one key reused on another order is a 409.
      targeted(orderId, dto),
      201,
      (record) => this.returns.request(orderId, dto, key, record),
      (stored) => this.returns.assertRequestReplayVisible(stored.id),
    );
  }
}

@ApiTags('returns')
@Controller({ path: 'returns', version: '1' })
export class ReturnController {
  constructor(
    private readonly returns: ReturnService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Get()
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'PROCUREMENT_USER', 'SUPPLIER')
  @ApiOperation({
    summary: 'List return requests',
    description:
      'Scoped to the caller organization. `role=SUPPLIER` lists requests where the caller is the ' +
      'seller; the default lists requests it made.',
  })
  async list(@Query(zodPipe(listReturnsQuerySchema)) query: ListReturnsQuery) {
    return this.returns.list(query);
  }

  @Get(':id')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'PROCUREMENT_USER', 'SUPPLIER')
  @ApiOperation({
    summary: 'Read one return request',
    description:
      'Either party may read it. An organization that is neither gets 404 rather than 403, ' +
      'because refusing by name would confirm the request exists.',
  })
  async get(@Param('id') id: string) {
    return this.returns.get(id);
  }

  @Post(':id/decisions')
  @HttpCode(HttpStatus.OK)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'SUPPLIER', 'ORGANIZATION_ADMIN')
  @ApiOperation({
    summary: 'Authorize or reject a return',
    description:
      'The supplier agrees to take the goods back (`AUTHORIZE`) or refuses (`REJECT`). Only the ' +
      'supplying organization may. Nothing physical happens and no refund is made: the goods ' +
      'still have to travel, arrive and be inspected (ADR-048 § 3).',
  })
  decide(
    @Param('id') id: string,
    @Body(zodPipe(decideReturnSchema)) dto: DecideReturnDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const command = dto.decision === 'AUTHORIZE' ? 'authorize' : 'reject';
    return this.command('POST /v1/returns/:id/decisions', command, id, dto, idempotencyKey);
  }

  @Post(':id/cancellation')
  @HttpCode(HttpStatus.OK)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'PROCUREMENT_USER')
  @ApiOperation({
    summary: 'Cancel a return request',
    description:
      'The buyer withdraws a REQUESTED or AUTHORIZED return before any goods moved. Only the ' +
      'buying organization may. **Conditional:** the body names the status the caller saw ' +
      '(`expectedStatus`, required, REQUESTED or AUTHORIZED); if the request is in any other ' +
      'status when it is locked — the supplier authorized it after the caller read it, say — ' +
      'the answer is 409 OPTIMISTIC_LOCK_FAILED and nothing is written: read it again and ' +
      'decide again. The expected status is part of the Idempotency-Key fingerprint. Once ' +
      'inventory-service has reserved the dispatch (`dispatchReservedAt` set) the return is no ' +
      'longer cancelled, even while it still reads AUTHORIZED: 422 BUSINESS_RULE_VIOLATION with ' +
      '`details[].code` RETURN_DISPATCH_RESERVED (Q-133 (5)); see `dispatch-reconciliation`. ' +
      'An AUTHORIZED return is cancelled only after inventory-service confirms it holds no ' +
      'shipment for it: one it holds is 422 with `details[].code` RETURN_DISPATCHED, and an ' +
      'inventory that cannot be asked is 503/504 with nothing written (Q-133 (9)).',
  })
  cancel(
    @Param('id') id: string,
    @Body(zodPipe(cancelReturnSchema)) dto: CancelReturnDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.run('POST /v1/returns/:id/cancellation', 'cancel', id, dto, key, (record) =>
      this.returns.cancel(id, dto, key, record),
    );
  }

  @Post(':id/dispatch-reconciliation')
  @HttpCode(HttpStatus.OK)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'PROCUREMENT_USER', 'SUPPLIER')
  @ApiOperation({
    summary: 'Reconcile a return’s dispatch reservation with inventory',
    description:
      'Either party asks inventory-service, the owner of the goods, about a dispatch reservation ' +
      'that stands (`dispatchReservedAt` set) on an AUTHORIZED return — one whose dispatch may ' +
      'have failed after it was reserved (Q-133 (9)(a)). Inventory either names a shipment it ' +
      'holds for the return — the reservation stands: 422 with `details[].code` ' +
      'RETURN_DISPATCHED — or records the reservation as withdrawn, after which a dispatch ' +
      'carrying it is refused there; only then is the reservation released (`dispatchReservedAt` ' +
      '`null`) and the release recorded with who asked and when. Nothing is released by time. ' +
      'No reservation standing: 422 RETURN_DISPATCH_NOT_RESERVED. Inventory that cannot be ' +
      'asked: 503/504, nothing written. No body.',
  })
  reconcileDispatch(@Param('id') id: string, @Headers('idempotency-key') idempotencyKey?: string) {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.run(
      'POST /v1/returns/:id/dispatch-reconciliation',
      'reconcile',
      id,
      undefined,
      key,
      (record) => this.returns.reconcileDispatch(id, key, record),
    );
  }

  private command(
    endpoint: string,
    command: 'authorize' | 'reject',
    id: string,
    body: DecideReturnDto,
    idempotencyKey: string | undefined,
  ): Promise<ReturnRequestView> {
    const key = requireIdempotencyKey(idempotencyKey);
    return this.run(endpoint, command, id, body, key, (record) =>
      this.returns[command](id, key, record),
    );
  }

  /**
   * One command on one existing request: run it at most once. The request id and the body (the
   * decision, the expected status) are part of the request identity ({@link targeted}), so one key
   * reused on another request — or with another body — is `409 IDEMPOTENCY_KEY_REUSED`, not a
   * replay of the first one's response.
   */
  private async run(
    endpoint: string,
    command: Exclude<ReturnCommand, 'request'>,
    id: string,
    body: DecideReturnDto | CancelReturnDto | undefined,
    key: string,
    execute: (record: RecordResponse<ReturnRequestView>) => Promise<ReturnRequestView>,
  ): Promise<ReturnRequestView> {
    const { result } = await this.idempotency.execute<ReturnRequestView>(
      endpoint,
      key,
      targeted(id, body),
      200,
      execute,
      () => this.returns.assertReplayVisible(id, command),
    );
    return result;
  }
}
