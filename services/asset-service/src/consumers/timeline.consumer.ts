import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import {
  UnprocessableEventError,
  invalidPayloadError,
  isRetryDelivery,
  missingTenantError,
  type EventConsumer,
  type EventDelivery,
  type EventHandler,
} from '@rasta/nest-common';
import {
  UNCONFIGURED_WORK_STATE_SOURCE,
  statusFromWorkState,
  type AssetWorkStateSource,
} from './work-state';
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
  // Nothing. `ORDER_COMPLETED` used to be listed (category COST, amount
  // `totalMinor`), but marketplace's real `orderCompletedPayload` names no
  // asset and calls its amount `totalAmountMinor`: every order completion was
  // skipped, and with L7-26 would have been dead-lettered. Order cost reaches
  // the dossier only once the marketplace contract carries an asset
  // association (review #205 r1, docs/07 § 7.6).

  // ---- construction-service -----------------------------------------------
  // Planned events with no producer yet (docs/04, docs/events/README.md); when
  // their contract is written it must name the asset, or the row goes.
  PROJECT_ASSET_ASSIGNED: { category: 'PROJECT', title: 'تخصیص به پروژه' },
  MISSION_STARTED: { category: 'PROJECT', title: 'شروع مأموریت' },
  MISSION_COMPLETED: { category: 'PROJECT', title: 'پایان مأموریت' },
};

const CONSUMER_NAME = 'asset-service.timeline';

/** The field names a malformed-payload refusal may repeat (S-09). */
const TIMELINE_SOURCE_FIELDS = Object.keys(timelineSourceSchema.shape);

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

/**
 * A refresh holds the asset's lock across two short exchanges with the owners
 * of its work (each bounded by its own deadline), so its transaction is given
 * room. Replays are rare operator actions; other deliveries for that asset wait.
 */
const REFRESH_TRANSACTION_TIMEOUT_MS = 30_000;

@Injectable()
export class TimelineConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TimelineConsumer.name);
  private consumer?: EventConsumer;

  constructor(
    private readonly consumerFactory: EventConsumerFactory | null,
    private readonly repository: AssetRepository,
    private readonly assets: AssetService,
    /** Read on a `.retry` delivery only; without one a replay is refused (fail closed). */
    private readonly workState: AssetWorkStateSource = UNCONFIGURED_WORK_STATE_SOURCE,
  ) {}

  async onModuleInit(): Promise<void> {
    // Null in tests and in any run without a broker. The service stays useful
    // without Kafka; the dossier simply stops growing from external sources.
    if (!this.consumerFactory) {
      this.logger.warn('Timeline consumer disabled — no Kafka broker configured');
      return;
    }
    this.consumer = this.consumerFactory((envelope, delivery) => this.handle(envelope, delivery));
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
  async handle(envelope: EventEnvelope, delivery?: EventDelivery): Promise<void | 'SKIPPED'> {
    const projection = PROJECTIONS[envelope.eventName];
    // Topics carry more than this service cares about. Ignoring the rest is
    // normal operation, not an error.
    if (!projection) return 'SKIPPED';

    const parsed = timelineSourceSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      // The event is one we project, but it does not name an asset: a producer
      // defect no retry fixes. Dead-lettered at once, before the marker, so the
      // dossier entry is not lost and a corrected replay is still applied
      // (audit L7-26, docs/07 § 7.6).
      throw invalidPayloadError(envelope, parsed.error, TIMELINE_SOURCE_FIELDS);
    }

    // Without a tenant there is no organization to scope the write to. For an
    // event this service projects that is a broken producer, and a silent skip
    // would lose the dossier entry without a trace: dead-lettered at once,
    // before the marker, so a corrected replay is still applied (audit L7-26).
    if (!envelope.tenantId) {
      throw missingTenantError(envelope);
    }

    const payload = parsed.data as Record<string, unknown>;
    const assetId = payload.assetId as string;

    // D-039: a delivery on `<topic>.retry` may be older than events applied
    // since (the two are separate streams). Its status is not taken from the
    // payload: under the asset's exclusive lock — the one every delivery takes,
    // so no newer event can commit between the read and the write — it is
    // derived from what fleet-service and maintenance-service say now. No
    // answer from either throws (rolling the marker back: retry, then DLQ). An
    // asset absent from the event's organization is a refusal, not a skip:
    // SOURCE_UNCONFIRMED. The dossier entry is a fact and is written as usual.
    const replayed = delivery !== undefined && isRetryDelivery(delivery);
    const unconfirmed = () =>
      new UnprocessableEventError(
        DLQ_REASONS.SOURCE_UNCONFIRMED,
        `${envelope.eventName} ${envelope.eventId} names an asset that does not belong to the organization it names`,
      );

    const asset = await this.repository.findById(assetId);
    if (!asset) {
      if (replayed) throw unconfirmed();
      // Read in the event's tenant. Nothing there means one of two things,
      // and they are not equally harmless, so they are told apart.
      await this.skipped(envelope, assetId);
      return 'SKIPPED';
    }

    const appended = await this.repository.transaction(
      async (tx) => {
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
          if (replayed) throw unconfirmed();
          await this.skipped(envelope, assetId);
          return false;
        }

        // The idempotency ledger, the entry and the status change commit
        // together (AGENTS.md A-09). If the marker committed alone, a crash
        // before the status change would lose it for good: the redelivery
        // finds the marker and skips (audit L4-03).
        const fresh = await this.repository.markEventProcessed(tx, envelope.eventId, CONSUMER_NAME);
        if (!fresh) return false;

        // Read under the lock just taken; the network is bounded by the client's
        // deadline. On the original topic the payload's status stands.
        const status: AssetStatus | undefined =
          projection.status && replayed
            ? statusFromWorkState(await this.workState.read(asset.organizationId, assetId))
            : projection.status;

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
        if (status && !(replayed && status === locked.status)) {
          await this.assets.applyEventStatusChange(
            tx,
            assetId,
            status,
            `${envelope.eventName} از ${envelope.producer}`,
          );
        }

        return true;
      },
      replayed ? { timeoutMs: REFRESH_TRANSACTION_TIMEOUT_MS } : undefined,
    );

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
