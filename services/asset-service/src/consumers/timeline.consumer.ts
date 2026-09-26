import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@rasta/contracts';
import type { EventConsumer, EventHandler } from '@rasta/nest-common';
import { AssetRepository } from '../asset/asset.repository';
import { AssetService } from '../asset/asset.service';
import { SERVICE_NAME } from '../config/env';
import { timelineEventsSkippedTotal } from '../observability/metrics';
import { CONSUMED_EVENT_CATEGORY, timelineSourceSchema } from '../asset/events';
import type { AssetStatus } from '../asset/lifecycle';

/**
 * Builds the electronic dossier from other services' events.
 *
 * The product document promises that "every event recorded in the other
 * modules is automatically attached to the machine's file" (ch. 5.4). This is
 * the machinery behind that sentence — and the reason it works without
 * fleet-service, maintenance-service or marketplace-service knowing that a
 * dossier exists. They publish what happened in their own domain; the
 * projection into an asset's history happens here.
 *
 * The design consequence worth stating: adding a new source of history is a
 * row in `PROJECTIONS` and nothing else. No producer changes, no new endpoint,
 * no coordination release.
 */

interface Projection {
  /** Which section of the dossier the entry belongs to. */
  category: (typeof CONSUMED_EVENT_CATEGORY)[keyof typeof CONSUMED_EVENT_CATEGORY];
  /** Shown in the timeline. Persian — this text reaches the user unchanged. */
  title: string;
  /**
   * Status the asset moves to as a consequence, if any.
   *
   * Present only where another service genuinely owns the state: fleet-service
   * owns assignment, maintenance-service owns repair. The transition table
   * still has the final say — an event proposing an illegal move is logged and
   * ignored rather than forced through.
   */
  status?: AssetStatus;
  /** Payload field holding a cost, in minor units. */
  amountField?: string;
}

const PROJECTIONS: Record<string, Projection> = {
  // ---- fleet-service ------------------------------------------------------
  ASSET_ASSIGNED: { category: 'USAGE', title: 'تخصیص به راننده', status: 'ASSIGNED' },
  ASSIGNMENT_ENDED: { category: 'USAGE', title: 'پایان تخصیص', status: 'ACTIVE' },
  USAGE_RECORDED: { category: 'USAGE', title: 'ثبت کارکرد' },

  // ---- maintenance-service ------------------------------------------------
  MAINTENANCE_CREATED: { category: 'MAINTENANCE', title: 'ثبت درخواست نگهداری' },
  MAINTENANCE_STARTED: {
    category: 'MAINTENANCE',
    title: 'شروع تعمیر',
    status: 'IN_MAINTENANCE',
  },
  MAINTENANCE_COMPLETED: {
    category: 'MAINTENANCE',
    title: 'پایان تعمیر',
    status: 'ACTIVE',
    amountField: 'totalCostMinor',
  },
  REPAIR_COMPLETED: {
    category: 'MAINTENANCE',
    title: 'تکمیل تعمیر',
    amountField: 'totalCostMinor',
  },
  BREAKDOWN_REPORTED: { category: 'MAINTENANCE', title: 'گزارش خرابی' },

  // ---- marketplace-service ------------------------------------------------
  ORDER_COMPLETED: { category: 'COST', title: 'سفارش تکمیل‌شده', amountField: 'totalMinor' },

  // ---- construction-service -----------------------------------------------
  PROJECT_ASSET_ASSIGNED: { category: 'PROJECT', title: 'تخصیص به پروژه' },
  MISSION_STARTED: { category: 'PROJECT', title: 'شروع مأموریت' },
  MISSION_COMPLETED: { category: 'PROJECT', title: 'پایان مأموریت' },
};

