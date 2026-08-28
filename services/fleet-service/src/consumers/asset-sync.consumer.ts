import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@rasta/contracts';
import type { EventConsumer, EventHandler } from '@rasta/nest-common';
import { FleetRepository } from '../fleet/fleet.repository';
import { CONSUMED_EVENTS, assetSourceSchema, type ConsumedEventName } from '../fleet/events';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';

/**
 * Keeps fleet's picture of the machines accurate.
 *
 * Two jobs, and they are worth telling apart because they fail differently:
 *
 *   **Replica.** `ASSET_*` events maintain `asset_ref`, so "which machines are
 *   free" is one indexed query instead of an HTTP call to asset-service per
 *   row. A stale replica means a slightly out-of-date availability listing.
 *
 *   **Safety.** `INSPECTION_FAILED` and `INSURANCE_EXPIRED` withdraw a machine
 *   from dispatch. The event catalogue is explicit that a failed inspection is
 *   a safety event, not an administrative one, and that fleet must act on it
 *   immediately rather than inspecting some other event's `result` field
 *   (docs/events/README.md § Insurance). A missed one of these means a machine
 *   that should be off the road being handed to a driver.
 *
 * Everything here is idempotent by construction: the `processed_event` row and
 * the effect commit in the same transaction, so a redelivery — which the
 * at-least-once outbox guarantees will happen — finds the marker and stops
 * (docs/07 § 7.5).
 */

/** What each consumed event does to the local picture. */
interface Projection {
  /** Applied on top of the existing replica row. */
  patch: (payload: Record<string, unknown>) => AssetRefPatch;
}

interface AssetRefPatch {
  organizationId?: string;
  name?: string | null;
  assetType?: string | null;
  assetTag?: string | null;
  status?: string;
  inMaintenance?: boolean;
  dispatchBlockedReason?: string | null;
  dispatchBlockedAt?: Date | null;
}

const PROJECTIONS: Record<ConsumedEventName, Projection> = {
  // ---- asset-service: the replica -----------------------------------------
  [CONSUMED_EVENTS.ASSET_CREATED]: {
    patch: (payload) => ({
      organizationId: str(payload.organizationId),
      name: str(payload.name) ?? null,
      assetType: str(payload.type) ?? null,
      assetTag: str(payload.assetTag) ?? null,
      status: str(payload.status) ?? 'REGISTERED',
    }),
  },
  [CONSUMED_EVENTS.ASSET_UPDATED]: {
    // Carries only the *names* of the changed fields, never their values
    // (docs/events/README.md § Asset), so there is nothing here to copy. The
    // row is touched so `syncedAt` records that the replica saw the change;
    // the values arrive with the next event that carries them.
    patch: () => ({}),
  },
  [CONSUMED_EVENTS.ASSET_ACTIVATED]: {
    patch: () => ({ status: 'ACTIVE' }),
  },
  [CONSUMED_EVENTS.ASSET_STATUS_CHANGED]: {
    patch: (payload) => ({ status: str(payload.newStatus) ?? undefined }),
  },
  [CONSUMED_EVENTS.ASSET_TRANSFERRED]: {
    patch: (payload) => ({
      // The machine moved to another organization. Following it matters: a
      // replica that kept the old owner would keep offering the machine in
      // the wrong organization's availability listing.
      organizationId: str(payload.toOrganizationId),
      // Its new owner must re-commission it, exactly as asset-service records.
      status: 'REGISTERED',
    }),
  },
  [CONSUMED_EVENTS.ASSET_DECOMMISSIONED]: {
    patch: () => ({ status: 'DECOMMISSIONED' }),
  },

  // ---- asset-service: safety ----------------------------------------------
  [CONSUMED_EVENTS.INSPECTION_FAILED]: {
    patch: () => ({
      dispatchBlockedReason: 'The most recent technical inspection failed',
      dispatchBlockedAt: new Date(),
    }),
  },
  [CONSUMED_EVENTS.INSURANCE_EXPIRED]: {
    patch: () => ({
      dispatchBlockedReason: 'The insurance policy has expired',
      dispatchBlockedAt: new Date(),
    }),
  },

  // ---- maintenance-service ------------------------------------------------
  // No producer exists yet. Subscribing anyway costs nothing — an empty topic
  // is free — and means launching maintenance-service is a deployment rather
  // than a change to this file.
  [CONSUMED_EVENTS.MAINTENANCE_STARTED]: {
    patch: () => ({ inMaintenance: true }),
  },
  [CONSUMED_EVENTS.MAINTENANCE_COMPLETED]: {
    patch: () => ({
      inMaintenance: false,
      // A completed repair clears the safety block: the machine has been
      // through a workshop, which is the event that resolves a failed
      // inspection. If it has not, the next inspection will say so and block
      // it again.
      dispatchBlockedReason: null,
      dispatchBlockedAt: null,
    }),
  },
};

