import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { MaintenanceRepository } from './maintenance.repository';
import { DueAnnouncerService } from './due-announcer.service';
import { ENV } from '../tokens';
import type { MaintenanceEnv } from '../config/env';
import type { ScheduleRow } from './views';

/**
 * Notices that a date has passed.
 *
 * ## Why this exists at all
 *
 * Usage-based maintenance needs no timer: a reading arrives, the schedule is
 * evaluated, and it announces itself. That is what docs/08 § 8.7 means by
 * "نگهداری کارکردمحور رویدادمحور است" — usage-based maintenance is
 * event-driven. Time-based maintenance has no such trigger. Nothing happens
 * when a machine's oil-change date arrives; the date simply passes.
 *
 * ## Why it is a timer here and not a Temporal workflow
 *
 * docs/08 § 8.7 assigns that job to `MaintenanceDueScanWorkflow`, daily at
 * 06:00, in Temporal. Temporal is running in the local stack and no service on
 * this platform uses it — there is no worker, no task queue, no deployment
 * story and no operational experience with it. Standing all of that up is a
 * phase of its own, and doing it badly inside this one would give the platform
 * its first workflow engine integration as a side effect of a maintenance
 * feature.
 *
 * So the scan runs in-process, on a timer, and is switchable
 * (`MAINTENANCE_DUE_SCAN_ENABLED`). The design was chosen so that replacing it
 * is a deletion rather than a migration: this class does nothing except decide
 * *when* to call `DueAnnouncerService`, which is where all the behaviour lives
 * and which the usage path already calls. A Temporal workflow would call the
 * same method (ADR-027).
 *
 * ## Why it is safe on every replica
 *
 * It takes no lock and elects no leader. Announcement is claimed with a
 * guarded update inside the announcer, so several replicas scanning the same
 * schedule at the same moment produce exactly one event. Running this on three
 * instances is wasteful, not wrong.
 *
 * ## What it deliberately does not do
 *
 * It does not raise maintenance requests. Deciding that a due service becomes
 * a piece of work — and therefore that a machine will be taken off the road —
 * is an operational decision with a cost, and no document says the platform
 * makes it automatically. The scan announces; a person acts.
 */
@Injectable()
export class DueScanner implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DueScanner.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly repository: MaintenanceRepository,
    private readonly announcer: DueAnnouncerService,
    @Inject(ENV) private readonly env: MaintenanceEnv,
  ) {}

  onModuleInit(): void {
    if (!this.env.MAINTENANCE_DUE_SCAN_ENABLED) {
      this.logger.warn(
        'Time-based due scanning is disabled; usage-based schedules still announce on every reading',
      );
      return;
    }

    const intervalMs = this.env.MAINTENANCE_DUE_SCAN_INTERVAL_SECONDS * 1000;
    this.timer = setInterval(() => void this.scan(), intervalMs);
    // Do not hold the event loop open on shutdown.
    this.timer.unref?.();

    this.logger.log(
      `Scanning time-based schedules every ${this.env.MAINTENANCE_DUE_SCAN_INTERVAL_SECONDS}s`,
    );
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One pass.
   *
   * Public so an operator can force one during an incident and so a test can
   * drive it deterministically instead of waiting on a timer — the same
   * reasoning `OutboxRelay.tick()` uses.
   *
   * The overlap guard is not an optimisation: a slow pass overlapping the next
   * one would double the work on every schedule it is still holding, and while
   * the announcement guard makes that harmless it also makes it invisible.
   */
  async scan(now: Date = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      // Only schedules that have not announced their current cycle. A stable
      // fleet therefore costs one bounded, indexed query per pass rather than
      // a walk that grows with history.
      const candidates = await this.repository.claimUnannouncedSchedules(
        this.env.MAINTENANCE_DUE_SCAN_BATCH_SIZE,
      );

      let announced = 0;
      for (const schedule of candidates) {
        try {
          const published = await this.announcer.announceIfDue(
            schedule as ScheduleRow & { organizationId: string },
            // One `now` for the whole pass. Reading the clock per schedule
            // would let a batch straddle a due boundary and treat two
            // identical schedules differently.
            now,
          );
          if (published) announced += 1;
        } catch (error) {
          // One schedule's failure must not stop the sweep: the rest of the
          // fleet still needs announcing, and this one is picked up next pass
          // because its marker was never claimed.
          this.logger.error(`Failed to assess schedule ${schedule.id}: ${describe(error)}`);
        }
      }

      if (announced > 0) {
        this.logger.log(`Announced ${announced} of ${candidates.length} schedules as due`);
      }

      return announced;
    } catch (error) {
      // A failing scan must never take the service down. Requests still report
      // due state correctly, because they derive it.
      this.logger.error(`Due scan failed: ${describe(error)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
