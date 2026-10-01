import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { EventEnvelope } from '@rasta/contracts';
import { originalDelivery, type EventConsumer, type EventDelivery } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import type { TenderEvidenceRepository } from '../audit/tender-evidence.repository';
import {
  TenderEvidenceContinuityError,
  TenderEvidenceIdentityError,
  TenderEvidenceUnmappableError,
  toTenderEvidenceEvent,
} from '../audit/tender-evidence';
import type { ConsumerFactory } from './domain-projector.consumer';
import { auditIngestionFailuresTotal, INGESTION_FAILURE_REASONS } from '../observability/metrics';

/**
 * The tender-evidence projection (ADR-066 § 2-3, § 5): the bid receipt chain and the
 * record of every bid read, kept where construction-service cannot rewrite them.
 *
 * A consumer of its own, beside the domain projector, for the reasons the replay
 * consumer has: its group `audit-service.tender-evidence` is its `processed_event`
 * key, and it **validates** where the projector records whatever arrives. Events it
 * does not read are skipped (the domain projector records them as audit rows).
 *
 * ## Out of order is held, a break is loud
 *
 * The relay orders events only inside one claimed batch, so a receipt can arrive before
 * its predecessor. It is **never dead-lettered for that**: it is held durably
 * (`tender_receipt_pending`) and placed, with every successor held behind it, in the
 * transaction that appends its predecessor. A hole that stays open past
 * `AUDIT_TENDER_GAP_ALERT_SECONDS` is counted and alerted by the gap monitor.
 *
 * A fork — a second successor of one link, a receipt recorded twice — and an event whose
 * envelope and payload disagree about the tenant or the tender throw, so the shared
 * consumer retries and then dead-letters; each is counted under its own reason so the
 * existing ingestion alert fires. Neither is ever recorded "as is". Nothing is marked
 * processed without its row (or its held row).
 */
@Injectable()
export class TenderEvidenceConsumer implements OnModuleDestroy {
  private consumer?: EventConsumer;

  constructor(
    private readonly createConsumer: ConsumerFactory,
    private readonly repository: TenderEvidenceRepository,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    this.consumer = this.createConsumer((envelope, delivery) =>
      this.handle(envelope, originalDelivery(delivery)),
    );
    await this.consumer.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.stop();
  }

  isRunning(): boolean {
    return this.consumer?.isRunning() ?? false;
  }

  async handle(envelope: EventEnvelope, _delivery: EventDelivery): Promise<void> {
    let event;
    try {
      event = toTenderEvidenceEvent(envelope);
    } catch (error) {
      if (error instanceof TenderEvidenceIdentityError) {
        auditIngestionFailuresTotal.inc({
          reason: INGESTION_FAILURE_REASONS.TENDER_EVIDENCE_MISMATCH,
        });
        this.logger.error(error.message);
      } else if (error instanceof TenderEvidenceUnmappableError) {
        auditIngestionFailuresTotal.inc({ reason: INGESTION_FAILURE_REASONS.UNMAPPABLE_ENVELOPE });
        // Identifiers only; the payload is never logged.
        this.logger.error(error.message);
      }
      throw error;
    }
    if (!event) return;

    try {
      if (event.kind === 'RECEIPT') {
        await this.repository.appendLink(event.eventId, event.payload);
      } else {
        await this.repository.recordAccess(event.eventId, event.payload);
      }
    } catch (error) {
      if (error instanceof TenderEvidenceContinuityError) {
        auditIngestionFailuresTotal.inc({ reason: INGESTION_FAILURE_REASONS.TENDER_CHAIN_FORK });
        this.logger.error(error.message);
      } else if (error instanceof TenderEvidenceIdentityError) {
        auditIngestionFailuresTotal.inc({
          reason: INGESTION_FAILURE_REASONS.TENDER_EVIDENCE_MISMATCH,
        });
        this.logger.error(error.message);
      } else {
        auditIngestionFailuresTotal.inc({ reason: INGESTION_FAILURE_REASONS.DATABASE_ERROR });
      }
      // Rethrown: retry and the dead-letter topic belong to the shared consumer.
      throw error;
    }
  }
}
