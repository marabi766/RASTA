import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@rasta/contracts';
import type { EventConsumer, EventHandler } from '@rasta/nest-common';
import { usageReadingsAppliedTotal } from '../observability/metrics';
import { SERVICE_NAME } from '../config/env';
import { MaintenanceRepository } from '../maintenance/maintenance.repository';
import { DueAnnouncerService } from '../maintenance/due-announcer.service';
import { CONSUMED_EVENTS, usageRecordedSchema } from '../maintenance/events';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';

/**
 * Turns fleet-service's usage stream into a service schedule that knows how
 * much a machine has run.
 *
 * This is the reason maintenance-service exists in the shape it does. docs/04
 * § 4.6 puts it plainly: `USAGE_RECORDED` is the trigger for preventive
 * maintenance, and "سرویس هر ۲۵۰ ساعت" is evaluated by this service consuming
 * this stream. Until now the event had no consumer at all.
 *
 * Three properties matter, and each has a specific failure it prevents:
 *
 *   **Idempotent.** The outbox guarantees at-least-once delivery, so this
 *   event *will* arrive twice. The `processed_event` marker and the meter
 *   update commit in one transaction, so a redelivery finds the marker and
 *   stops. Without it, a replayed week of readings would add a week of hours
 *   the machine never ran and push every service into the future — the exact
 *   double-count fleet-service's own event contract warns about.
 *
 *   **Monotonic.** A reading may carry a delta, an instrument reading, or
 *   both, and fleet-service requires only one of hours or kilometres. The
 *   meter takes the greater of "what the instrument says" and "what we had
 *   plus the delta", so both kinds of reading fold into one number that only
 *   moves forward.
 *
 *   **Event-driven evaluation.** Once a reading lands, the machine's
 *   schedules are assessed immediately and any that have come due announce
 *   themselves. No scan, no delay — which is what docs/08 § 8.7 means by
 *   usage-based maintenance being event-driven.
 *
 * The tenant comes from the envelope, never from a lookup: there is no request
 * here, and the `EventConsumer` has already entered the event's organization
 * before this handler runs, so every scoped write below is guarded exactly as
 * an HTTP write would be.
 */

const CONSUMER_NAME = 'maintenance-service.usage';

/**
 * Builds the broker-facing half.
 *
 * Passed in rather than constructed here so this class stays a plain
 * projector: a test hands it `null` and calls `handle()` directly, with no
 * broker and no mocking of kafkajs. It takes the handler as an argument
 * because the consumer needs a callback and the callback needs this instance —
 * a factory resolves that circle without a mutable placeholder.
 */
export type EventConsumerFactory = (handler: EventHandler) => EventConsumer;

@Injectable()
export class UsageConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UsageConsumer.name);
  private consumer?: EventConsumer;

  constructor(
    private readonly consumerFactory: EventConsumerFactory | null,
    private readonly repository: MaintenanceRepository,
    private readonly announcer: DueAnnouncerService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Null in tests and in any run without a broker. The service stays useful
    // without Kafka; usage-based schedules simply stop advancing, and — because
    // due state is derived rather than stored — they report against the last
    // reading that did arrive rather than reporting nothing.
    if (!this.consumerFactory) {
      this.logger.warn('Usage consumer disabled — no Kafka broker configured');
      return;
    }
    this.consumer = this.consumerFactory((envelope) => this.handle(envelope));
    await this.consumer.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.stop();
  }

  /**
   * Handles one event.
   *
   * Exposed rather than private so a test can drive it directly with a
   * hand-built envelope — the folding rules are worth testing without a broker
   * in the loop.
   */
  async handle(envelope: EventEnvelope): Promise<void | 'SKIPPED'> {
    if (envelope.eventName !== CONSUMED_EVENTS.USAGE_RECORDED) {
      // `rasta.fleet.v1` carries driver registrations, assignments and
      // availability declarations too. Ignoring them is normal operation, not
      // an error, and forward compatibility depends on it (docs/07 § 7.6).
      return 'SKIPPED';
    }

    const parsed = usageRecordedSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      // A usage event that names no machine, or no record. A producer defect
      // worth seeing, but not one a retry fixes — so it is logged and skipped
      // rather than dead-lettered, where it would only be quieter.
      this.logger.warn(
        `${envelope.eventName} ${envelope.eventId} is not a usable usage reading; skipping`,
      );
      return 'SKIPPED';
    }

    const payload = parsed.data;
    const organizationId = payload.organizationId ?? envelope.tenantId;

    if (!organizationId) {
      // Without a tenant there is no organization to scope the meter to.
      // Guessing one would be inventing the fact the meter exists to carry.
      this.logger.warn(`${envelope.eventName} ${envelope.eventId} carries no tenant; skipping`);
      return 'SKIPPED';
    }

    const now = new Date();

    const applied = await this.repository.transaction(async (tx: ExtendedPrismaClient) => {
      // The idempotency marker and the meter update commit together, so a
      // crash between them cannot leave the event marked handled with the
      // hours unrecorded — or, worse, the hours recorded twice on the retry.
      const fresh = await this.repository.markEventProcessed(tx, envelope.eventId, CONSUMER_NAME);
      if (!fresh) {
        this.logger.debug(`${envelope.eventName} ${envelope.eventId} already applied`);
        return false;
      }

      await this.repository.foldUsageIntoMeter(tx, {
        assetId: payload.assetId,
        organizationId,
        // Absent is zero for a delta: fleet-service requires at least one of
        // hours or kilometres, so a reading with only kilometres is valid and
        // must not be refused.
        hoursDelta: payload.hours ?? '0',
        kilometresDelta: payload.kilometres ?? '0',
        reportedHourMeter: payload.hourMeter ?? null,
        reportedOdometer: payload.odometer ?? null,
        usageRecordId: payload.usageRecordId,
        periodEnd: payload.periodEnd ? new Date(payload.periodEnd) : null,
        now,
      });

      return true;
    });

    if (!applied) return 'SKIPPED';

    usageReadingsAppliedTotal.inc({ service: SERVICE_NAME });

    // Assessed after the meter is durable, and in its own transaction: the
    // reading is a fact that must survive even if announcing fails, and an
    // announcement that failed is retried on the next reading or by the scan.
    await this.announcer.announceForAsset(payload.assetId, now);
  }
}

export { CONSUMER_NAME };
