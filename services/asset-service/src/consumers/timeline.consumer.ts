import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@rasta/contracts';
import type { EventConsumer, EventHandler } from '@rasta/nest-common';
import { AssetRepository } from '../asset/asset.repository';
import { AssetService } from '../asset/asset.service';
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
      // Either the asset belongs to another deployment, or it was deleted.
      // Not an error: the projector's job is to record history for assets it
      // owns, and it owns none by this id.
      this.logger.debug(`No local asset ${assetId} for ${envelope.eventName}`);
      return 'SKIPPED';
    }

    const appended = await this.repository.transaction(async (tx) => {
      // The idempotency ledger and the entry commit together, so a crash
      // between them cannot leave the event marked handled with nothing to
      // show for it.
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

      return true;
    });

    if (!appended) return 'SKIPPED';

    // Applied after the entry is durable, and in its own transaction: the
    // history is a record of what happened and must survive even if the status
    // change turns out to be illegal from the asset's current state.
    if (projection.status) {
      await this.assets.applyEventStatusChange(
        assetId,
        projection.status,
        `${envelope.eventName} از ${envelope.producer}`,
      );
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
