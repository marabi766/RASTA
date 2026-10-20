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
import { ResumableSha256 } from '../shared/resumable-sha256';
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

/** What a window's end did, and whether it left work for the sweeper. */
export interface WindowEnded {
  readonly outcome: WindowOutcome;
  /**
   * Whether the end is still being carried on (`carryOn`): its digest — and so its event — or
   * live demands still to follow a REFERRED or LAPSED window. False when it ended whole.
   */
  readonly pending: boolean;
}

/** Whether a window's end still has work in it: a digest being built, or demands to follow. */
export function endPending(window: DemandAggregation): boolean {
  return window.endDigestState !== null || window.demandsToFollow > 0;
}

/**
 * The end of a window (ADR-070 § 2) — the one transition function both of its triggers call: a
 * demand that arrives at or after `closesAt` (`DemandService.submit`, PR 1) and the sweeper that
 * ends it on time (`WindowSweepService`, plan PR 2). Same decision (`windowOutcome`, from the
 * window's snapshot and what it holds), same writes, same event, whoever ends it.
 *
 * ## No transaction grows with the window (PR-338 r1 F1)
 *
 * The caller holds the window's row lock and read `now` after it. The decision reads the window's
 * own row: its `demand_count` is its live demands' (the deferred totals check holds it at every
 * commit), so nothing is counted. The end then leaves OPEN at once — a later demand opens the next
 * window — and does one batch of what remains, as does every later sweeper step (`carryOn`), each
 * in its own transaction:
 *
 * - **the digest** of the demands it ended with (`demandIdsDigest`): the next
 *   `PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE` ids in byte order, after the last one taken, fed to a
 *   SHA-256 whose state is stored on the row (`ResumableSha256`). The set is frozen from the end
 *   on (no demand joins, none is withdrawn), so every batch reads the same set, and a crash loses
 *   only the batch in flight. The transaction that takes the last id writes the digest and
 *   enqueues the end's **one** event (`DEMAND_AGGREGATED`, `AGGREGATION_REFERRED` or
 *   `AGGREGATION_LAPSED`, `occurredAt` = the end's instant). A window of up to one batch (2000
 *   by default) gets it in the end's own transaction; a larger one in the sweeper's last step.
 * - **the demands to follow** a REFERRED or LAPSED window: that many more moved to its status.
 *
 * Until the event is out, nothing moves the window on (a cancellation is a retryable 409).
 *
 * The database takes the digest's progress only phase by phase (`demand_aggregation_guard`,
 * PR-338 r2 F1): begun by the end from nothing, each batch exactly the ids after the cursor that it
 * counts — their bytes in the state — and written by the batch that takes the last id. A count
 * written beside these can no longer make the event carry a digest of fewer ids than the window.
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
    const outcome = windowOutcome(
      {
        windowHours: window.windowHours,
        minQuantity: window.minQuantity,
        shortfallPolicy: window.shortfallPolicy as ShortfallPolicy,
      },
      { liveDemands: window.demandCount, totalQuantity: window.totalQuantity },
      window.closesAt,
      now,
    );

    if (outcome.command === 'extend') {
      const closesAt = extendedClosingInstant(window.closesAt, window.windowHours, outcome.windows);
      await this.repository.extendWindow(tx, window, closesAt, outcome.windows, now);
      await this.publisher.enqueue(tx, {
        aggregateId: window.id,
        organizationId: window.organizationId,
        occurredAt: now,
        eventName: 'AGGREGATION_WINDOW_EXTENDED',
        payload: {
          ...factsOf(window),
          previousClosesAt: window.closesAt.toISOString(),
          closesAt: closesAt.toISOString(),
          windows: outcome.windows,
          extensionCount: window.extensionCount + outcome.windows,
        },
      });
      return { outcome, pending: false };
    }

    await this.repository.endWindow(tx, window, outcome.to, now, {
      demandsToFollow: outcome.to === 'READY' ? 0 : window.demandCount,
      digestState: ResumableSha256.fresh().save(),
    });
    const ended = await this.repository.aggregationAfter(tx, window);
    return { outcome, pending: await this.carryOn(tx, ended, now) };
  }

  /**
   * One more batch of an ended window's end (the window locked by the caller): of its digest —
   * with its event, when that batch completes it — and of its demands to follow. Answers whether
   * anything is still left.
   */
  async carryOn(tx: ExtendedPrismaClient, window: DemandAggregation, now: Date): Promise<boolean> {
    if (window.status !== 'READY' && window.status !== 'REFERRED' && window.status !== 'LAPSED') {
      throw new Error(
        `window ${window.id} is ${window.status}: only an ended window is carried on`,
      );
    }
    const digesting = window.endDigestState !== null && !(await this.digestBatch(tx, window));
    const following = window.demandsToFollow > 0 && (await this.followBatch(tx, window, now)) > 0;
    return digesting || following;
  }

  /** The next batch of the digest; answers whether it completed it (and enqueued the event). */
  private async digestBatch(tx: ExtendedPrismaClient, window: DemandAggregation): Promise<boolean> {
    const state = window.endDigestState;
    if (state === null) throw new Error(`window ${window.id} has no digest being built`);
    const hash = ResumableSha256.restore(state);
    const ids = await this.repository.nextDemandIds(tx, window, this.batchSize);
    let counted = window.endDigestCounted;
    for (const id of ids) {
      hash.update(counted === 0 ? id : `\n${id}`);
      counted += 1;
    }
    // The window's count is its live demands' (the deferred totals check), and the set is frozen:
    // reading fewer, or more, is a defect, never something to end the window on.
    if (
      counted > window.demandCount ||
      (counted < window.demandCount && ids.length < this.batchSize)
    ) {
      throw new Error(
        `window ${window.id} states ${window.demandCount} demands and holds ${counted} or more`,
      );
    }
    const last = ids[ids.length - 1];
    if (counted < window.demandCount && last !== undefined) {
      await this.repository.digestTaken(tx, window, { state: hash.save(), cursor: last, counted });
      return false;
    }

    const digest = hash.hex();
    await this.repository.digestWritten(tx, window, { digest, counted });
    await this.publisher.enqueue(tx, endEvent(window, digest));
    return true;
  }

  /**
   * The next batch of live demands of a window that ended REFERRED or LAPSED follows it. Answers
   * how many are still to follow. No event: the window's end names every one of them.
   */
  private async followBatch(
    tx: ExtendedPrismaClient,
    window: DemandAggregation,
    now: Date,
  ): Promise<number> {
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

function factsOf(window: DemandAggregation) {
  return {
    aggregationId: window.id,
    organizationId: window.organizationId,
    productId: window.productId,
    totalQuantity: Number(window.totalQuantity),
  };
}

/**
 * The end's one event, once its digest is complete: the demands it ended with by count and digest
 * — never a list without a bound (ADR-070 § 9) — at the instant it ended, whichever transaction
 * completes it.
 */
function endEvent(window: DemandAggregation, digest: string) {
  const closedAt = window.closedAt;
  if (closedAt === null) throw new Error(`window ${window.id} ended without its instant`);
  const payload = {
    ...factsOf(window),
    demandCount: window.demandCount,
    demandIdsSha256: digest,
  };
  const event = {
    aggregateId: window.id,
    organizationId: window.organizationId,
    occurredAt: closedAt,
  };
  switch (window.status) {
    case 'READY':
      return {
        ...event,
        eventName: 'DEMAND_AGGREGATED' as const,
        payload: {
          ...payload,
          settingVersion: window.settingVersion,
          closedAt: closedAt.toISOString(),
        },
      };
    case 'REFERRED':
      return {
        ...event,
        eventName: 'AGGREGATION_REFERRED' as const,
        payload: { ...payload, closedAt: closedAt.toISOString() },
      };
    case 'LAPSED':
      return {
        ...event,
        eventName: 'AGGREGATION_LAPSED' as const,
        payload: {
          ...payload,
          reasonCode: window.demandCount === 0 ? 'NO_LIVE_DEMAND' : 'SHORTFALL_CLOSED',
          closedAt: closedAt.toISOString(),
        },
      };
    default:
      throw new Error(`window ${window.id} is ${window.status}: it has no end event`);
  }
}
