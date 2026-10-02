import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, zodPipe } from '@rasta/nest-common';
import { IdempotencyStore, targeted } from '../shared/idempotency';
import { requireIdempotencyKey } from '../wallet/wallet.controller';
import { assertNotAuditor } from '../access/access';
import {
  PaymentReconciliationOperator,
  type OperatorActor,
} from './payment-reconciliation.operator';
import {
  operatorDecisionSchema,
  proposeResolutionSchema,
  type OperatorDecisionDto,
  type ProposeResolutionDto,
} from './dto';

/**
 * The operator path for an unfinished refund the reconciler escalated
 * (ADR-064 § 6, step B3). It replaces the runbook's manual UPDATE.
 *
 * The role ceiling here is the widest configuration may grant
 * (`SYSTEM_ADMIN`, `UNION_ADMIN`); the operator narrows it to
 * `ECONOMIC_PAYMENT_RECONCILIATION_RESOLVER_ROLES` — `SYSTEM_ADMIN` by
 * default (Q-82). Every write requires an `Idempotency-Key`.
 */
@ApiTags('payment-intents')
@Controller({ path: 'payment-intents', version: '1' })
export class PaymentReconciliationController {
  constructor(
    private readonly operator: PaymentReconciliationOperator,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Get(':id/reconciliation')
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'The reconciliation of one payment intent: its task and every resolution',
    description:
      'What the reconciler last observed (`lastOutcome`, `attempts`), whether a person has ' +
      'it (`ESCALATED`), and every operator resolution proposed for it, newest first.',
  })
  view(@Param('id') id: string) {
    assertNotAuditor();
    return this.operator.view(id);
  }

  @Post(':id/reconciliation/requeue')
  @HttpCode(200)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Put an open reconciliation task back for the reconciler, due now',
    description:
      'Attempts reset; the reconciler asks the provider again. Moves no money, so one ' +
      'resolver is enough. Refused (409) while the reconciler holds the task, while a ' +
      'resolution awaits approval, or when there is no open task.',
  })
  requeue(
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(zodPipe(operatorDecisionSchema)) dto: OperatorDecisionDto,
  ) {
    // Authorization first, then the replay (Codex on #175, MED 3): a cached
    // answer goes only to a resolver, and only to the one who made it.
    const actor = this.operator.authorize();
    const key = requireIdempotencyKey(idempotencyKey);
    return this.idempotency.run(
      'POST /v1/payment-intents/:id/reconciliation/requeue',
      key,
      targeted(id, boundTo(actor, dto)),
      200,
      () => this.operator.requeue(id, dto.reason),
    );
  }

  @Post(':id/reconciliation/resolutions')
  @HttpCode(200)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Propose a resolution: what the provider did, on evidence',
    description:
      'Records the provider’s outcome as the evidence shows it — `REFUNDED`, `DECLINED` or ' +
      '`NOT_REACHED` — with a mandatory evidence reference. Moves nothing: the resolution is ' +
      '`PENDING_APPROVAL` until a second resolver, neither the proposer nor the payment’s ' +
      'creator, approves it. Refused with 422 for an outcome that is already known, or for a ' +
      'refund out of a wallet that is not active; 409 ALREADY_EXISTS while another awaits ' +
      'approval.',
  })
  propose(
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(zodPipe(proposeResolutionSchema)) dto: ProposeResolutionDto,
  ) {
    // Authorization first, then the replay (Codex on #175, MED 3): a cached
    // answer goes only to a resolver, and only to the one who made it.
    const actor = this.operator.authorize();
    const key = requireIdempotencyKey(idempotencyKey);
    return this.idempotency.run(
      'POST /v1/payment-intents/:id/reconciliation/resolutions',
      key,
      targeted(id, boundTo(actor, dto)),
      200,
      () => this.operator.propose(id, dto),
    );
  }

  @Post(':id/reconciliation/resolutions/:resolutionId/approve')
  @HttpCode(200)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Approve a proposed resolution — the only step that moves money',
    description:
      'By a second resolver: never the proposer, never the payment’s creator (403). Applies ' +
      'the outcome through the reconciler’s own path, under the same locks. Refused with 409 ' +
      'while the reconciler holds the task or once the resolution is decided, and with 422 ' +
      'for a refund out of a wallet that is not active — the resolution then stays pending.',
  })
  approve(
    @Param('id') id: string,
    @Param('resolutionId') resolutionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(zodPipe(operatorDecisionSchema)) dto: OperatorDecisionDto,
  ) {
    // Authorization first, then the replay (Codex on #175, MED 3): a cached
    // answer goes only to a resolver, and only to the one who made it.
    const actor = this.operator.authorize();
    const key = requireIdempotencyKey(idempotencyKey);
    return this.idempotency.run(
      'POST /v1/payment-intents/:id/reconciliation/resolutions/:resolutionId/approve',
      key,
      targeted(`${id}/${resolutionId}`, boundTo(actor, dto)),
      200,
      () => this.operator.approve(id, resolutionId, dto.reason),
    );
  }

  @Post(':id/reconciliation/resolutions/:resolutionId/reject')
  @HttpCode(200)
  @Roles('SYSTEM_ADMIN', 'UNION_ADMIN')
  @ApiOperation({
    summary: 'Reject a proposed resolution',
    description: 'By a second resolver, as for approval. Moves nothing; a new proposal may follow.',
  })
  reject(
    @Param('id') id: string,
    @Param('resolutionId') resolutionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(zodPipe(operatorDecisionSchema)) dto: OperatorDecisionDto,
  ) {
    // Authorization first, then the replay (Codex on #175, MED 3): a cached
    // answer goes only to a resolver, and only to the one who made it.
    const actor = this.operator.authorize();
    const key = requireIdempotencyKey(idempotencyKey);
    return this.idempotency.run(
      'POST /v1/payment-intents/:id/reconciliation/resolutions/:resolutionId/reject',
      key,
      targeted(`${id}/${resolutionId}`, boundTo(actor, dto)),
      200,
      () => this.operator.reject(id, resolutionId, dto.reason),
    );
  }
}

/**
 * The request a key is bound to: the body and who sent it. The same key from
 * another person is then a different request — `409 IDEMPOTENCY_KEY_REUSED`,
 * with no body — never a replay of someone else's answer.
 */
function boundTo(actor: OperatorActor, body: unknown): unknown {
  return { by: { userId: actor.userId, issuer: actor.issuer, subject: actor.subject }, body };
}
