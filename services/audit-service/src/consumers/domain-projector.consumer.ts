import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { EventEnvelope } from '@rasta/contracts';
import type { EventConsumer, EventDelivery } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
// Type-only, like `Logger` above: this provider is built by an explicit
// `useFactory` in `app.module.ts`, so Nest never reads `design:paramtypes` for
// it and no constructor parameter here doubles as an injection token.
import type { AuditRepository } from '../audit/audit.repository';
import {
  DOMAIN_PROJECTOR_CONSUMER,
  describePayloadKeys,
  toAuditEventRecord,
} from '../audit/audit.mapper';
import {
  toOrganizationProjection,
  type OrganizationProjection,
} from '../audit/organization-projection';
import {
  auditIngestionFailuresTotal,
  auditIngestionLagSeconds,
  auditRecordsIngestedTotal,
  INGESTION_FAILURE_REASONS,
} from '../observability/metrics';

/** Builds the platform consumer this projector runs on. */
export type ConsumerFactory = (
  handler: (envelope: EventEnvelope, delivery: EventDelivery) => Promise<void>,
) => EventConsumer;

/**
 * Path A of ADR-053: every domain envelope becomes one audit row.
 *
 * ## Why this handler has no event-name switch
 *
 * Every other consumer in this repository branches on `eventName` and ignores
 * what it does not recognise. This one must not. An audit store that silently
 * skipped an unfamiliar event would be at its least reliable exactly when it
 * matters most — the day a new service ships and nobody notices its actions are
 * unrecorded. So the handler is total: it maps, it writes, and an unknown name
 * is stored under its own name (ADR § 12).
 *
 * ## Failure is loud, and never marks the event processed
 *
 * A database failure throws. The shared `EventConsumer` then retries and
 * eventually dead-letters, and because `processed_event` is written in the same
 * transaction as the row, nothing was marked processed. That is the invariant
 * worth protecting: an event marked processed without its evidence is a record
 * lost with no trace that it was lost.
 */
@Injectable()
export class DomainProjectorConsumer implements OnModuleDestroy {
  private consumer?: EventConsumer;

  constructor(
    private readonly createConsumer: ConsumerFactory,
    private readonly repository: AuditRepository,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    this.consumer = this.createConsumer((envelope, delivery) => this.handle(envelope, delivery));
    await this.consumer.start();
  }

  /**
   * Nest calls this once, on `app.close()`, because `main.ts` enables shutdown
   * hooks. The consumer is stopped but deliberately **not** discarded: keeping
   * the reference is what lets `isRunning()` keep telling the truth afterwards,
   * and `EventConsumer.stop()` is idempotent, so a second call — a test, or a
   * framework that closed twice — disconnects nothing a second time.
   */
  async onModuleDestroy(): Promise<void> {
    await this.consumer?.stop();
  }

  /**
   * Exposed for the readiness probe: a projector that is not running is not
   * ready.
   *
   * Delegated to the consumer's own state rather than answered from "a consumer
   * object was assigned", and the difference is two real failures. `start()`
   * assigns before it awaits, so a broker that refuses the subscription — a
   * missing topic under `allowAutoTopicCreation: false`, which is exactly the
   * loud failure this service wants — would leave a consumer assigned and never
   * started. And a completed `onModuleDestroy()` leaves the reference in place.
   * Under the old answer both reported `projector: true` while nothing was
   * being ingested, which is precisely the silent gap ADR-053 § 3 names as the
   * risk that matters more than an outage.
   *
   * `EventConsumer` sets its flag only after `consumer.run()` resolves and
   * clears it in `stop()`, so that flag is the one fact worth reporting.
   */
  isRunning(): boolean {
    return this.consumer?.isRunning() ?? false;
  }

  async handle(envelope: EventEnvelope, delivery: EventDelivery): Promise<void> {
    let record;
    try {
      record = toAuditEventRecord(envelope, delivery);
    } catch (error) {
      auditIngestionFailuresTotal.inc({ reason: INGESTION_FAILURE_REASONS.UNMAPPABLE_ENVELOPE });
      // The event id, name and topic are identifiers, not content. The payload
      // is described by key names only — never values — because this line ends
      // up in a log aggregator with none of the audit store's access controls.
      this.logger.error(
        `Cannot map ${envelope.eventName} ${envelope.eventId} from ${delivery.topic} ` +
          `(payload keys: ${describePayloadKeys(envelope.payload)})`,
      );
      throw error;
    }

    // AUD-002. Three organization events also carry the hierarchy facts
    // `UNION_ADMIN` scoping is decided from, and a malformed one fails the
    // whole delivery rather than being skipped. That is the fail-closed choice:
    // recording the audit row and quietly dropping the hierarchy update would
    // leave the projection permanently wrong with nothing to notice, and a
    // wrong hierarchy is a cross-tenant read. Failing here retries and then
    // dead-letters — which alerts (ADR-053 § 9) — and leaves the event
    // unmarked, so a fixed producer replays it.
    let projection: OrganizationProjection | null;
    try {
      projection = toOrganizationProjection(envelope, delivery);
    } catch (error) {
      auditIngestionFailuresTotal.inc({
        reason: INGESTION_FAILURE_REASONS.UNMAPPABLE_ORGANIZATION_EVENT,
      });
      // Key names only, exactly as above. A rejected organization payload is
      // still a payload, and its values never reach a log line.
      this.logger.error(
        `Cannot project ${envelope.eventName} ${envelope.eventId} from ${delivery.topic} ` +
          `into the organization hierarchy (payload keys: ${describePayloadKeys(envelope.payload)})`,
      );
      throw error;
    }

    try {
      const outcome = await this.repository.ingest(record, DOMAIN_PROJECTOR_CONSUMER, projection);

      if (outcome === 'DUPLICATE') {
        // Not a failure and not counted as one. At-least-once delivery plus
        // `fromBeginning: true` makes replay routine.
        this.logger.debug?.(
          `${envelope.eventName} ${envelope.eventId} already recorded from ${delivery.topic}`,
        );
        return;
      }

      auditRecordsIngestedTotal.inc({
        source_service: record.sourceService,
        source_topic: record.sourceTopic,
        outcome: record.outcome,
      });

      // Measured from the domain time, not from when this process started
      // working: the number an operator needs is "how far behind the platform
      // is the evidence", and clamped at zero because a producer clock slightly
      // ahead of the database's would otherwise report negative lag.
      const lagSeconds = Math.max(0, (Date.now() - record.occurredAt.getTime()) / 1000);
      auditIngestionLagSeconds.set({ source_topic: record.sourceTopic }, lagSeconds);
    } catch (error) {
      auditIngestionFailuresTotal.inc({ reason: INGESTION_FAILURE_REASONS.DATABASE_ERROR });
      // Deliberately rethrown. Retry and DLQ belong to the shared consumer, and
      // swallowing here would mark the event handled while no row exists.
      throw error;
    }
  }
}
