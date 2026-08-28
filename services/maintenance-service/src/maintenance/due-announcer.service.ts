import { Injectable, Logger } from '@nestjs/common';
import { createSystemContext, runWithContext } from '@rasta/nest-common';
import { dueAnnouncementsTotal } from '../observability/metrics';
import { MaintenanceRepository } from './maintenance.repository';
import { MAINTENANCE_EVENTS, validateMaintenancePayload } from './events';
import { MAINTENANCE_TOPIC, SERVICE_NAME } from '../config/env';
import { assessDue, isAnnounceable, type MeterReading } from './due';
import { toRule } from './schedule.service';
import type { ScheduleRow } from './views';

/**
 * Publishes `MAINTENANCE_DUE`.
 *
 * The distinction this class rests on is the one `due.ts` explains: due-ness
 * is **derived**, announcement is an **event**. Nothing here decides whether a
 * schedule is due — `assessDue` does that, from the rule, the meter and the
 * clock, every time anyone asks. What this does is notice that a schedule has
 * become due and tell the rest of the platform once.
 *
 * That matters for the failure mode. If announcement stops working, nobody is
 * *told* about a due service, but every screen and every API answer still
 * reports it correctly. The opposite design — a stored `due` flag set by a job
 * — fails the other way round, and reports a whole fleet as compliant.
 *
 * ## Announcing exactly once per cycle
 *
 * A usage-based schedule would otherwise announce on every reading that
 * arrives after it comes due, which for a machine working daily is a
 * notification a day until someone acts. `dueAnnouncedAt` is claimed with a
 * guarded update — `WHERE due_announced_at IS NULL` — and only the caller that
 * actually updated a row publishes.
 *
 * The same guard is what makes this safe on every replica at once. Two
 * instances that both decide a schedule is due both attempt the claim, exactly
 * one wins, and one event is published. No leader election, no lock, no
 * coordination — the invariant lives in the database, which is the only place
 * concurrent callers agree (ADR-027).
 *
 * The marker is cleared when the schedule is served, edited, or resumed, so
 * the next cycle announces again.
 */
@Injectable()
export class DueAnnouncerService {
  private readonly logger = new Logger(DueAnnouncerService.name);

  constructor(private readonly repository: MaintenanceRepository) {}

  /**
   * Assesses one schedule and announces it if it has come due.
   *
   * Returns whether an event was enqueued, which is what the callers count.
   * Runs inside the schedule's own organization: the tenant context is entered
   * here rather than assumed, so every write below is scoped by the same
   * extension that scopes an HTTP request — a background job is not trusted
   * more than a person is.
   */
  async announceIfDue(
    schedule: ScheduleRow & { organizationId: string },
    now: Date,
  ): Promise<boolean> {
    const meter = await this.repository.findMeter(schedule.assetId);
    const reading: MeterReading = {
      hourMeter: meter?.hourMeter?.toString() ?? null,
      odometer: meter?.odometer?.toString() ?? null,
    };

    const assessment = assessDue(toRule(schedule), reading, now);
    if (!isAnnounceable(assessment)) return false;

    return runWithContext(
      createSystemContext({
        correlationId: `maintenance-due-${schedule.id}`,
        organizationId: schedule.organizationId,
        callerService: SERVICE_NAME,
      }),
      async () =>
        this.repository.transaction(async (tx) => {
          // The claim and the event commit together. A crash between them
          // would either announce a schedule twice or mark one announced that
          // never was, and the second is the dangerous one — it would go
          // quiet until the schedule was next served.
          const claimed = await this.repository.claimDueAnnouncement(tx, schedule.id, now);
          if (!claimed) return false;

          await this.repository.enqueueEvent(tx, {
            aggregateType: 'MaintenanceSchedule',
            aggregateId: schedule.id,
            eventName: MAINTENANCE_EVENTS.MAINTENANCE_DUE,
            topic: MAINTENANCE_TOPIC,
            organizationId: schedule.organizationId,
            // Keyed by asset like every other event on this topic, so a
            // machine's whole maintenance story stays in one partition and in
            // order.
            partitionKey: schedule.assetId,
            payload: validateMaintenancePayload(MAINTENANCE_EVENTS.MAINTENANCE_DUE, {
              scheduleId: schedule.id,
              assetId: schedule.assetId,
              organizationId: schedule.organizationId,
              title: schedule.title,
              basis: assessment.basis ?? 'TIME',
              state: assessment.state,
              dueBy: assessment.dueBy,
              dueAtMeter: assessment.dueAtMeter,
            }),
          });

          dueAnnouncementsTotal.inc({
            service: SERVICE_NAME,
            basis: assessment.basis ?? 'TIME',
            state: assessment.state,
          });

          this.logger.log(
            `${schedule.id} is ${assessment.state} on ${assessment.basis ?? 'TIME'} for ${schedule.assetId}`,
          );

          return true;
        }),
    );
  }

  /**
   * Assesses every active schedule for one machine.
   *
   * Called when a usage reading arrives, which is what makes usage-based
   * maintenance event-driven rather than scanned — exactly as docs/08 § 8.7
   * prescribes. A machine with no schedules costs one indexed query and
   * nothing else.
   */
  async announceForAsset(assetId: string, now: Date): Promise<number> {
    const schedules = await this.repository.findActiveSchedulesForAsset(assetId);

    let announced = 0;
    for (const schedule of schedules) {
      // Sequential rather than parallel: the transactions contend on the same
      // few rows, and a machine has a handful of schedules, not hundreds.
      if (await this.announceIfDue(schedule as ScheduleRow & { organizationId: string }, now)) {
        announced += 1;
      }
    }

    return announced;
  }
}
