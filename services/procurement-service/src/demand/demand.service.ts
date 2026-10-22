import { Inject, Injectable } from '@nestjs/common';
import { RastaError, currentActor, getContext } from '@rasta/nest-common';
import type { DemandAggregation } from '../generated/prisma';
import { ProcurementAccess, assertOwnedBy, type Acting } from '../access/access';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { DatabaseClock } from '../shared/clock';
import type { ClaimFence } from '../shared/idempotency';
import { ruleRefusal } from '../shared/refusal';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ProcurementEnv } from '../config/env';
import { aggregationCancelledTotal, demandCommandsTotal } from '../observability/metrics';
import { AggregationSettingService } from '../setting/setting.service';
import { DemandRepository } from './demand.repository';
import { closingInstant, type WindowOutcome } from './demand.state-machine';
import { countWindowEnded, WindowEnd } from './window-end';
import {
  MAX_QUANTITY,
  type AggregationView,
  type CancelAggregationDto,
  type CursorPage,
  type DemandView,
  type ListAggregationsQuery,
  type ListDemandsQuery,
  type SubmitDemandDto,
  type WithdrawDemandDto,
} from './dto';
import { toAggregationView, toDemandView } from './views';

/** How many times a submission looks for or opens a window that another request keeps replacing. */
const WINDOW_ATTEMPTS = 3;

/**
 * Demands and the windows they join (ADR-070 § 2, COM-007 PR 1).
 *
 * ## Joining and the end of a window do not race
 *
 * A submission locks the OPEN window of (organization, product) — or opens one, the partial unique
 * index deciding between two first demands — and only then reads the database clock
 * (`DatabaseClock`). The window is half-open, `[openedAt, closesAt)`: a demand at or after
 * `closesAt` never joins it, whatever its status still says. That same transaction ends the window
 * (`WindowEnd`, the transition the sweeper makes too) and the demand joins the window that follows
 * — the same one, moved on, under EXTEND; a new one otherwise. Correctness never waits for a sweep.
 *
 * Every change is a compare-and-set in one transaction with its event (A-08), and so with its
 * audit record; the idempotency claim's fence is the transaction's first and last statement.
 */
