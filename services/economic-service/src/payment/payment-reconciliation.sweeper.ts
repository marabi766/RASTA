import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { createSystemContext, runWithContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import {
  paymentReconcilerInterval,
  paymentReconcilerLastSweep,
  paymentReconciliationEscalated,
  paymentReconciliationOldestDueAge,
  paymentReconciliationOpen,
  paymentReconciliationTotal,
} from '../observability/metrics';
import { ENV } from '../tokens';
import { SERVICE_NAME, type EconomicEnv } from '../config/env';
import {
  PaymentReconciliationRepository,
  type HealCursor,
} from './payment-reconciliation.repository';
import { PaymentReconciler, type ReconcileResult } from './payment-reconciler';

export interface SweepOutcome {
  claimed: number;
  resolved: number;
  noop: number;
  retried: number;
  deferred: number;
  escalated: number;
  /** The lease was taken back before the write: nothing moved. */
  lost: number;
  /** Tasks opened for markers a B0 instance left without one. */
  healedOpened: number;
  /** Open tasks closed because their intent was settled without them. */
  healedClosed: number;
}

/**
 * Works B1's queue (ADR-064 step B2): the durable payment reconciler.
 *
 * In-process on a timer, not in Temporal: economic has no worker (ADR-031,
 * ADR-064 § 7), and all state is in the rows. Each sweep:
 *
 *   1. **heals** the queue both ways, bounded (Codex on #161, HIGH 1): a
 *      marker with no open task gets one; an open task whose intent was
 *      settled without it is closed, with no money action;
 *   2. **claims** a batch of due tasks (`FOR UPDATE SKIP LOCKED`, a lease and
 *      a fencing token), so any number of replicas may run it;
 *   3. **reconciles** each in its own tenant's context ({@link PaymentReconciler}).
 *
 * One task failing never stalls the batch. It never overlaps itself, and
 * `onApplicationShutdown` waits for a running sweep.
 */
@Injectable()
export class PaymentReconciliationSweeper implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentReconciliationSweeper.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<unknown>;
  /** Where the next heal windows start: bounded work per sweep (Codex on #164). */
  private healCursor: HealCursor = { missing: null, stale: null };

  constructor(
    private readonly tasks: PaymentReconciliationRepository,
    private readonly reconciler: PaymentReconciler,
    @Inject(ENV) private readonly env: EconomicEnv,
  ) {}

  onModuleInit(): void {
    if (!this.env.ECONOMIC_PAYMENT_RECONCILER_ENABLED) {
      this.logger.warn('The payment reconciler is disabled by configuration');
      return;
    }
    const intervalSeconds = this.env.ECONOMIC_PAYMENT_RECONCILER_INTERVAL_SECONDS;
    // Set at start-up so a sweeper that never completes a sweep still goes stale.
    paymentReconcilerInterval.set({ service: SERVICE_NAME }, intervalSeconds);
    paymentReconcilerLastSweep.set({ service: SERVICE_NAME }, Date.now() / 1000);
    this.timer = setInterval(() => {
      // Never overlap with itself: a slow sweep is followed by the next tick.
      if (this.inFlight) return;
      this.inFlight = this.runOnce()
        .catch((error: unknown) => {
          // A sweep that fails as a whole (the database is down) is retried
          // by the next tick; the tasks are still queued.
          this.logger.error(
            'Payment reconciliation sweep failed',
            error instanceof Error ? error.stack : String(error),
          );
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }, intervalSeconds * 1000);
    this.timer.unref?.();
    this.logger.log(`Payment reconciler every ${intervalSeconds}s`);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  /** One sweep. Public so a test, or an operator's tool, can drive it. */
  async runOnce(): Promise<SweepOutcome> {
    const batch = this.env.ECONOMIC_PAYMENT_RECONCILER_BATCH_SIZE;
    const healed = await this.tasks.heal(batch, this.healCursor);
    this.healCursor = healed.cursor;
    if (healed.opened > 0) {
      paymentReconciliationTotal.inc(
        { service: SERVICE_NAME, result: 'healed_opened' },
        healed.opened,
      );
      this.logger.warn(`Payment reconciler opened ${healed.opened} missing task(s)`);
    }
    if (healed.closed > 0) {
      paymentReconciliationTotal.inc(
        { service: SERVICE_NAME, result: 'healed_closed' },
        healed.closed,
      );
      this.logger.warn(`Payment reconciler closed ${healed.closed} task(s) settled without them`);
    }

    const claimed = await this.tasks.claimDue(
      batch,
      this.env.ECONOMIC_PAYMENT_RECONCILER_LEASE_SECONDS,
      ulid(),
    );
    const outcome: SweepOutcome = {
      claimed: claimed.length,
      resolved: 0,
      noop: 0,
      retried: 0,
      deferred: 0,
      escalated: 0,
      lost: 0,
      healedOpened: healed.opened,
      healedClosed: healed.closed,
    };

    for (const task of claimed) {
      const context = createSystemContext({
        correlationId: task.correlationId,
        organizationId: task.organizationId,
      });
      let result: ReconcileResult;
      try {
        result = await runWithContext(context, () => this.reconciler.reconcile(task));
      } catch (error) {
        // The reconciler handles its own failures; this is the one it could
        // not even put back. The lease expires and the task is taken again.
        this.logger.error(
          `Reconciliation task ${task.id} failed outside its own handling`,
          error instanceof Error ? error.stack : String(error),
        );
        result = 'lost_lease';
      }
      tally(outcome, result);
    }

    await this.sampleBacklog();
    paymentReconcilerLastSweep.set({ service: SERVICE_NAME }, Date.now() / 1000);
    if (outcome.claimed > 0) {
      this.logger.log(
        `Payment reconciliation sweep: claimed ${outcome.claimed}, resolved ${outcome.resolved}, ` +
          `no-op ${outcome.noop}, retried ${outcome.retried}, deferred ${outcome.deferred}, ` +
          `escalated ${outcome.escalated}, lost ${outcome.lost}`,
      );
    }
    return outcome;
  }

  private async sampleBacklog(): Promise<void> {
    try {
      const backlog = await this.tasks.backlog();
      paymentReconciliationOpen.set({ service: SERVICE_NAME }, backlog.open);
      paymentReconciliationEscalated.set({ service: SERVICE_NAME }, backlog.escalated);
      paymentReconciliationOldestDueAge.set({ service: SERVICE_NAME }, backlog.oldestDueAgeSeconds);
    } catch (error) {
      this.logger.warn(
        `Payment reconciliation backlog could not be sampled: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function tally(outcome: SweepOutcome, result: ReconcileResult): void {
  switch (result) {
    case 'resolved_refunded':
    case 'resolved_declined':
    case 'resolved_not_reached':
    case 'resolved_uncredited':
      outcome.resolved += 1;
      return;
    case 'noop':
      outcome.noop += 1;
      return;
    case 'retried':
      outcome.retried += 1;
      return;
    case 'deferred':
      outcome.deferred += 1;
      return;
    case 'escalated':
      outcome.escalated += 1;
      return;
    case 'lost_lease':
      outcome.lost += 1;
  }
}
