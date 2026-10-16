import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import {
  UnprocessableEventError,
  invalidPayloadError,
  missingTenantError,
  type EventConsumer,
  type OutboxStopOptions,
} from '@rasta/nest-common';
import { z } from 'zod';
import { AssetRepository } from '../asset/asset.repository';
import { AssetService } from '../asset/asset.service';
import { UNCONFIGURED_DOCUMENT_LOOKUP, type DocumentLookup } from '../asset/document-lookup';
import type { EventConsumerFactory } from './timeline.consumer';

/**
 * Marks a claim's document reference `DOCUMENT_REMOVED` when document-service
 * deletes the file (docs/24 Q-128).
 *
 * ## Why this exists
 *
 * Attaching checks document-service before the commit and nothing holds its row
 * across it, so a document deleted in between is attached anyway. That is not
 * prevented — there is no cross-service reservation — but it is made visible and
 * self-healing: whichever side of the attach commit the deletion lands on, the
 * claim read shows the reference as removed. History is never deleted: the
 * reference stays, and the dossier gets one line.
 *
 * ## The owner check (A-13)
 *
 * A Kafka message is its publisher's claim. Before a reference is marked,
 * document-service is asked — as the organization the event names — whether the
 * file is gone (a `404` or `DELETED`). A document it still reports `REGISTERED`
 * is refused to the dead-letter topic (`SOURCE_UNCONFIRMED`), never marked; an
 * outage throws, so the delivery retries. The event's organization must equal
 * its envelope's tenant, and references are read and written through the
 * tenant-scoped client, so an event never reaches another organization's rows.
 *
 * ## The residual window
 *
 * An event consumed *before* the attach commit finds no reference to mark and
 * is a no-op; an attach that then commits stays `ATTACHED` until a later read
 * of document-service says otherwise. The window is the few milliseconds
 * between the attach's check and its commit, against the outbox's publish
 * latency. Recorded in Q-128.
 */

/** The fields of `DOCUMENT_DELETED` this consumer reads; the rest is not its business. */
const deletedSchema = z.object({
  documentId: z.string().min(1).max(64),
  organizationId: z.string().min(1).max(64),
  deletedAt: z.string().min(1),
});
const DELETED_FIELDS = Object.keys(deletedSchema.shape);

export const DOCUMENT_DELETED_EVENT = 'DOCUMENT_DELETED';
const CONSUMER_NAME = 'asset-service.document-removal';

@Injectable()
export class DocumentRemovalConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DocumentRemovalConsumer.name);
  private consumer?: EventConsumer;

  constructor(
    private readonly consumerFactory: EventConsumerFactory | null,
    private readonly repository: AssetRepository,
    private readonly assets: AssetService,
    private readonly lookup: DocumentLookup = UNCONFIGURED_DOCUMENT_LOOKUP,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.consumerFactory) {
      this.logger.warn('Document removal consumer disabled — no Kafka broker configured');
      return;
    }
    this.consumer = this.consumerFactory((envelope) => this.handle(envelope));
    await this.consumer.start();
  }

  stop(options?: OutboxStopOptions): Promise<void> {
    return this.consumer?.stop(options) ?? Promise.resolve();
  }

  onApplicationShutdown(): Promise<void> {
    return this.stop();
  }

  /** Exposed so a test can drive it with a hand-built envelope, no broker. */
  async handle(envelope: EventEnvelope): Promise<void | 'SKIPPED'> {
    if (envelope.eventName !== DOCUMENT_DELETED_EVENT) return 'SKIPPED';

    const parsed = deletedSchema.safeParse(envelope.payload);
    if (!parsed.success) throw invalidPayloadError(envelope, parsed.error, DELETED_FIELDS);
    if (!envelope.tenantId) throw missingTenantError(envelope);
    const { documentId, organizationId } = parsed.data;
    // The tenant the broker delivered it under and the organization it names
    // are one: otherwise the event is lying about whose document it is.
    if (organizationId !== envelope.tenantId) {
      throw new UnprocessableEventError(
        DLQ_REASONS.SOURCE_UNCONFIRMED,
        `${envelope.eventName} ${envelope.eventId} names an organization other than its tenant`,
      );
    }

    // Read in the event's tenant (the consumer's context): nothing here means
    // no claim of this organization holds the document — the normal case.
    const pending = await this.repository.client.insuranceClaimDocument.findMany({
      where: { documentId, documentRemovedAt: null },
      select: { id: true },
    });
    if (pending.length === 0) return 'SKIPPED';

    // A-13, outside the transaction: a network call holds no lock.
    const found = await this.lookup.find(documentId, organizationId);
    if (found !== null && found.status !== 'DELETED') {
      throw new UnprocessableEventError(
        DLQ_REASONS.SOURCE_UNCONFIRMED,
        `${envelope.eventName} ${envelope.eventId} names a document document-service still holds`,
      );
    }

    const removedAt = new Date(parsed.data.deletedAt);
    const stamp = Number.isNaN(removedAt.getTime()) ? new Date(envelope.occurredAt) : removedAt;

    const marked = await this.repository.transaction(async (tx) => {
      const fresh = await this.repository.markEventProcessed(tx, envelope.eventId, CONSUMER_NAME);
      if (!fresh) return 0;

      // Re-read under the transaction: a reference attached since, or already
      // marked by a redelivery, is judged on what is committed now.
      const refs = await tx.insuranceClaimDocument.findMany({
        where: { documentId, documentRemovedAt: null },
      });
      let count = 0;
      for (const ref of refs) {
        const result = await tx.insuranceClaimDocument.updateMany({
          where: { id: ref.id, documentRemovedAt: null },
          data: { documentRemovedAt: stamp },
        });
        if (result.count !== 1) continue;
        count += 1;
        // Its own source id: the claim's status history is read back by the
        // `<claimId>:` prefix, and a removed file is not a status.
        await this.assets.appendTimeline(tx, {
          assetId: ref.assetId,
          organizationId: ref.organizationId,
          eventName: envelope.eventName,
          sourceEventId: `${ref.id}:removed`,
          sourceService: envelope.producer,
          category: 'DOCUMENT',
          title: 'حذف مدرک پیوست‌شده به پرونده خسارت',
          detail: { claimId: ref.claimId, documentId, state: 'DOCUMENT_REMOVED' },
          occurredAt: stamp,
        });
      }
      return count;
    });

    if (marked === 0) return 'SKIPPED';
    this.logger.log(`${marked} claim document reference(s) marked DOCUMENT_REMOVED`);
  }
}
