import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { EventEnvelope } from '@rasta/contracts';
import type { EventConsumer, EventDelivery } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import { AuditRepository } from '../audit/audit.repository';
import {
  DOMAIN_PROJECTOR_CONSUMER,
  describePayloadKeys,
  toAuditEventRecord,
} from '../audit/audit.mapper';
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

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.stop();
  }

  /** Exposed for the readiness probe: a projector that is not running is not ready. */
  isRunning(): boolean {
    return this.consumer !== undefined;
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

    try {
      const outcome = await this.repository.ingest(record, DOMAIN_PROJECTOR_CONSUMER);

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
