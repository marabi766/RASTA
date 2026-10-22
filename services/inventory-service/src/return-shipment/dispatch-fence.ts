import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId } from '@rasta/nest-common';
import type { InventoryEnv } from '../config/env';
import { commandTransactionTimeoutMs } from '../config/operation-budgets';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { PrismaService } from '../prisma/prisma.service';
import { transactionNow } from '../shared/clock';
import { boundLockWaits, translateCommandError } from '../shared/command';
import { ENV } from '../tokens';
import {
  internalReturnRequestIdSchema,
  type DispatchWithdrawalView,
  type ReturnRequestShipmentView,
  type WithdrawDispatchDto,
} from './dto';
import { ReturnShipmentRepository } from './return-shipment.repository';

/**
 * What this service holds of a return's goods, for the service that owns the return request
 * (marketplace-service; ADR-048 § 2, ADR-061 § 4, A-13) — and the fence that lets it release a
 * dispatch reservation (Codex r1 on #339, findings 2 and 3; PM ruling on Q-133 (9)(a)).
 *
 * ## Why marketplace asks
 *
 * - **Before cancelling an AUTHORIZED request** it asks whether a shipment exists here. A request
 *   authorized before dispatch reservations existed — or one this service dispatched without
 *   asking — may have goods on the road that marketplace never heard of (its mirror off or behind).
 *   Only this service knows.
 * - **To release a reservation** whose dispatch failed after it was taken, it asks this service to
 *   withdraw it. Under the per-request lock a dispatch takes too, the answer is either the shipment
 *   that exists — the reservation must stand — or the reservation recorded as withdrawn, after
 *   which no shipment carrying it is ever written here (`tg_return_shipment_dispatch_fence`),
 *   however late a delayed dispatch commits. Only that answer lets marketplace release it.
 *
 * ## The lock (marketplace's `dispatch-source.ts` in reverse, ADR-061 § 4)
 *
 * - `/v1/internal/…`, a first path segment the gateway routes nowhere.
 * - `@AllowService` admits no other service (403), and {@link assertDispatchFenceCaller} refuses
 *   every *user* token (403) too.
 * - The organization is the one **signed into** the internal token (ADR-035): the request's
 *   supplier, in whose books its shipment would be. A token signed for no organization is 403
 *   before any query. Any other organization simply holds no shipment and no withdrawal of it.
 */

/** The only caller these routes answer. */
export const DISPATCH_FENCE_CALLER = 'marketplace-service';

export function assertDispatchFenceCaller(): void {
  const context = getContext();
  if (context.authType !== 'SERVICE' || context.callerService !== DISPATCH_FENCE_CALLER) {
    throw RastaError.forbidden(
      'This endpoint is reserved for the service that owns return requests',
    );
  }
}

@Injectable()
export class ReturnDispatchFenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ReturnShipmentRepository,
    private readonly publisher: EventPublisher,
    @Inject(ENV) private readonly env: InventoryEnv,
  ) {}

  /** The request's shipment in the caller's books, whatever its status, or `null`. */
  async shipmentOf(returnRequestId: string): Promise<ReturnRequestShipmentView> {
    const organizationId = this.owner();
    const id = requestId(returnRequestId);
    const shipment = await this.shipments.findByRequest(undefined, organizationId, id);
    return {
      returnRequestId: id,
      returnShipment: shipment ? { id: shipment.id, status: shipment.status } : null,
    };
  }

  /**
   * Withdraws one dispatch reservation of the request, unless the request has a shipment here.
   * Idempotent: a reservation already withdrawn answers as it was withdrawn. One transaction, under
   * the request's dispatch lock; a lock held past `INVENTORY_LOCK_TIMEOUT_MS` is the platform's
   * retryable 409, which marketplace reads as no answer.
   */
  async withdraw(
    returnRequestId: string,
    dto: WithdrawDispatchDto,
  ): Promise<DispatchWithdrawalView> {
    const organizationId = this.owner();
    const id = requestId(returnRequestId);
    const context = getContext();
    const lockTimeoutMs = this.env.INVENTORY_LOCK_TIMEOUT_MS;

    try {
      return await this.prisma.transaction(
        async (tx) => {
          await boundLockWaits(tx, lockTimeoutMs);
          await this.shipments.lockDispatch(tx, organizationId, id);

          // Goods exist for the request — under whichever reservation, or none (recorded before
          // reservations existed): nothing is withdrawn, and marketplace keeps the reservation.
          const shipment = await this.shipments.findByRequest(tx, organizationId, id);
          if (shipment) {
            return {
              outcome: 'DISPATCHED' as const,
              returnRequestId: id,
              reservationId: dto.reservationId,
              withdrawnAt: null,
              returnShipment: { id: shipment.id, status: shipment.status },
            };
          }

          const existing = await this.shipments.findWithdrawal(
            tx,
            organizationId,
            dto.reservationId,
          );
          if (existing && existing.returnRequestId !== id) {
            // A reservation is one request's; an answer about another is no answer.
            throw RastaError.businessRule(
              'This dispatch reservation was withdrawn for another return request',
              { returnRequestId: id },
            );
          }
          let withdrawal = existing;
          if (!withdrawal) {
            const at = await transactionNow(tx);
            const by = context.callerService ?? DISPATCH_FENCE_CALLER;
            withdrawal = await this.shipments.insertWithdrawal(tx, {
              id: newId(ID_PREFIX.returnDispatchWithdrawal),
              organizationId,
              returnRequestId: id,
              reservationId: dto.reservationId,
              at,
              by,
              correlationId: context.correlationId,
            });
            // Its audit record, with the row, once (AGENTS.md S-06; Codex r2 on #339, finding 1):
            // a repeat that finds the row above writes neither.
            await this.publisher.enqueue(tx, {
              eventName: 'RETURN_DISPATCH_WITHDRAWN',
              aggregateId: withdrawal.id,
              organizationId,
              occurredAt: at,
              payload: {
                withdrawalId: withdrawal.id,
                organizationId,
                returnRequestId: id,
                reservationId: withdrawal.reservationId,
                withdrawnBy: by,
                withdrawnAt: withdrawal.withdrawnAt.toISOString(),
              },
            });
          }
          return {
            outcome: 'WITHDRAWN' as const,
            returnRequestId: id,
            reservationId: withdrawal.reservationId,
            withdrawnAt: withdrawal.withdrawnAt.toISOString(),
            returnShipment: null,
          };
        },
        { timeoutMs: commandTransactionTimeoutMs(lockTimeoutMs), maxWaitMs: lockTimeoutMs },
      );
    } catch (error) {
      throw translateCommandError(error, null);
    }
  }

  /** Resolved before any query, so a token minted with no organization is a 403 that reads nothing. */
  private owner(): string {
    assertDispatchFenceCaller();
    return getOrganizationId();
  }
}

function requestId(value: string): string {
  const parsed = internalReturnRequestIdSchema.safeParse(value);
  if (!parsed.success) {
    throw RastaError.validation(
      [{ path: 'id', code: 'invalid_string', message: 'A return request id is RET_<ULID>' }],
      'The path names no return request',
    );
  }
  return parsed.data;
}
