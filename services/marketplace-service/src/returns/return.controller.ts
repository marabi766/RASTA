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
import { IdempotencyStore, requireIdempotencyKey, targeted } from '../shared/idempotency';
import {
  createReturnSchema,
  decideReturnSchema,
  listReturnsQuerySchema,
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
 * (the buyer withdraws — ADR-048 § 3 allows `CANCELLED` before `RESOLVED`).
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
      'buying organization may.',
  })
  cancel(@Param('id') id: string, @Headers('idempotency-key') idempotencyKey?: string) {
    return this.command(
      'POST /v1/returns/:id/cancellation',
      'cancel',
      id,
      undefined,
      idempotencyKey,
    );
  }

  /**
   * One decision on one existing request: run it at most once. The request id (and the decision,
   * where there is a body) is part of the request identity ({@link targeted}), so one key reused on
   * another request — or for the other decision — is `409 IDEMPOTENCY_KEY_REUSED`, not a replay of
   * the first one's response.
   */
  private async command(
    endpoint: string,
    command: Exclude<ReturnCommand, 'request'>,
    id: string,
    body: DecideReturnDto | undefined,
    idempotencyKey: string | undefined,
  ): Promise<ReturnRequestView> {
    const key = requireIdempotencyKey(idempotencyKey);
    const { result } = await this.idempotency.execute<ReturnRequestView>(
      endpoint,
      key,
      targeted(id, body),
      200,
      (record) => this.returns[command](id, key, record),
      () => this.returns.assertReplayVisible(id, command),
    );
    return result;
  }
}