@Injectable()
export class DemandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: DemandRepository,
    private readonly access: ProcurementAccess,
    private readonly publisher: EventPublisher,
    private readonly clock: DatabaseClock,
    private readonly windowEnd: WindowEnd,
    private readonly settings: AggregationSettingService,
    @Inject(ENV) private readonly env: ProcurementEnv,
  ) {}

  async submit(dto: SubmitDemandDto, fence: ClaimFence<DemandView>): Promise<DemandView> {
    const acting = this.access.assertBuyer();
    const actor = currentActor({ requirePlatformUserId: true });
    const correlationId = getContext().correlationId;

    const done: { ended?: WindowOutcome; refused?: RastaError; opened: boolean } = {
      opened: false,
    };
    const view = await this.prisma.transaction(async (tx) => {
      await fence.hold(tx);

      let { window, opened } = await this.lockOrOpenWindow(tx, acting, dto.productId);
      const now = await this.clock.now(tx);

      if (now.getTime() >= window.closesAt.getTime()) {
        // The window ended before this demand: end it here, then join what follows it.
        const { outcome } = await this.windowEnd.end(tx, window, now);
        done.ended = outcome;
        if (outcome.to === 'OPEN') {
          window = await this.repository.aggregationAfter(tx, window);
        } else {
          window = await this.openWindowAt(tx, acting, dto.productId, now);
          opened = true;
        }
      }

      // The window's total becomes the quantity of an RFQ and a purchase order: it stays within
      // what they can state (ADR-070 § 2). Refused here, under the lock, so nothing is written —
      // a window this transaction ended stays as it was too.
      if (window.totalQuantity + BigInt(dto.quantity) > BigInt(MAX_QUANTITY)) {
        throw ruleRefusal(
          'This demand would take the window past the largest quantity an order can state',
          'submission',
          ['AGGREGATION_QUANTITY_LIMIT_EXCEEDED'],
          { aggregationId: window.id },
        );
      }
      // A technical limit (Q-119 note of 2026-10-17): no window holds more than one close can
      // digest (`DEFAULT_MAX_LIVE_DEMANDS`, from a measured digest time). Every transaction of the
      // close is bounded anyway — the end and each sweeper step move and digest one batch — so
      // this bounds how long a window's end takes. `demandCount` counts the live demands (the
      // totals check holds it), read under the same lock.
      if (window.demandCount >= this.env.PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS) {
        const refusal = ruleRefusal(
          'The window this demand would join holds as many demands as it can take',
          'submission',
          ['AGGREGATION_DEMAND_LIMIT_REACHED'],
          { aggregationId: window.id },
        );
        // Unlike a quantity that does not fit, this refuses every demand: an end this transaction
        // made (EXTEND, the one end that keeps the full window) is committed without the demand —
        // it was due at closesAt whatever arrived, as the sweeper would have made it — and the
        // window, open again, lets a demand be withdrawn to make room.
        if (!done.ended) throw refusal;
        done.refused = refusal;
        return null;
      }

      const demand = await this.repository.insertDemand(tx, {
        id: newId(ID_PREFIX.demandRequest),
        organizationId: acting.organizationId,
        aggregationId: window.id,
        productId: dto.productId,
        quantity: dto.quantity,
        note: dto.note ?? null,
        submittedAt: now,
        submittedBy: actor.userId,
        submittedCorrelationId: correlationId,
      });
      await this.repository.join(tx, window, dto.quantity, now);

      await this.publisher.enqueue(tx, {
        eventName: 'DEMAND_SUBMITTED',
        aggregateId: demand.id,
        organizationId: acting.organizationId,
        occurredAt: now,
        payload: {
          demandId: demand.id,
          aggregationId: window.id,
          organizationId: acting.organizationId,
          productId: dto.productId,
          quantity: dto.quantity,
          aggregationOpened: opened,
          closesAt: window.closesAt.toISOString(),
          submittedBy: actor.userId,
          submittedAt: now.toISOString(),
        },
      });

      done.opened = opened;
      return fence.complete(tx, toDemandView(demand));
    });

    // Counted once committed: a rolled-back command changed nothing.
    if (done.ended) countWindowEnded(done.ended, 'demand');
    // Refused after its window's end committed: the claim is released like any refusal's.
    if (view === null) throw done.refused;
    demandCommandsTotal.inc({
      service: SERVICE_NAME,
      command: 'submit',
      outcome: done.ended ? 'after_end' : done.opened ? 'opened' : 'joined',
    });
    return view;
  }

  async withdraw(
    id: string,
    dto: WithdrawDemandDto,
    fence: ClaimFence<DemandView>,
  ): Promise<DemandView> {
    const acting = this.access.assertBuyer();
    const actor = currentActor({ requirePlatformUserId: true });

    const view = await this.prisma.transaction(async (tx) => {
      await fence.hold(tx);

      const found = await this.repository.findDemand(id, tx);
      if (!found) throw RastaError.notFound('DemandRequest', id);
      assertOwnedBy(found, acting, 'DemandRequest');

      // The window first, then the demand: the one lock order of this service.
      const window = await this.repository.lockWindow(
        tx,
        acting.organizationId,
        found.aggregationId,
      );
      const demand = await this.repository.lockDemand(tx, acting.organizationId, id);
      if (!window || !demand) throw RastaError.notFound('DemandRequest', id);

      if (demand.status !== 'SUBMITTED') {
        throw ruleRefusal('Only a submitted demand is withdrawn', 'withdrawal', [
          'DEMAND_NOT_SUBMITTED',
        ]);
      }
      if (demand.version !== dto.expectedVersion) {
        throw RastaError.optimisticLockFailed('DemandRequest', id);
      }

      const now = await this.clock.now(tx);
      if (window.status !== 'OPEN' || now.getTime() >= window.closesAt.getTime()) {
        throw ruleRefusal(
          'The window this demand joined has ended: its demands are final',
          'withdrawal',
          ['AGGREGATION_WINDOW_ENDED'],
          { demandId: id, aggregationId: window.id },
        );
      }

      const withdrawn = await this.repository.withdraw(tx, demand, {
        by: actor.userId,
        reason: dto.reason,
        at: now,
      });
      await this.repository.leave(tx, window, demand.quantity, now);

      await this.publisher.enqueue(tx, {
        eventName: 'DEMAND_WITHDRAWN',
        aggregateId: demand.id,
        organizationId: acting.organizationId,
        occurredAt: now,
        payload: {
          demandId: demand.id,
          aggregationId: window.id,
          organizationId: acting.organizationId,
          productId: demand.productId,
          quantity: demand.quantity,
          withdrawnBy: actor.userId,
          withdrawnAt: now.toISOString(),
        },
      });

      return fence.complete(tx, toDemandView(withdrawn));
    });
    demandCommandsTotal.inc({ service: SERVICE_NAME, command: 'withdraw', outcome: 'withdrawn' });
    return view;
  }

  /**
   * READY → CANCELLED with a reason, by a role of the RFQ issuer (ADR-070 § 2; Q-119 (4): the one
   * way out for the requesters of a window that ended). Its demands stay as they are: the window
   * ended READY with them, and they are final with it. The reason stays here; the event carries
   * the demands by count and digest and who cancelled.
   */
  async cancelAggregation(
    id: string,
    dto: CancelAggregationDto,
    fence: ClaimFence<AggregationView>,
  ): Promise<AggregationView> {
    const acting = this.access.assertRfqIssuer();
    const actor = currentActor({ requirePlatformUserId: true });

    const view = await this.prisma.transaction(async (tx) => {
      await fence.hold(tx);

      const window = await this.repository.lockWindow(tx, acting.organizationId, id);
      if (!window) throw RastaError.notFound('DemandAggregation', id);
      assertOwnedBy(window, acting, 'DemandAggregation');

      if (window.status !== 'READY') {
        throw ruleRefusal('Only a READY aggregation is cancelled', 'cancellation', [
          'AGGREGATION_NOT_READY',
        ]);
      }
      if (window.version !== dto.expectedVersion) {
        throw RastaError.optimisticLockFailed('DemandAggregation', id);
      }
      // The window's end is still being carried on: its digest, and so its DEMAND_AGGREGATED, are
      // not out yet, and nothing moves a window on before its end's event (WindowEnd). The next
      // sweeper steps finish it, a batch a transaction.
      const digest = window.demandIdsSha256;
      if (digest === null) {
        throw new RastaError(
          'CONFLICT',
          'The end of this aggregation is still being recorded; retry',
          { retryAfterSeconds: 1 },
        );
      }

      const now = await this.clock.now(tx);
      await this.repository.cancelWindow(tx, window, {
        by: actor.userId,
        reason: dto.reason,
        at: now,
      });
      await this.publisher.enqueue(tx, {
        eventName: 'AGGREGATION_CANCELLED',
        aggregateId: window.id,
        organizationId: window.organizationId,
        occurredAt: now,
        payload: {
          aggregationId: window.id,
          organizationId: window.organizationId,
          productId: window.productId,
          totalQuantity: Number(window.totalQuantity),
          demandCount: window.demandCount,
          demandIdsSha256: digest,
          cancelledBy: actor.userId,
          cancelledAt: now.toISOString(),
        },
      });

      return fence.complete(
        tx,
        toAggregationView(await this.repository.aggregationAfter(tx, window)),
      );
    });
    aggregationCancelledTotal.inc({ service: SERVICE_NAME });
    return view;
  }

  /**
   * Whether the caller may still cancel this aggregation's way: the rule a fresh cancellation
   * applies (the issuer's roles, the caller's own organization), checked before a stored answer is
   * replayed.
   */
  async assertCancellationVisible(id: string): Promise<void> {
    const acting = this.access.assertRfqIssuer();
    const aggregation = await this.repository.findAggregation(id);
    if (!aggregation) throw RastaError.notFound('DemandAggregation', id);
    assertOwnedBy(aggregation, acting, 'DemandAggregation');
  }

  async getDemand(id: string): Promise<DemandView> {
    const acting = this.access.assertBuyer();
    const demand = await this.repository.findDemand(id);
    if (!demand) throw RastaError.notFound('DemandRequest', id);
    assertOwnedBy(demand, acting, 'DemandRequest');
    return toDemandView(demand);
  }

  async listDemands(query: ListDemandsQuery): Promise<CursorPage<DemandView>> {
    const acting = this.access.assertBuyer();
    const rows = await this.repository.listDemands({
      ...(query.status ? { status: query.status } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    const more = rows.length > query.limit;
    const shown = more ? rows.slice(0, query.limit) : rows;
    shown.forEach((row) => assertOwnedBy(row, acting, 'DemandRequest'));
    return {
      items: shown.map(toDemandView),
      nextCursor: more ? (shown[shown.length - 1]?.id ?? null) : null,
    };
  }

  async getAggregation(id: string): Promise<AggregationView> {
    const acting = this.access.assertBuyer();
    const aggregation = await this.repository.findAggregation(id);
    if (!aggregation) throw RastaError.notFound('DemandAggregation', id);
    assertOwnedBy(aggregation, acting, 'DemandAggregation');
    return toAggregationView(aggregation);
  }

  async listAggregations(query: ListAggregationsQuery): Promise<CursorPage<AggregationView>> {
    const acting = this.access.assertBuyer();
    const rows = await this.repository.listAggregations({
      ...(query.status ? { status: query.status } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
    const more = rows.length > query.limit;
    const shown = more ? rows.slice(0, query.limit) : rows;
    shown.forEach((row) => assertOwnedBy(row, acting, 'DemandAggregation'));
    return {
      items: shown.map(toAggregationView),
      nextCursor: more ? (shown[shown.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Whether the caller may still see this demand: the check a stored response must pass before it
   * is replayed (the same rule a fresh request applies now).
   */
  async assertDemandVisible(id: string): Promise<void> {
    await this.getDemand(id);
  }

  /**
   * The OPEN window of (organization, product), locked; or a new one this transaction opened. A
   * window another request opens or ends in between sends this one round again — a bounded number
   * of times, then the retryable 409.
   */
  private async lockOrOpenWindow(
    tx: ExtendedPrismaClient,
    acting: Acting,
    productId: string,
  ): Promise<{ window: DemandAggregation; opened: boolean }> {
    for (let attempt = 0; attempt < WINDOW_ATTEMPTS; attempt += 1) {
      const open = await this.repository.lockOpenWindow(tx, acting.organizationId, productId);
      if (open) return { window: open, opened: false };
      const openedAt = await this.clock.now(tx);
      const id = newId(ID_PREFIX.aggregation);
      if (await this.openWindowRow(tx, acting, productId, id, openedAt)) {
        const window = await this.repository.lockWindow(tx, acting.organizationId, id);
        if (window) return { window, opened: true };
      }
    }
    throw new RastaError('CONFLICT', 'The window for this product changed meanwhile; retry', {
      retryAfterSeconds: 1,
    });
  }

  /** A window opened at `at` by this transaction, which already holds the one it replaces. */
  private async openWindowAt(
    tx: ExtendedPrismaClient,
    acting: Acting,
    productId: string,
    at: Date,
  ): Promise<DemandAggregation> {
    const id = newId(ID_PREFIX.aggregation);
    const window = (await this.openWindowRow(tx, acting, productId, id, at))
      ? await this.repository.lockWindow(tx, acting.organizationId, id)
      : null;
    if (!window) {
      throw new RastaError('CONFLICT', 'The window for this product changed meanwhile; retry', {
        retryAfterSeconds: 1,
      });
    }
    return window;
  }

  private async openWindowRow(
    tx: ExtendedPrismaClient,
    acting: Acting,
    productId: string,
    id: string,
    openedAt: Date,
  ): Promise<boolean> {
    // The organization's setting in force, read in this transaction, or the environment defaults
    // (plan PR 3): the window keeps it whatever is recorded later.
    const snapshot = await this.settings.snapshotFor(tx, acting.organizationId);
    return this.repository.openWindow(tx, {
      id,
      organizationId: acting.organizationId,
      productId,
      openedAt,
      closesAt: closingInstant(openedAt, snapshot.windowHours),
      snapshot,
    });
  }
}
