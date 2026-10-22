import { Injectable } from '@nestjs/common';
import { createSystemContext, runWithContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { DatabaseClock } from '../shared/clock';
import { SERVICE_NAME } from '../config/env';
import type { WindowOutcome } from './demand.state-machine';
import { WindowEnd, countWindowEnded, endPending } from './window-end';
import { WindowSweepRepository } from './window-sweep.repository';

/** What one step of the sweep of one window came to. */
export type SweepResult =
  /** The window ended here (READY, EXTEND, REFERRED or LAPSED): its event once its digest is. */
  | 'ENDED'
  /** One more batch of an ended window's end: of its digest (then its event), of its demands. */
  | 'FOLLOWED'
  /** Ended by someone else and nothing left of its end: nothing written, the claim given back. */
  | 'NOOP'
  /** Not past its end on the clock read after the lock (a demand extended it): claim given back. */
  | 'NOT_DUE'
  /** The claim was taken back by another sweeper: nothing read, nothing written. */
  | 'NOT_OWNER'
  /** No such window in that organization. */
  | 'NOT_FOUND';

export interface SweepStep {
  result: SweepResult;
  /** The end, when this step made it. */
  outcome?: WindowOutcome;
  /** Whether the window's end is still being carried on (`WindowEnd.carryOn`): another step is due. */
  pending: boolean;
}

export interface SweepTarget {
  organizationId: string;
  aggregationId: string;
  /** The sweeper's fencing token: verified first, so a worker whose lease lapsed does nothing. */
  fence: string;
}

/**
 * One step of the sweep of one window — one short transaction, in the window's own tenant
 * (ADR-070 § 2, plan PR 2; the order of construction's `TenderCloseService`, ADR-065 § 3):
 *
 *   lock the window `FOR UPDATE` (the lock a demand's submit and withdrawal take first, so a step
 *   and a demand queue behind one another and each order has one outcome); **verify the fence**
 *   before anything is read or written; read the clock after the lock; then either end the window
 *   (`WindowEnd.end`, the transition a late demand makes too) or carry an ended window's end on by
 *   one batch (`WindowEnd.carryOn`: its digest, then its event; its demands to follow); renew the
 *   lease while anything of the end is left, release it when done.
 *
 * ## Idempotent, never two events
 *
 * A window that is no longer OPEN and has nothing left of its end is `NOOP`: a second sweeper, a
 * retry after a crash between commit and acknowledgement, a demand that ended it first — all end
 * in one ended window and one event. A claim whose lease lapsed and was re-claimed is `NOT_OWNER`:
 * the fence guards the effect, not only the claim. The end's event commits with the batch that
 * completes the digest, and the digest is written once (`ck_demand_aggregation_digest`): a crash
 * before that commit loses one batch, which the next step takes again from the stored state.
 */
@Injectable()
export class WindowSweepService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sweeps: WindowSweepRepository,
    private readonly windowEnd: WindowEnd,
    private readonly clock: DatabaseClock,
  ) {}

  /** One step, in the window's own tenant: a system context, the window's organization. */
  async step(target: SweepTarget, leaseSeconds: number): Promise<SweepStep> {
    const context = createSystemContext({
      correlationId: ulid(),
      organizationId: target.organizationId,
      callerService: SERVICE_NAME,
    });
    const step = await runWithContext(context, () =>
      this.prisma.transaction((tx) => this.stepIn(tx, target, leaseSeconds)),
    );
    // Counted once committed: a rolled-back end changed nothing.
    if (step.outcome) countWindowEnded(step.outcome, 'sweeper');
    return step;
  }

  /**
   * A failed step: counted, and the next one scheduled with backoff, in the window's own tenant.
   * Best effort — if this write fails too, the lease running out is still the fallback retry.
   */
  recordFailure(
    target: SweepTarget,
    backoff: { baseSeconds: number; maxSeconds: number },
  ): Promise<void> {
    const context = createSystemContext({
      correlationId: ulid(),
      organizationId: target.organizationId,
      callerService: SERVICE_NAME,
    });
    return runWithContext(context, () =>
      this.prisma.transaction((tx) =>
        this.sweeps.recordFailure(tx, {
          organizationId: target.organizationId,
          id: target.aggregationId,
          fence: target.fence,
          ...backoff,
        }),
      ),
    );
  }

  private async stepIn(
    tx: ExtendedPrismaClient,
    target: SweepTarget,
    leaseSeconds: number,
  ): Promise<SweepStep> {
    const { organizationId, aggregationId: id, fence } = target;
    const window = await this.sweeps.lockForSweep(tx, organizationId, id);
    if (!window) return { result: 'NOT_FOUND', pending: false };

    // First: nothing below may run for a worker that no longer owns the claim.
    if (window.sweepFence !== fence) return { result: 'NOT_OWNER', pending: false };

    const settle = async (step: SweepStep): Promise<SweepStep> => {
      if (step.pending) await this.sweeps.renew(tx, window, fence, leaseSeconds);
      else await this.sweeps.release(tx, window, fence);
      return step;
    };

    if (window.status === 'OPEN') {
      // After the lock: a long wait for it cannot leave the decision before the end.
      const now = await this.clock.now(tx);
      if (now.getTime() < window.closesAt.getTime()) {
        return settle({ result: 'NOT_DUE', pending: false });
      }
      const ended = await this.windowEnd.end(tx, window, now);
      return settle({ result: 'ENDED', outcome: ended.outcome, pending: ended.pending });
    }

    if (endPending(window)) {
      const now = await this.clock.now(tx);
      const pending = await this.windowEnd.carryOn(tx, window, now);
      return settle({ result: 'FOLLOWED', pending });
    }

    return settle({ result: 'NOOP', pending: false });
  }
}
