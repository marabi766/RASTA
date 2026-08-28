import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@rasta/contracts';
import type { EventConsumer, EventHandler } from '@rasta/nest-common';
import { MaintenanceRepository } from '../maintenance/maintenance.repository';
import { CONSUMED_EVENTS, assetSourceSchema, type ConsumedEventName } from '../maintenance/events';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';

/**
 * Keeps maintenance's picture of the machines accurate.
 *
 * One job, and a narrow one: `asset_ref` exists so that raising a request or a
 * schedule against a machine can be refused *locally* — wrong tenant, or a
 * machine that has been decommissioned — instead of by an HTTP call to
 * asset-service on every write. That call would make reporting a breakdown
 * fail whenever asset-service is down, which is the wrong way round for a
 * safety report and the coupling docs/03 § 3.6 rejects.
 *
 * The replica is eventually consistent and that is accepted: a machine
 * decommissioned moments ago might still accept a request, which is
 * recoverable, and the alternative is not.
 *
 * Everything here is idempotent by construction: the `processed_event` row and
 * the effect commit in the same transaction, so a redelivery — which the
 * at-least-once outbox guarantees will happen — finds the marker and stops
 * (docs/07 § 7.5).
 */

/** What each consumed event does to the local picture. */
interface Projection {
  patch: (payload: Record<string, unknown>) => AssetRefPatch;
}

interface AssetRefPatch {
  organizationId?: string;
  name?: string | null;
  assetType?: string | null;
  assetTag?: string | null;
  status?: string;
}

const PROJECTIONS: Record<ConsumedEventName, Projection | null> = {
  // `USAGE_RECORDED` belongs to the other consumer, on the other topic. Listed
  // as null rather than omitted so this table stays a complete answer to
  // "what does this service consume".
  [CONSUMED_EVENTS.USAGE_RECORDED]: null,

  [CONSUMED_EVENTS.ASSET_CREATED]: {
    patch: (payload) => ({
      organizationId: str(payload.organizationId),
      name: str(payload.name) ?? null,
      assetType: str(payload.type) ?? null,
      assetTag: str(payload.assetTag) ?? null,
      status: str(payload.status) ?? 'REGISTERED',
    }),
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
      // replica that kept the old owner would let the previous organization
      // keep raising work against a machine it no longer has.
      organizationId: str(payload.toOrganizationId),
      // Its new owner must re-commission it, exactly as asset-service records.
      status: 'REGISTERED',
    }),
  },
  [CONSUMED_EVENTS.ASSET_DECOMMISSIONED]: {
    patch: () => ({ status: 'DECOMMISSIONED' }),
  },
};

const CONSUMER_NAME = 'maintenance-service.asset-sync';

/**
 * Builds the broker-facing half.
 *
 * Passed in rather than constructed here so this class stays a plain
 * projector: a test hands it `null` and calls `handle()` directly, with no
 * broker and no mocking of kafkajs.
 */
export type EventConsumerFactory = (handler: EventHandler) => EventConsumer;

@Injectable()
export class AssetSyncConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AssetSyncConsumer.name);
  private consumer?: EventConsumer;

  constructor(
    private readonly consumerFactory: EventConsumerFactory | null,
    private readonly repository: MaintenanceRepository,
  ) {}

  async onModuleInit(): Promise<void> {
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

  /** Handles one event. Exposed so a test can drive it without a broker. */
  async handle(envelope: EventEnvelope): Promise<void | 'SKIPPED'> {
    const projection = PROJECTIONS[envelope.eventName as ConsumedEventName];
    // `rasta.asset.v1` carries far more than this service cares about — every
    // location update, every document attachment, every inspection. Ignoring
    // the rest is normal operation, and forward compatibility depends on it
    // (docs/07 § 7.6).
    if (!projection) return 'SKIPPED';

    const parsed = assetSourceSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      // An event this service projects, that names no machine. A producer
      // defect worth seeing, but not one a retry fixes.
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
        // `undefined`, and the row would be written with no organization. That
        // bug was real in fleet-service and was caught by an integration test,
        // not a unit test.
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
