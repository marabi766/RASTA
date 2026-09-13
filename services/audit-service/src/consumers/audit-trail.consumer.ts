import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { EventEnvelope } from '@rasta/contracts';
import type { EventConsumer, EventDelivery } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
// Type-only, like `Logger` above: this provider is built by an explicit
// `useFactory` in `app.module.ts`, exactly as the domain projector is.
import type { AuditRepository, IngestOutcome } from '../audit/audit.repository';
import { describePayloadKeys, type AuditEventRecord } from '../audit/audit.mapper';
import {
  AUDIT_TRAIL_CONSUMER,
  AuditTrailRejectedError,
  toAuditTrailRecord,
} from '../audit/audit-trail.mapper';
import type { ConsumerFactory } from './domain-projector.consumer';
import {
  auditIngestionFailuresTotal,
  auditIngestionLagSeconds,
  auditRecordsIngestedTotal,
  INGESTION_FAILURE_REASONS,
} from '../observability/metrics';

/** An event name as the envelope contract spells one, and bounded. */
const SAFE_EVENT_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

/** An identifier-shaped value — a ULID or similar — and nothing longer. */
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;

/** A Prisma error code: `P` and four digits, never a message. */
const PRISMA_ERROR_CODE = /^P\d{4}$/;

/** An error class name, which is code-authored rather than data-derived. */
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/**
 * Names a message for a log line without trusting anything in it.
 *
 * Called on the rejection path too, where the envelope may not have parsed at
 * all, so each identifier is printed only if it has the shape an identifier
 * has — otherwise a placeholder. A producer that put a value where an id
 * belongs gets a placeholder, never its value in the log.
 */
function describeMessage(envelope: unknown): string {
  const candidate = (typeof envelope === 'object' && envelope !== null ? envelope : {}) as {
    eventName?: unknown;
    eventId?: unknown;
  };
  const name =
    typeof candidate.eventName === 'string' && SAFE_EVENT_NAME.test(candidate.eventName)
      ? candidate.eventName
      : '(unnamed event)';
  const id =
    typeof candidate.eventId === 'string' && SAFE_IDENTIFIER.test(candidate.eventId)
      ? candidate.eventId
      : '(unidentified)';
  return `${name} ${id}`;
}

function payloadOf(envelope: unknown): unknown {
  return typeof envelope === 'object' && envelope !== null
    ? (envelope as { payload?: unknown }).payload
    : undefined;
}

/**
 * The database refused or was unreachable, described by class and code only.
 *
 * Why the original error is not rethrown as it is: its message is what the
 * shared consumer logs on every attempt and copies into the dead-letter
 * `x-dlq-error` header, and a Prisma message can quote the arguments of the
 * statement that failed — which for this table are the evidence itself. The
 * original stays reachable as `cause` for anyone debugging in-process; it is
 * never serialised by `EventConsumer`, which prints `name: message` only.
 */
export class AuditTrailPersistenceError extends Error {
  constructor(eventId: string, cause: unknown) {
    super(
      `audit trail record ${SAFE_IDENTIFIER.test(eventId) ? eventId : '(unidentified)'} ` +
        `was not persisted (${describeDatabaseError(cause)})`,
      { cause },
    );
    this.name = 'AuditTrailPersistenceError';
  }
}

function describeDatabaseError(error: unknown): string {
  const name = error instanceof Error && SAFE_ERROR_NAME.test(error.name) ? error.name : 'Error';
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && PRISMA_ERROR_CODE.test(code) ? `${name} ${code}` : name;
}

/**
 * Path B of ADR-053: the explicit audit trail on `rasta.audit.trail.v1`.
 *
 * A consumer of its own, beside `DomainProjectorConsumer` rather than inside
 * it, for three reasons that each hold on their own:
 *
 *   group        `audit-service.trail`, fixed. Sharing the projector's group
 *                would put a lagging domain topic and the trail on one
 *                rebalance, and a stalled trail would hide behind a healthy
 *                projector in every lag dashboard.
 *   idempotency  The consumer name is the `processed_event` key. A distinct
 *                name keeps the two paths' namespaces apart, so an event id a
 *                domain producer already used can never make this consumer
 *                skip a trail record as "already processed".
 *   posture      The projector is total and records whatever arrives; this one
 *                validates first and refuses what fails (see
 *                `audit-trail.mapper.ts`). Two handlers with opposite contracts
 *                behind one `eventName` switch is the kind of branch that gets
 *                "simplified" into the wrong one.
 *
 * ## Failure is loud, and never marks the event processed
 *
 * A rejected message and a database failure both throw. The shared
 * `EventConsumer` retries and then dead-letters, and because `processed_event`
 * is written in the same transaction as the row, nothing is marked processed
 * without its evidence.
 */
@Injectable()
export class AuditTrailConsumer implements OnModuleDestroy {
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

  /** Stops without discarding, so `isRunning()` keeps telling the truth. */
  async onModuleDestroy(): Promise<void> {
    await this.consumer?.stop();
  }

  /**
   * The readiness answer: the consumer's own running flag, never "a consumer
   * object was assigned" — for the same two reasons `DomainProjectorConsumer`
   * documents (a refused subscription, and a completed shutdown).
   */
  isRunning(): boolean {
    return this.consumer?.isRunning() ?? false;
  }

  async handle(envelope: EventEnvelope, delivery: EventDelivery): Promise<void> {
    let record: AuditEventRecord;
    try {
      record = toAuditTrailRecord(envelope, delivery);
    } catch (error) {
      // Every refusal the mapper makes is an `AuditTrailRejectedError`; the
      // fallback exists so an unexpected throw is still counted under a closed
      // label and still leaves the process carrying no value from the message.
      const rejection =
        error instanceof AuditTrailRejectedError
          ? error
          : { reason: INGESTION_FAILURE_REASONS.UNMAPPABLE_ENVELOPE, message: 'unmappable' };

      auditIngestionFailuresTotal.inc({ reason: rejection.reason });
      this.logger.error(
        `Rejected ${describeMessage(envelope)} from ${delivery.topic}[${delivery.partition}]: ` +
          `${rejection.message} (payload keys: ${describePayloadKeys(payloadOf(envelope))})`,
      );
      throw error instanceof AuditTrailRejectedError
        ? error
        : new Error(`audit trail message could not be mapped (${describeDatabaseError(error)})`);
    }

    let outcome: IngestOutcome;
    try {
      // No hierarchy projection: path B never carries organization structure.
      outcome = await this.repository.ingest(record, AUDIT_TRAIL_CONSUMER);
    } catch (error) {
      auditIngestionFailuresTotal.inc({ reason: INGESTION_FAILURE_REASONS.DATABASE_ERROR });
      // Rethrown, sanitised. Retry and DLQ belong to the shared consumer, and
      // swallowing here would let it commit an offset for a row that does not
      // exist. It logs this error on every attempt, so this handler does not.
      throw new AuditTrailPersistenceError(record.sourceEventId, error);
    }

    if (outcome === 'DUPLICATE') {
      // Routine under at-least-once delivery and `fromBeginning: true`. Not a
      // failure, not a success, and not counted as either.
      this.logger.debug?.(
        `${describeMessage(envelope)} already recorded from ${record.sourceTopic}`,
      );
      return;
    }

    auditRecordsIngestedTotal.inc({
      source_service: record.sourceService,
      source_topic: record.sourceTopic,
      outcome: record.outcome,
    });

    const lagSeconds = Math.max(0, (Date.now() - record.occurredAt.getTime()) / 1000);
    auditIngestionLagSeconds.observe({ source_topic: record.sourceTopic }, lagSeconds);
  }
}
