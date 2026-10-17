import { Inject, Injectable } from '@nestjs/common';
import type { DemandAggregation } from '../generated/prisma';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { EventPublisher } from '../events/publisher';
import { ENV } from '../tokens';
import { SERVICE_NAME, type ProcurementEnv, type ShortfallPolicy } from '../config/env';
import {
  aggregationExtensionsTotal,
  aggregationWindowsEndedTotal,
  ENDED_LABEL,
} from '../observability/metrics';
import { DemandRepository } from './demand.repository';
import { extendedClosingInstant, windowOutcome, type WindowOutcome } from './demand.state-machine';

/** Counts a window's end once its transaction committed: a rolled-back end changed nothing. */
export function countWindowEnded(outcome: WindowOutcome, trigger: 'demand' | 'sweeper'): void {
  aggregationWindowsEndedTotal.inc({
    service: SERVICE_NAME,
    transition: ENDED_LABEL[outcome.command],
    trigger,
  });
  if (outcome.command === 'extend') {
    aggregationExtensionsTotal.inc({ service: SERVICE_NAME }, outcome.windows);
  }
}

/** What a window's end did, and what it left for the sweeper. */
export interface WindowEnded {
  readonly outcome: WindowOutcome;
  /** Live demands not yet moved with a REFERRED or LAPSED window; 0 when it ended whole. */
  readonly demandsToFollow: number;
}

/**
 * The end of a window (ADR-070 § 2) — the one transition function both of its triggers call: a
 * demand that arrives at or after `closesAt` (`DemandService.submit`, PR 1) and the sweeper that
 * ends it on time (`WindowSweepService`, plan PR 2). Same decision (`windowOutcome`, from the
 * window's snapshot and what it holds), same writes, same event, whoever ends it.
 *
 * ## Bounded, whatever the window holds
 *
 * The caller holds the window's row lock and read `now` after it. The end writes the window's row
 * and its event, and moves at most `PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE` of its live demands to
 * REFERRED or LAPSED; the rest are counted in `demands_to_follow` and moved by the sweeper, that
 * many per transaction (`follow`). Its only work that grows with the window is one count and
 * digest of the live demands in the database. Measured through the API on rasta-dev, a late
 * demand's whole submit ends a window of 200,000 demands in 0.84 s and of 1,000,000 in 2.85 s
 * (~2.5 µs a demand), so its 5 s budget holds a window of ~1.8 million live demands — PR 1's single
 * UPDATE of every demand stopped at ~35,000 (PR-327 r1 F1). The event names every demand of the end, by
 * count and digest, at once; the demands that follow later change state, not facts.
 */
@Injectable()
export class WindowEnd {
  private readonly batchSize: number;

  constructor(
    private readonly repository: DemandRepository,
    private readonly publisher: EventPublisher,
    @Inject(ENV) env: ProcurementEnv,
  ) {
    this.batchSize = env.PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE;
  }

  /** Ends `window` (OPEN, locked by the caller, `now` at or past its `closesAt`). */
  async end(tx: ExtendedPrismaClient, window: DemandAggregation, now: Date): Promise<WindowEnded> {
    const live = await this.repository.liveDemands(tx, window);
    if (live.count !== window.demandCount) {
      // An OPEN window's count is its SUBMITTED demands' (the deferred totals check): a difference
      // is a defect, never something to end the window on.
      throw new Error(
        `window ${window.id} states ${window.demandCount} demands and holds ${live.count} live`,
      );
    }
    const outcome = windowOutcome(
      {
        windowHours: window.windowHours,
        minQuantity: window.minQuantity,
        shortfallPolicy: window.shortfallPolicy as ShortfallPolicy,
      },
      { liveDemands: live.count, totalQuantity: window.totalQuantity },
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
    const demands = { demandCount: live.count, demandIdsSha256: live.digest };
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
        return { outcome, demandsToFollow: 0 };
      case 'refer':
      case 'lapse': {
        const to = outcome.to;
        const movedNow = Math.min(live.count, this.batchSize);
        const toFollow = live.count - movedNow;
        await this.repository.endWindow(tx, window, to, now, toFollow);
        await this.repository.followWindow(tx, window, to, movedNow, now);
        await this.publisher.enqueue(
          tx,
          to === 'REFERRED'
            ? {
                ...event,
                eventName: 'AGGREGATION_REFERRED',
                payload: { ...facts, ...demands, closedAt: now.toISOString() },
              }
            : {
                ...event,
                eventName: 'AGGREGATION_LAPSED',
                payload: {
                  ...facts,
                  ...demands,
                  reasonCode: live.count === 0 ? 'NO_LIVE_DEMAND' : 'SHORTFALL_CLOSED',
                  closedAt: now.toISOString(),
                },
              },
        );
        return { outcome, demandsToFollow: toFollow };
      }
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
        return { outcome, demandsToFollow: 0 };
      }
    }
  }

  /**
   * The next batch of live demands of a window that ended REFERRED or LAPSED follows it (the
   * window locked by the caller). Answers how many are still to follow. No event: the window's
   * end already named every one of them.
   */
  async follow(tx: ExtendedPrismaClient, window: DemandAggregation, now: Date): Promise<number> {
    if (window.status !== 'REFERRED' && window.status !== 'LAPSED') {
      throw new Error(`window ${window.id} is ${window.status}: only an ended window is followed`);
    }
    const moved = Math.min(window.demandsToFollow, this.batchSize);
    const remaining = window.demandsToFollow - moved;
    await this.repository.followWindow(tx, window, window.status, moved, now);
    await this.repository.followed(tx, window, remaining);
    return remaining;
  }
}