const CONSUMER_NAME = 'asset-service.timeline';

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
export class TimelineConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TimelineConsumer.name);
  private consumer?: EventConsumer;

  constructor(
    private readonly consumerFactory: EventConsumerFactory | null,
    private readonly repository: AssetRepository,
    private readonly assets: AssetService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Null in tests and in any run without a broker. The service stays useful
    // without Kafka; the dossier simply stops growing from external sources.
    if (!this.consumerFactory) {
      this.logger.warn('Timeline consumer disabled — no Kafka broker configured');
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
   * hand-built envelope — the projection rules are worth testing without a
   * broker in the loop.
   */
  async handle(envelope: EventEnvelope): Promise<void | 'SKIPPED'> {
    const projection = PROJECTIONS[envelope.eventName];
    // Topics carry more than this service cares about. Ignoring the rest is
    // normal operation, not an error.
    if (!projection) return 'SKIPPED';

    const parsed = timelineSourceSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      // The event is one we project, but it does not name an asset. That is a
      // producer bug worth seeing, not something a retry fixes — so it is
      // logged and skipped rather than dead-lettered.
      this.logger.warn(
        `${envelope.eventName} ${envelope.eventId} has no assetId; nothing to attach it to`,
      );
      return 'SKIPPED';
    }

    // Without a tenant there is no organization to scope the write to. Skipped
    // rather than dead-lettered: a missing tenantId is a producer defect, and
    // parking the message in a DLQ would only move the defect somewhere quieter.
    if (!envelope.tenantId) {
      this.logger.warn(`${envelope.eventName} ${envelope.eventId} carries no tenantId`);
      return 'SKIPPED';
    }

    const payload = parsed.data as Record<string, unknown>;
    const assetId = payload.assetId as string;

    const asset = await this.repository.findById(assetId);
    if (!asset) {
      // Read in the event's tenant. Nothing there means one of two things,
      // and they are not equally harmless, so they are told apart.
      await this.skipped(envelope, assetId);
      return 'SKIPPED';
    }

    const appended = await this.repository.transaction(async (tx) => {
      // The asset row is locked first, and the lock also checks that the asset
      // still belongs to the organization read above. A transfer committed in
      // between would otherwise get an entry filed under the previous owner.
      // The lock is exclusive when a status change follows, so the change does
      // not have to upgrade a shared lock that another consumer also holds.
      const locked = await this.repository.lockAsset(
        tx,
        assetId,
        asset.organizationId,
        projection.status ? 'EXCLUSIVE' : 'SHARE',
      );
      if (!locked) {
        await this.skipped(envelope, assetId);
        return false;
      }

      // The idempotency ledger, the entry and the status change commit
      // together (AGENTS.md A-09). If the marker committed alone, a crash
      // before the status change would lose it for good: the redelivery
      // finds the marker and skips (audit L4-03).
      const fresh = await this.repository.markEventProcessed(tx, envelope.eventId, CONSUMER_NAME);
      if (!fresh) return false;

      await this.assets.appendTimeline(tx, {
        assetId,
        organizationId: asset.organizationId,
        eventName: envelope.eventName,
        sourceEventId: envelope.eventId,
        sourceService: envelope.producer,
        category: projection.category,
        title: projection.title,
        description: describePayload(payload),
        amountMinor: readAmount(payload, projection.amountField),
        detail: payload,
        occurredAt: new Date(envelope.occurredAt),
      });

      // The history is a record of what happened, and it survives a status
      // change that is illegal from the asset's current state: that case is
      // logged and ignored, not thrown. A conflict with a concurrent write
      // does throw, so everything above rolls back and the redelivery is
      // judged again.
      if (projection.status) {
        await this.assets.applyEventStatusChange(
          tx,
          assetId,
          projection.status,
          `${envelope.eventName} از ${envelope.producer}`,
        );
      }

      return true;
    });

    if (!appended) return 'SKIPPED';
  }

  /**
   * Records why an event was not attached (PR #108 review #1).
   *
   * `owner_changed` is the case that loses something: an assignment or a
   * repair published under the previous owner and consumed after a transfer.
   * Its dossier entry and status change are not applied, because filing the
   * previous owner's event under the new owner would cross the tenant
   * boundary. Kafka treats the message as handled, so the only trace is this
   * warning and `rasta_asset_timeline_events_skipped_total`, which an alert
   * watches (docs/23 records the risk). The unscoped read returns nothing
   * but whether the asset exists elsewhere.
   */
  private async skipped(envelope: EventEnvelope, assetId: string): Promise<void> {
    const elsewhere = await this.repository.assetExistsInAnyTenant(assetId);
    const reason = elsewhere ? 'owner_changed' : 'asset_unknown';
    timelineEventsSkippedTotal.inc({ service: SERVICE_NAME, event: envelope.eventName, reason });
    if (elsewhere) {
      this.logger.warn(
        `${envelope.eventName} ${envelope.eventId} names ${assetId}, which no longer belongs to ` +
          'the organization that published it; its dossier entry and status change are not applied',
      );
    } else {
      this.logger.debug(`No local asset ${assetId} for ${envelope.eventName}`);
    }
  }
}

/**
 * A one-line summary for the timeline.
 *
 * Reads a few conventional fields rather than dumping the payload: the full
 * body is kept in `detail` for anyone who needs it, and a dossier line that
 * spills JSON at the reader is not a dossier line.
 */
function describePayload(payload: Record<string, unknown>): string | undefined {
  for (const field of ['description', 'notes', 'summary', 'reason', 'title']) {
    const value = payload[field];
    if (typeof value === 'string' && value.length > 0) return value.slice(0, 500);
  }
  return undefined;
}

/**
 * Reads a money field.
 *
 * Money crosses the wire as a string in minor units (ADR-022), so this accepts
 * a string and refuses anything else — silently coercing a float here is how a
 * rounding error enters a cost report.
 */
function readAmount(payload: Record<string, unknown>, field: string | undefined): bigint | null {
  if (!field) return null;
  const raw = payload[field];
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return null;
  return BigInt(raw);
}

export { PROJECTIONS };
