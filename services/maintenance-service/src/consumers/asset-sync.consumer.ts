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
  UNCONFIGURED_TRANSFER_RECORD_SOURCE,
  type TransferRecordSource,
} from '../maintenance/transfer-record';
import {
  UNCONFIGURED_ASSET_SNAPSHOT_SOURCE,
  type AssetSnapshot,
  type AssetSnapshotSource,
} from './replica-sources';
import { MaintenanceRepository } from '../maintenance/maintenance.repository';
import {
  CONSUMED_EVENTS,
  assetSourceSchema,
  assetTransferredSchema,
  type ConsumedEventName,
} from '../maintenance/events';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { SERVICE_NAME } from '../config/env';
import { transferOpenWorkTotal } from '../observability/metrics';

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

/**
 * A refresh holds the asset's locks across up to three short exchanges with
 * asset-service (each bounded by its own deadline), so its transaction is given
 * room. Replays are rare operator actions; other deliveries for that asset wait.
 */
const REFRESH_TRANSACTION_TIMEOUT_MS = 30_000;

const CONSUMER_NAME = 'maintenance-service.asset-sync';

/** The field names a malformed-payload refusal may repeat (S-09). */
const ASSET_SOURCE_FIELDS = Object.keys(assetSourceSchema.shape);

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
    /** Read on a `.retry` delivery only; without one a replay is refused (fail closed, D-039). */
    private readonly assetSource: AssetSnapshotSource = UNCONFIGURED_ASSET_SNAPSHOT_SOURCE,
    /** Whether a stale fence's transfer was recorded (ADR-062 § 3b); read under the lock. */
    private readonly transferRecords: TransferRecordSource = UNCONFIGURED_TRANSFER_RECORD_SOURCE,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.consumerFactory) {
      this.logger.warn('Asset sync consumer disabled — no Kafka broker configured');
      return;
    }
    this.consumer = this.consumerFactory((envelope, delivery) => this.handle(envelope, delivery));
    await this.consumer.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.stop();
  }

  /** Handles one event. Exposed so a test can drive it without a broker. */
  async handle(envelope: EventEnvelope, delivery?: EventDelivery): Promise<void | 'SKIPPED'> {
    const projection = PROJECTIONS[envelope.eventName as ConsumedEventName];
    // `rasta.asset.v1` carries far more than this service cares about — every
    // location update, every document attachment, every inspection. Ignoring
    // the rest is normal operation, and forward compatibility depends on it
    // (docs/07 § 7.6).
    if (!projection) return 'SKIPPED';

    if (envelope.eventName === CONSUMED_EVENTS.ASSET_TRANSFERRED) {
      // Before any marker or effect: a transfer this service cannot trust is
      // dead-lettered, not applied halfway (review #127 #5).
      assertTransferEnvelope(envelope);
    }

    const parsed = assetSourceSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      // An event this service projects, that names no machine: a producer
      // defect no retry fixes. Dead-lettered at once, before the marker, so a
      // corrected replay is still applied (audit L7-26, docs/07 § 7.6).
      throw invalidPayloadError(envelope, parsed.error, ASSET_SOURCE_FIELDS);
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
      // The first sighting of a machine, with no tenant to place it in: a
      // broken producer. Dead-lettered at once rather than skipped without a
      // trace, before the marker, so a corrected replay is still applied
      // (audit L7-26). A machine already in the replica keeps its own tenant.
      throw missingTenantError(envelope);
    }

    // D-039: `<topic>` and `<topic>.retry` are separate streams, so a delivery
    // on `.retry` may be older than events applied since. It does not apply its
    // payload: inside the transaction, under the same per-asset lock every
    // delivery takes, the replica is refreshed from asset-service, which owns
    // the state, and written from that. Read and write under one lock, so no
    // newer event can commit in between and be overwritten. The source is asked
    // as the EVENT's tenant, never the replica's. No answer throws (rolling the
    // marker back: retry, then DLQ) and the stale payload is never applied.
    const replayed = delivery !== undefined && isRetryDelivery(delivery);
    const eventTenant = envelope.tenantId ?? organizationId;

    await this.repository.transaction(
      async (tx: ExtendedPrismaClient) => {
        const fresh = await this.repository.markEventProcessed(tx, envelope.eventId, CONSUMER_NAME);
        if (!fresh) {
          this.logger.debug(`${envelope.eventName} ${envelope.eventId} already applied`);
          return;
        }

        // The replica row's writers, one at a time; the work lock below stays
        // the one a new request takes. This order everywhere.
        await this.repository.lockAssetRef(tx, assetId);
        const current = await this.repository.findAssetRef(assetId, tx);

        let snapshot: AssetSnapshot | undefined;
        if (replayed) {
          // Before asking: fences are placed and released under this lock, so
          // the fence check below reads what the snapshot was taken against.
          await this.repository.lockAssetForWork(tx, assetId, 'EXCLUSIVE');
          if (!eventTenant) {
            throw new UnprocessableEventError(
              DLQ_REASONS.SOURCE_UNCONFIRMED,
              `${envelope.eventName} ${envelope.eventId} names no organization to ask asset-service for`,
            );
          }
          const answer = await this.assetSource.snapshot(eventTenant, assetId);
          if (!answer) {
            throw new UnprocessableEventError(
              DLQ_REASONS.SOURCE_UNCONFIRMED,
              `asset-service does not confirm ${envelope.eventName} ${envelope.eventId} for the organization it names`,
            );
          }
          snapshot = answer;
        }
        // A snapshot showing another owner than the replica had is the owner
        // change ASSET_TRANSFERRED would have made.
        const ownerChanged =
          snapshot !== undefined && !!current && current.organizationId !== snapshot.organizationId;

        const patch: AssetRefPatch = snapshot
          ? {
              organizationId: snapshot.organizationId,
              name: snapshot.name,
              assetType: snapshot.type,
              assetTag: snapshot.assetTag,
              status: snapshot.status,
            }
          : projection.patch(payload);
        // Narrowed rather than asserted: the guard above already established
        // that one of these is present, and spelling it out here keeps that
        // true if the guard is ever edited.
        const tenant = patch.organizationId ?? current?.organizationId ?? organizationId;
        if (!tenant) return;

        const transfer = snapshot
          ? ownerChanged
          : envelope.eventName === CONSUMED_EVENTS.ASSET_TRANSFERRED;
        if (transfer || snapshot) {
          // Exclusive, against the shared lock a new request takes (ADR-062).
          // Without it, a request could read the owner before this commits and
          // the fence after, and pass both.
          await this.repository.lockAssetForWork(tx, assetId, 'EXCLUSIVE');
        }

        await this.repository.upsertAssetRef(tx, {
          // The patch first, then the resolved values — never the other way
          // round. A patch key present but undefined (an ASSET_CREATED whose
          // payload omits the organization, with the tenant only on the
          // envelope) would otherwise overwrite the value resolved above with
          // `undefined`, and the row would be written with no organization.
          // That bug was real in fleet-service and was caught by an
          // integration test, not a unit test.
          ...patch,
          id: assetId,
          // An existing row keeps its organization unless the event explicitly
          // moves it, which only a transfer does.
          organizationId: tenant,
          sourceEvent: envelope.eventName,
        });

        const previousOwner = snapshot ? current?.organizationId : str(payload.fromOrganizationId);
        if (transfer && previousOwner) {
          await this.settleTransfer(tx, assetId, previousOwner, !snapshot);
        }
        if (snapshot) await this.settleStaleFence(tx, assetId, snapshot.organizationId);
      },
      replayed ? { timeoutMs: REFRESH_TRANSACTION_TIMEOUT_MS } : undefined,
    );
  }

  /**
   * Lifts the fence of an organization that no longer owns the machine — and
   * only that: never the current owner's (ADR-062), and only when asset-service
   * records the transfer that organization made. A fence for a transfer still
   * committing, or one nobody recorded, is left to its own expiry. At most one
   * fence stands on a machine. Runs under the asset's locks.
   */
  private async settleStaleFence(
    tx: ExtendedPrismaClient,
    assetId: string,
    currentOwner: string,
  ): Promise<void> {
    const fence = await this.repository.findTransferFence(assetId, tx);
    if (!fence || fence.organizationId === currentOwner) return;
    const answer = await this.transferRecords.resolve(fence.organizationId, assetId, fence.fenceId);
    if (answer === 'RECORDED') {
      await this.repository.deleteTransferFence(tx, assetId, fence.fenceId);
    }
  }

  /**
   * The previous owner's side of a transfer that has landed (ADR-062).
   *
   * Its fence goes: the replica now names the new owner, which refuses the
   * previous one from here on, and a fence left in place would refuse the new
   * owner until it expired.
   *
   * Its open work should not exist, because the transfer was cleared against
   * it. If it does, it is counted and logged, and it stays exactly where it
   * is. What should happen to it is docs/24 Q-74; cancelling it or handing it
   * to the new owner would each be a decision in someone's name.
   */
  private async settleTransfer(
    tx: ExtendedPrismaClient,
    assetId: string,
    previousOwner: string,
    dropFence: boolean,
  ): Promise<void> {
    // A refresh drops a fence only through settleStaleFence, which checks that
    // the transfer is recorded.
    if (dropFence) await this.repository.dropTransferFences(tx, assetId, previousOwner);

    const open = await this.repository.countOpenWork(tx, assetId, previousOwner);
    if (open.openRequests > 0 || open.openRepairOrders > 0) {
      transferOpenWorkTotal.inc(
        { service: SERVICE_NAME },
        open.openRequests + open.openRepairOrders,
      );
      // Identifiers and counts only; no title or workshop.
      this.logger.warn(
        `${assetId} was transferred with open maintenance work left under its previous owner ` +
          `(${open.openRequests} request(s), ${open.openRepairOrders} repair order(s)); ` +
          'kept as is pending docs/24 Q-74',
      );
    }
  }
}

/**
 * Refuses an `ASSET_TRANSFERRED` whose payload lacks what the handler acts on,
 * or whose envelope disagrees with it. The message is fixed text and the
 * event id: nothing the publisher wrote is repeated (ADR-061 § 2).
 */
function assertTransferEnvelope(envelope: EventEnvelope): void {
  const parsed = assetTransferredSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new UnprocessableEventError(
      DLQ_REASONS.VALIDATION_FAILED,
      `ASSET_TRANSFERRED ${envelope.eventId} lacks assetId, fromOrganizationId, ` +
        'toOrganizationId or transferredAt, or names one organization twice',
    );
  }
  if (
    envelope.aggregateId !== parsed.data.assetId ||
    envelope.tenantId !== parsed.data.toOrganizationId
  ) {
    throw new UnprocessableEventError(
      DLQ_REASONS.VALIDATION_FAILED,
      `ASSET_TRANSFERRED ${envelope.eventId}: the envelope's aggregate or tenant ` +
        'disagrees with the transferred asset or its new owner',
    );
  }
}

/** Reads a string field, tolerating the absence the loose schema allows. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export { PROJECTIONS, CONSUMER_NAME };