const CONSUMER_NAME = 'fleet-service.asset-sync';

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
export class AssetSyncConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AssetSyncConsumer.name);
  private consumer?: EventConsumer;

  constructor(
    private readonly consumerFactory: EventConsumerFactory | null,
    private readonly repository: FleetRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    // Null in tests and in any run without a broker. The service stays useful
    // without Kafka; the replica simply stops tracking new machines.
    if (!this.consumerFactory) {
      this.logger.warn('Asset sync consumer disabled — no Kafka broker configured');
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
    const projection = PROJECTIONS[envelope.eventName as ConsumedEventName];
    // These topics carry far more than this service cares about — every asset
    // location update, every document attachment. Ignoring the rest is normal
    // operation, not an error, and forward compatibility depends on it
    // (docs/07 § 7.6).
    if (!projection) return 'SKIPPED';

    const parsed = assetSourceSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      // An event this service projects, that names no machine. A producer
      // defect worth seeing, but not one a retry fixes — so it is logged and
      // skipped rather than dead-lettered, where it would only be quieter.
      this.logger.warn(
        `${envelope.eventName} ${envelope.eventId} has no assetId; nothing to apply it to`,
      );
      return 'SKIPPED';
    }

    const payload = parsed.data as Record<string, unknown>;
    const assetId = payload.assetId as string;

    // The replica is keyed by asset and scoped by the tenant the *event*
    // declares, never by a request context — there is no request here. An
    // event with no tenant cannot be placed in an organization, and guessing
    // one would be inventing the fact the whole replica exists to carry.
    const organizationId =
      str(payload.organizationId) ?? str(payload.toOrganizationId) ?? envelope.tenantId;

    const existing = await this.repository.findAssetRef(assetId);

    if (!existing && !organizationId) {
      this.logger.warn(
        `${envelope.eventName} ${envelope.eventId} is the first sighting of ${assetId} ` +
          'but carries no tenant; cannot place it in an organization',
      );
      return 'SKIPPED';
    }

    const patch = projection.patch(payload);
    // Narrowed rather than asserted: the guard above already established that
    // one of these is present, and spelling it out here keeps that true if the
    // guard is ever edited.
    const tenant = patch.organizationId ?? existing?.organizationId ?? organizationId;
    if (!tenant) return 'SKIPPED';

    await this.repository.transaction(async (tx: ExtendedPrismaClient) => {
      // The idempotency marker and the effect commit together, so a crash
      // between them cannot leave the event marked handled with nothing to
      // show for it. A redelivery finds the marker and stops here.
      const fresh = await this.repository.markEventProcessed(tx, envelope.eventId, CONSUMER_NAME);
      if (!fresh) {
        this.logger.debug(`${envelope.eventName} ${envelope.eventId} already applied`);
        return;
      }

      await this.repository.upsertAssetRef(tx, {
        // The patch first, then the resolved values — never the other way
        // round. A patch key present but undefined (an ASSET_CREATED whose
        // payload omits the organization, with the tenant only on the
        // envelope) would otherwise overwrite the value resolved above with
        // `undefined`, and the row would be written with no organization.
        ...patch,
        id: assetId,
        // An existing row keeps its organization unless the event explicitly
        // moves it, which only a transfer does.
        organizationId: tenant,
        sourceEvent: envelope.eventName,
      });
    });
  }
}

/** Reads a string field, tolerating the absence the loose schema allows. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export { PROJECTIONS, CONSUMER_NAME };
