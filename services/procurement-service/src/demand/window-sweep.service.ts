import { Injectable } from '@nestjs/common';
import { createSystemContext, runWithContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { DatabaseClock } from '../shared/clock';
import { SERVICE_NAME } from '../config/env';
import type { WindowOutcome } from './demand.state-machine';
import { WindowEnd, countWindowEnded } from './window-end';
import { WindowSweepRepository } from './window-sweep.repository';

/** What one step of the sweep of one window came to. */
export type SweepResult =
  /** The window ended here (READY, EXTEND, REFERRED or LAPSED), with its event. */
  | 'ENDED'
  /** A batch of an ended window's demands followed it. */
  | 'FOLLOWED'
  /** Ended by someone else and nothing left to follow: nothing written, the claim given back. */
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
  /** Demands still to follow after this step: another step is due while above 0. */
  demandsToFollow: number;
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
 *   (`WindowEnd.end`, the transition and event a late demand makes too) or move the next batch of
 *   an ended window's demands (`WindowEnd.follow`); renew the lease while demands are left to
 *   follow, release it when done.
 *
 * ## Idempotent, never two events
 *
 * A window that is no longer OPEN and has nothing to follow is `NOOP`: a second sweeper, a retry
 * after a crash between commit and acknowledgement, a demand that ended it first — all end in one
 * ended window and one event. A claim whose lease lapsed and was re-claimed is `NOT_OWNER`: the
 * fence guards the effect, not only the claim. The window's end and its event commit together or
 * not at all.
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
    if (!window) return { result: 'NOT_FOUND', demandsToFollow: 0 };

    // First: nothing below may run for a worker that no longer owns the claim.
    if (window.sweepFence !== fence) return { result: 'NOT_OWNER', demandsToFollow: 0 };

    const settle = async (step: SweepStep): Promise<SweepStep> => {
      if (step.demandsToFollow > 0) await this.sweeps.renew(tx, window, fence, leaseSeconds);
      else await this.sweeps.release(tx, window, fence);
      return step;
    };

    if (window.status === 'OPEN') {
      // After the lock: a long wait for it cannot leave the decision before the end.
      const now = await this.clock.now(tx);
      if (now.getTime() < window.closesAt.getTime()) {
        return settle({ result: 'NOT_DUE', demandsToFollow: 0 });
      }
      const ended = await this.windowEnd.end(tx, window, now);
      return settle({
        result: 'ENDED',
        outcome: ended.outcome,
        demandsToFollow: ended.demandsToFollow,
      });
    }

    if (window.demandsToFollow > 0) {
      const now = await this.clock.now(tx);
      const remaining = await this.windowEnd.follow(tx, window, now);
      return settle({ result: 'FOLLOWED', demandsToFollow: remaining });
    }

    return settle({ result: 'NOOP', demandsToFollow: 0 });
  }
}
