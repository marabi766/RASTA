import { Inject, Injectable } from '@nestjs/common';
import { RastaError, currentActor, getContext } from '@rasta/nest-common';
import type { DemandAggregation } from '../generated/prisma';
import { ProcurementAccess, assertOwnedBy, type Acting } from '../access/access';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { demandIdsDigest } from '../events/events';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { DatabaseClock } from '../shared/clock';
import type { ClaimFence } from '../shared/idempotency';
import { ruleRefusal } from '../shared/refusal';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ProcurementEnv, type ShortfallPolicy } from '../config/env';
import { aggregationWindowsEndedTotal, demandCommandsTotal } from '../observability/metrics';
import { DemandRepository, snapshotOf } from './demand.repository';
import {
  closingInstant,
  extendedClosingInstant,
  windowOutcome,
  type WindowOutcome,
} from './demand.state-machine';
import {
  MAX_QUANTITY,
  type AggregationView,
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

/** The metric label of each end of a window (a fixed, small set). */
const ENDED_LABEL: Record<WindowOutcome['command'], string> = {
  reachThreshold: 'ready',
  extend: 'extended',
  refer: 'referred',
  lapse: 'lapsed',
};

/**
 * Demands and the windows they join (ADR-070 § 2, COM-007 PR 1).
 *
 * ## Joining and the end of a window do not race
 *
 * A submission locks the OPEN window of (organization, product) — or opens one, the partial unique
 * index deciding between two first demands — and only then reads the database clock
 * (`DatabaseClock`). The window is half-open, `[openedAt, closesAt)`: a demand at or after
 * `closesAt` never joins it, whatever its status still says. That same transaction ends the window
 * (the transition the sweeper of plan PR 2 makes) and the demand joins the window that follows —
 * the same one, moved on, under EXTEND; a new one otherwise. Correctness never waits for a sweep.
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
        const outcome = await this.endWindow(tx, window, now);
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
      // A technical limit (Q-119 note of 2026-10-17): a window ending under REFER or CLOSE moves
      // every live demand in one transaction, which must fit the transaction budget — past it the
      // close rolls back, the window stays OPEN and every later submit repeats it. `demandCount`
      // counts the live demands (the totals check holds it), read under the same lock.
      if (window.demandCount >= this.env.PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS) {
        const refusal = ruleRefusal(
          'The window this demand would join holds as many demands as it can take',
          'submission',
          ['AGGREGATION_DEMAND_LIMIT_REACHED'],
          { aggregationId: window.id },
        );
        // Unlike a quantity that does not fit, this refuses every demand: an end this transaction
        // made (EXTEND, the one end that keeps the full window) is committed without the demand —
        // it was due at closesAt whatever arrived — or nothing would ever move the window on, and
        // its demands, frozen past closesAt, could not be withdrawn to make room.
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
    if (done.ended) {
      aggregationWindowsEndedTotal.inc({
        service: SERVICE_NAME,
        transition: ENDED_LABEL[done.ended.command],
        trigger: 'demand',
      });
    }
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

  private openWindowRow(
    tx: ExtendedPrismaClient,
    acting: Acting,
    productId: string,
    id: string,
    openedAt: Date,
  ): Promise<boolean> {
    const snapshot = snapshotOf(this.env);
    return this.repository.openWindow(tx, {
      id,
      organizationId: acting.organizationId,
      productId,
      openedAt,
      closesAt: closingInstant(openedAt, snapshot.windowHours),
      snapshot,
    });
  }

  /**
   * The end of a window this transaction holds the lock of, at `now` (ADR-070 § 2): decided by the
   * window's own snapshot and the demands it holds, with its event. The transition the sweeper of
   * plan PR 2 makes; here, the synchronous path of a demand that arrived after `closesAt`.
   */
  private async endWindow(
    tx: ExtendedPrismaClient,
    window: DemandAggregation,
    now: Date,
  ): Promise<WindowOutcome> {
    const live = await this.repository.liveDemandIds(tx, window);
    const outcome = windowOutcome(
      {
        windowHours: window.windowHours,
        minQuantity: window.minQuantity,
        shortfallPolicy: window.shortfallPolicy as ShortfallPolicy,
      },
      { liveDemands: live.length, totalQuantity: window.totalQuantity },
      window.closesAt,
      now,
    );
    const facts = {
      aggregationId: window.id,
      organizationId: window.organizationId,
      productId: window.productId,
      totalQuantity: Number(window.totalQuantity),
    };
    // The demands it ended with, by count and digest: never a list without a bound (ADR-070 § 9).
    const demands = { demandCount: live.length, demandIdsSha256: demandIdsDigest(live) };
    const event = {
      aggregateId: window.id,
      organizationId: window.organizationId,
      occurredAt: now,
    };

    switch (outcome.command) {
      case 'reachThreshold':
        await this.repository.endWindow(tx, window, 'READY', now);
        await this.publisher.enqueue(tx, {
          ...event,
          eventName: 'DEMAND_AGGREGATED',
          payload: {
            ...facts,
            ...demands,
            settingVersion: window.settingVersion,
            closedAt: now.toISOString(),
          },
        });
        break;
      case 'refer':
        await this.repository.endWindow(tx, window, 'REFERRED', now);
        await this.repository.closeDemands(tx, window, 'REFERRED', live.length, now);
        await this.publisher.enqueue(tx, {
          ...event,
          eventName: 'AGGREGATION_REFERRED',
          payload: { ...facts, ...demands, closedAt: now.toISOString() },
        });
        break;
      case 'lapse':
        await this.repository.endWindow(tx, window, 'LAPSED', now);
        if (live.length > 0) {
          await this.repository.closeDemands(tx, window, 'LAPSED', live.length, now);
        }
        await this.publisher.enqueue(tx, {
          ...event,
          eventName: 'AGGREGATION_LAPSED',
          payload: {
            ...facts,
            ...demands,
            reasonCode: live.length === 0 ? 'NO_LIVE_DEMAND' : 'SHORTFALL_CLOSED',
            closedAt: now.toISOString(),
          },
        });
        break;
      case 'extend': {
        const closesAt = extendedClosingInstant(
          window.closesAt,
          window.windowHours,
          outcome.windows,
        );
        await this.repository.extendWindow(tx, window, closesAt, outcome.windows, now);
        await this.publisher.enqueue(tx, {
          ...event,
          eventName: 'AGGREGATION_WINDOW_EXTENDED',
          payload: {
            ...facts,
            previousClosesAt: window.closesAt.toISOString(),
            closesAt: closesAt.toISOString(),
            windows: outcome.windows,
            extensionCount: window.extensionCount + outcome.windows,
          },
        });
        break;
      }
    }
    return outcome;
  }
}
