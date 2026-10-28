import { withinDeadline, type OutboxStopOptions } from '@rasta/nest-common';
import {
  outboxLeasesActive,
  outboxPendingAgeSeconds,
  outboxPendingTotal,
} from '@rasta/observability';
import { SERVICE_NAME } from '../config/env';
import type { PrismaOutboxStore } from '../outbox/outbox.store';
import { withCancellation } from '../prisma/cancellation';
import type { SecurityEventOutboxStore } from '../security-events/security-event-outbox.store';
import {
  securityEventOutboxClosedBacklogAgeSeconds,
  securityEventOutboxClosedBacklogTotal,
  securityEventOutboxLeasesActive,
  securityEventOutboxOpenWindows,
  securityEventOutboxPendingAgeSeconds,
  securityEventOutboxPendingTotal,
} from './security-event.metrics';

/** How often both outbox gauges are sampled from the database. */
export const OUTBOX_GAUGE_INTERVAL_MS = 15_000;

/**
 * Feeds the stuck-relay and audit-gap alerts. Age matters more than count: a
 * large backlog draining quickly is fine, while three rows stuck for ten
 * minutes is not.
 *
 * An `OutboxShutdown` worker (#458 r2 F2): its timer reads the business pool,
 * so it stops — the timer cleared, nothing more started on the database, the
 * sample in flight waited for by the deadline — before that pool closes.
 * Before, `AppModule` cleared it in `onApplicationShutdown`, after every
 * provider's destroy hook, the pool's disconnect included.
 */
export class OutboxGauges {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private readonly cancel = new AbortController();

  constructor(
    private readonly store: PrismaOutboxStore,
    private readonly securityStore: SecurityEventOutboxStore,
    private readonly intervalMs = OUTBOX_GAUGE_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer || this.cancel.signal.aborted) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop(options: OutboxStopOptions = {}): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.cancel.abort();
    if (!this.inFlight) return;
    if (options.deadlineAt === undefined) await this.inFlight;
    else await withinDeadline(this.inFlight, options.deadlineAt - Date.now());
  }

  /** One tick of its timer. Public so a test can drive it. */
  tick(): void {
    if (this.cancel.signal.aborted || this.inFlight) return;
    this.inFlight = withCancellation(this.cancel.signal, () => this.sample()).finally(() => {
      this.inFlight = undefined;
    });
  }

  private async sample(): Promise<void> {
    try {
      outboxPendingTotal.set({ service: SERVICE_NAME }, await this.store.pendingCount());
      outboxLeasesActive.set({ service: SERVICE_NAME }, await this.store.activeLeaseCount());
      outboxPendingAgeSeconds.set(
        { service: SERVICE_NAME },
        await this.store.oldestPendingAgeSeconds(),
      );
    } catch {
      // Metrics must never take the service down.
    }
    // Sampled separately, so a failure on one queue never blanks the other's.
    try {
      securityEventOutboxPendingTotal.set(await this.securityStore.pendingCount());
      securityEventOutboxLeasesActive.set(await this.securityStore.activeLeaseCount());
      securityEventOutboxPendingAgeSeconds.set(await this.securityStore.oldestPendingAgeSeconds());
      // Phase C2: an open window is expected to wait; a closed one is not.
      const backlog = await this.securityStore.aggregationBacklog();
      securityEventOutboxOpenWindows.set(backlog.openWindows);
      securityEventOutboxClosedBacklogTotal.set(backlog.closedBacklog);
      securityEventOutboxClosedBacklogAgeSeconds.set(backlog.closedBacklogAgeSeconds);
    } catch {
      // Metrics must never take the service down.
    }
  }
}
