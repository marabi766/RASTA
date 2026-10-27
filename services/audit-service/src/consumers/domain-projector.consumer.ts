import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { EventEnvelope } from '@rasta/contracts';
import {
  originalDelivery,
  UnprocessableEventError,
  type EventConsumer,
  type EventDelivery,
} from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
// Type-only, like `Logger` above: this provider is built by an explicit
// `useFactory` in `app.module.ts`, so Nest never reads `design:paramtypes` for
// it and no constructor parameter here doubles as an injection token.
import type { AuditRepository } from '../audit/audit.repository';
import { DOMAIN_PROJECTOR_CONSUMER, toAuditEventRecord } from '../audit/audit.mapper';
import {
  ORGANIZATION_PROJECTION_FIELD_NAMES,
  toOrganizationProjection,
  type OrganizationProjection,
} from '../audit/organization-projection';
import {
  describeErrorClass,
  describeEventType,
  describeIssues,
  schemaRefusalOf,
} from '../audit/refusal-diagnostics';
import {
  toPaymentReconciliationEvidence,
  type PaymentReconciliationEvidence,
} from '../audit/payment-reconciliation-projection';
import { domainSourceServiceLabel } from '../audit/audit-producer-topology';
import {
  auditIngestionFailuresTotal,
  auditIngestionLagSeconds,
  auditRecordsIngestedTotal,
  INGESTION_FAILURE_REASONS,
} from '../observability/metrics';

/**
 * A domain envelope this projector could not map or project, described without
 * anything from its payload (see `refusal-diagnostics.ts`). Not an
 * `UnprocessableEventError`: like the error it replaces, it is retried and then
 * dead-lettered. The original is kept as `cause` for in-process debugging; the
 * shared consumer prints `name: message` only.
 */
export class AuditMappingError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'AuditMappingError';
  }
}

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
    this.consumer = this.createConsumer((envelope, delivery) =>
      this.handle(envelope, originalDelivery(delivery)),
    );
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
      // Nothing taken from the payload — not its values and not its key names,
      // which a producer chooses and can fill with an email address (S-09; PR
      // #378 r1 F3). The event type and version, validated, and the topic,
      // which is broker metadata. A refusal from a strict projection (the
      // contract and settlement refusal events) is already built from schema
      // paths and zod issue codes, and is rethrown as it is: the shared
      // consumer dead-letters it at once.
      const eventType = describeEventType(envelope);
      if (error instanceof UnprocessableEventError) {
        this.logger.error(`Cannot map ${eventType} from ${delivery.topic}: ${error.message}`);
        throw error;
      }
      // Anything else is rethrown as a fixed message naming its class only:
      // the original's message (a `BigInt` conversion quotes its input) is what
      // the shared consumer would log on every attempt and copy into
      // `x-dlq-error`. The original stays reachable as `cause` in-process.
      const refusal = new AuditMappingError(
        `audit record mapping failed for ${eventType} (${describeErrorClass(error)})`,
        error,
      );
      this.logger.error(`Cannot map ${eventType} from ${delivery.topic}: ${refusal.message}`);
      throw refusal;
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
      // Same rule as above. The schema's refusal is not rethrown as it is: an
      // issue path into an undeclared key would name that key. The refusal
      // names zod 3's issue codes (from the parse that refused, PR #444 r1 F1)
      // and declared field names only, bounded, and stays an ordinary error, so
      // it is retried and then dead-lettered as a malformed hierarchy event
      // always was. Anything else is named by its class.
      const schemaRefusal = schemaRefusalOf(error);
      const why =
        schemaRefusal === null
          ? `(${describeErrorClass(error)})`
          : describeIssues(schemaRefusal, ORGANIZATION_PROJECTION_FIELD_NAMES);
      const refusal = new AuditMappingError(
        `organization projection refused ${describeEventType(envelope)}: ${why}`,
        error,
      );
      this.logger.error(
        `Cannot project into the organization hierarchy from ${delivery.topic}: ${refusal.message}`,
      );
      throw refusal;
    }

    // D-046. The two payment-reconciliation events that record a human
    // decision also keep an allow-listed projection of who proposed, who
    // approved or acted, and on which evidence. Same fail-closed choice as the
    // hierarchy above, for the same reason: an audit row recorded without the
    // second actor and the evidence is the gap this projection closes, so a
    // known event that fails its contract writes nothing. The mapper throws
    // `UnprocessableEventError`, which the shared consumer dead-letters at
    // once — a malformed payload does not become well-formed on retry.
    let reconciliation: PaymentReconciliationEvidence | null;
    try {
      reconciliation = toPaymentReconciliationEvidence(envelope, delivery);
    } catch (error) {
      auditIngestionFailuresTotal.inc({
        reason: INGESTION_FAILURE_REASONS.UNMAPPABLE_RECONCILIATION_EVENT,
      });
      // Nothing taken from the payload — not even its key names, which a
      // producer can fill with text (S-09; Codex on #204). The event name is one
      // of the two fixed names this mapper accepts, the topic is broker
      // metadata, and the refusal's message is built from schema field names
      // and zod issue codes only. The event id is logged, escaped, by the
      // shared consumer that dead-letters the message.
      const why =
        error instanceof UnprocessableEventError
          ? error.message
          : 'the projection failed unexpectedly';
      this.logger.error(
        `Cannot project ${envelope.eventName} from ${delivery.topic} as payment-reconciliation ` +
          `evidence: ${why}`,
      );
      throw error;
    }

    try {
      const outcome = await this.repository.ingest(
        record,
        DOMAIN_PROJECTOR_CONSUMER,
        projection,
        reconciliation,
      );

      if (outcome === 'DUPLICATE') {
        // Not a failure and not counted as one. At-least-once delivery plus
        // `fromBeginning: true` makes replay routine.
        this.logger.debug?.(
          `${envelope.eventName} ${envelope.eventId} already recorded from ${delivery.topic}`,
        );
        return;
      }

      // The label is the topic owner's name only when the stored producer claim
      // agrees with it, otherwise `unknown`; never the raw claim, which is
      // producer-authored and would make the series count unbounded. The row
      // written above keeps the claim exactly as the producer sent it.
      auditRecordsIngestedTotal.inc({
        source_service: domainSourceServiceLabel(record.sourceTopic, record.sourceService),
        source_topic: record.sourceTopic,
        outcome: record.outcome,
      });

      // Measured from the domain time, not from when this process started
      // working: the number an operator needs is "how far behind the platform
      // is the evidence", and clamped at zero because a producer clock slightly
      // ahead of the database's would otherwise report negative lag.
      const lagSeconds = Math.max(0, (Date.now() - record.occurredAt.getTime()) / 1000);
      auditIngestionLagSeconds.observe({ source_topic: record.sourceTopic }, lagSeconds);
    } catch (error) {
      auditIngestionFailuresTotal.inc({ reason: INGESTION_FAILURE_REASONS.DATABASE_ERROR });
      // Deliberately rethrown. Retry and DLQ belong to the shared consumer, and
      // swallowing here would mark the event handled while no row exists.
      throw error;
    }
  }
}
