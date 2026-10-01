import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { EventEnvelope } from '@rasta/contracts';
import { originalDelivery, type EventConsumer, type EventDelivery } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
// Type-only: built by an explicit `useFactory` in `app.module.ts`, like the
// other two consumers.
import type { AuditRepository, IngestOutcome } from '../audit/audit.repository';
import type { AuditEventRecord } from '../audit/audit.mapper';
import {
  OPS_REPLAY_CONSUMER,
  OpsReplayRejectedError,
  toReplayExecutedRecord,
} from '../audit/ops-replay.mapper';
import type { ConsumerFactory } from './domain-projector.consumer';
import { replaySourceServiceLabel } from '../audit/audit-producer-topology';
import {
  auditIngestionFailuresTotal,
  auditIngestionLagSeconds,
  auditRecordsIngestedTotal,
  INGESTION_FAILURE_REASONS,
} from '../observability/metrics';

const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;
const PRISMA_ERROR_CODE = /^P\d{4}$/;
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/** An identifier for a log line, or a placeholder — never a value that is not id-shaped. */
function describeEventId(envelope: unknown): string {
  const eventId =
    typeof envelope === 'object' && envelope !== null
      ? (envelope as { eventId?: unknown }).eventId
      : undefined;
  return typeof eventId === 'string' && SAFE_IDENTIFIER.test(eventId) ? eventId : '(unidentified)';
}

function describeDatabaseError(error: unknown): string {
  const name = error instanceof Error && SAFE_ERROR_NAME.test(error.name) ? error.name : 'Error';
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && PRISMA_ERROR_CODE.test(code) ? `${name} ${code}` : name;
}

/**
 * The database refused or was unreachable, by class and code only — for the
 * reason `AuditTrailPersistenceError` gives: a Prisma message can quote the
 * statement's arguments, and this message reaches the log and `x-dlq-error`.
 */
export class OpsReplayPersistenceError extends Error {
  constructor(eventId: string, cause: unknown) {
    super(
      `replay record ${SAFE_IDENTIFIER.test(eventId) ? eventId : '(unidentified)'} ` +
        `was not persisted (${describeDatabaseError(cause)})`,
      { cause },
    );
    this.name = 'OpsReplayPersistenceError';
  }
}

/**
 * The replay record on `rasta.ops.replay.v1`: one row per executed DLQ replay
 * (`ops-replay.mapper.ts`).
 *
 * A consumer of its own, beside the domain projector and the trail consumer,
 * for their reasons: its group `audit-service.ops-replay` is fixed and is its
 * `processed_event` key, so no other path's event id can make it skip a
 * record; and it validates, where the projector records whatever arrives.
 *
 * A refusal and a database failure both throw, so the shared consumer retries
 * and then dead-letters; nothing is marked processed without its row.
 */
@Injectable()
export class OpsReplayConsumer implements OnModuleDestroy {
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

  /** Stops without discarding, so `isRunning()` keeps telling the truth. */
  async onModuleDestroy(): Promise<void> {
    await this.consumer?.stop();
  }

  isRunning(): boolean {
    return this.consumer?.isRunning() ?? false;
  }

  async handle(envelope: EventEnvelope, delivery: EventDelivery): Promise<void> {
    let record: AuditEventRecord;
    try {
      record = toReplayExecutedRecord(envelope, delivery);
    } catch (error) {
      const rejection =
        error instanceof OpsReplayRejectedError
          ? error
          : { reason: INGESTION_FAILURE_REASONS.UNMAPPABLE_ENVELOPE, message: 'unmappable' };
      auditIngestionFailuresTotal.inc({ reason: rejection.reason });
      this.logger.error(
        `Rejected replay record ${describeEventId(envelope)} from ` +
          `${delivery.topic}[${delivery.partition}]: ${rejection.message}`,
      );
      throw error instanceof OpsReplayRejectedError
        ? error
        : new Error(`replay record could not be mapped (${describeDatabaseError(error)})`);
    }

    let outcome: IngestOutcome;
    try {
      outcome = await this.repository.ingest(record, OPS_REPLAY_CONSUMER);
    } catch (error) {
      auditIngestionFailuresTotal.inc({ reason: INGESTION_FAILURE_REASONS.DATABASE_ERROR });
      throw new OpsReplayPersistenceError(record.sourceEventId, error);
    }

    if (outcome === 'DUPLICATE') {
      this.logger.debug?.(`replay record ${record.sourceEventId} already recorded`);
      return;
    }

    auditRecordsIngestedTotal.inc({
      source_service: replaySourceServiceLabel(record.sourceService),
      source_topic: record.sourceTopic,
      outcome: record.outcome,
    });
    const lagSeconds = Math.max(0, (Date.now() - record.occurredAt.getTime()) / 1000);
    auditIngestionLagSeconds.observe({ source_topic: record.sourceTopic }, lagSeconds);
  }
}
