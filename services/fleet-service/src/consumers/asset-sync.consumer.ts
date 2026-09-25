import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@rasta/contracts';
import type { EventConsumer, EventHandler } from '@rasta/nest-common';
import { FleetRepository } from '../fleet/fleet.repository';
import {
  INSPECTION_BLOCK_REASON,
  UNKNOWN_COVERAGE,
  parseCover,
  unresolvedLapses,
  withRecordedPolicy,
  type InsuranceCover,
} from '../fleet/dispatch-blocks';
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
  /**
   * Applied on top of the existing replica row. `current` is that row as read
   * under a row lock inside the handler's transaction, so a projection that
   * adds to a field (a lapse to the set, a window to the map) cannot lose a
   * concurrent addition; `null` on the first sighting of a machine.
   *
   * `now` is when fleet handles the event, `occurredAt` when the producer says
   * it happened. Anything that decides which of two events is newer uses
   * `occurredAt`: events from different topics arrive in no guaranteed order.
   */
  patch: (
    payload: Record<string, unknown>,
    current: CurrentAssetRef | null,
    now: Date,
    occurredAt: Date,
  ) => AssetRefPatch;
}

/** The fields of the current row a projection may build on. */
interface CurrentAssetRef {
  inspectionBlockedAt: Date | null;
  inspectionResolvedAt: Date | null;
  insuranceLapsedCoverages: string[];
  insuranceLapsedAt: Date | null;
  insuranceCover: unknown;
}

interface AssetRefPatch {
  organizationId?: string;
  name?: string | null;
  assetType?: string | null;
  assetTag?: string | null;
  status?: string;
  inMaintenance?: boolean;
  inspectionBlockedReason?: string | null;
  inspectionBlockedAt?: Date | null;
  inspectionResolvedAt?: Date | null;
  insuranceLapsedCoverages?: string[];
  insuranceLapsedAt?: Date | null;
  insuranceCover?: InsuranceCover;
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
  //
  // Independent causes in independent fields (L3-02). Folding them into one
  // `dispatchBlockedReason` meant whichever event resolved *one* of them
  // silently cleared the other too — a completed repair has nothing to say
  // about a lapsed insurance policy, but it used to clear that block anyway —
  // and a later block overwrote the reason of an earlier one. Each projection
  // below reads the current row and adds to it; none replaces another cause.
  [CONSUMED_EVENTS.INSPECTION_FAILED]: {
    patch: (_payload, current, _now, occurredAt) => {
      // A repair completed after this failure has already answered it. That
      // happens when the completion is consumed first: the topics are
      // separate and carry no order between them.
      const resolvedAt = current?.inspectionResolvedAt;
      if (resolvedAt && occurredAt < resolvedAt) return {};
      // Dated by the most recent failure, when the producer says it happened,
      // so only a repair completed after that failure clears the block.
      return {
        inspectionBlockedReason: INSPECTION_BLOCK_REASON,
        inspectionBlockedAt: later(current?.inspectionBlockedAt, occurredAt),
      };
    },
  },
  [CONSUMED_EVENTS.INSURANCE_EXPIRED]: {
    // Recorded as a lapse of the policy's coverage, never as "insured: no".
    // Whether it actually blocks is decided at dispatch time against the
    // recorded windows (dispatch-blocks.ts): a renewal recorded *before* this
    // lapse — the normal order — already answers it.
    patch: (payload, current, now) => {
      const lapsed = current?.insuranceLapsedCoverages ?? [];
      const coverage = str(payload.coverage) ?? UNKNOWN_COVERAGE;
      if (lapsed.includes(coverage)) return {};
      return {
        insuranceLapsedCoverages: [...lapsed, coverage],
        insuranceLapsedAt: current?.insuranceLapsedAt ?? now,
      };
    },
  },
  [CONSUMED_EVENTS.INSURANCE_RECORDED]: {
    // The only event that ends an insurance lapse, and only for its own
    // coverage and only while the policy is in force. The payload carries the
    // policy's `validFrom`/`validTo` (asset-service `insuranceRecordedPayload`),
    // so the window is stored rather than assumed: a renewal that starts next
    // week answers the lapse from next week, not from now.
    patch: (payload, current, now) => {
      const coverage = str(payload.coverage);
      const policyId = str(payload.policyId);
      const validFrom = str(payload.validFrom);
      const validTo = str(payload.validTo);
      // A policy without its dates cannot answer anything; it is recorded as
      // seen and changes nothing, rather than guessing a validity.
      if (!coverage || !policyId || !validFrom || !validTo) return {};

      const cover = withRecordedPolicy(
        parseCover(current?.insuranceCover),
        coverage,
        { policyId, validFrom, validTo },
        now,
      );
      // Resolved lapses are dropped from the set so it does not grow for
      // ever; one this policy does not yet answer stays and is re-checked at
      // dispatch time. `UNKNOWN` follows the same rule as the read side.
      const lapsed = current?.insuranceLapsedCoverages ?? [];
      const stillLapsed = unresolvedLapses(lapsed, cover, now);
      return {
        insuranceCover: cover,
        insuranceLapsedCoverages: stillLapsed,
        insuranceLapsedAt: stillLapsed.length > 0 ? (current?.insuranceLapsedAt ?? null) : null,
      };
    },
  },

  // ---- maintenance-service ------------------------------------------------
  // No producer exists yet. Subscribing anyway costs nothing — an empty topic
  // is free — and means launching maintenance-service is a deployment rather
  // than a change to this file.
  [CONSUMED_EVENTS.MAINTENANCE_STARTED]: {
    patch: () => ({ inMaintenance: true }),
  },
  [CONSUMED_EVENTS.MAINTENANCE_COMPLETED]: {
    patch: (_payload, current, _now, occurredAt) => {
      // A completed repair resolves a failed *inspection* — the machine has
      // been through a workshop, which is the event the inspection block
      // exists to gate (docs/24 Q-65). It says nothing about insurance: that
      // block survives this event and ends only with INSURANCE_RECORDED.
      //
      // Only a failure older than the repair is resolved. A completion that
      // arrives after a newer failure, because the topics are consumed in no
      // guaranteed order, leaves that failure in force.
      const blockedAt = current?.inspectionBlockedAt;
      const resolves = !blockedAt || occurredAt > blockedAt;
      return {
        inMaintenance: false,
        inspectionResolvedAt: later(current?.inspectionResolvedAt, occurredAt),
        ...(resolves ? { inspectionBlockedReason: null, inspectionBlockedAt: null } : {}),
      };
    },
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

    const now = new Date();
    // The producer's clock, for ordering. An unreadable timestamp falls back to
    // now, which dates the event as late as possible: a failure then blocks,
    // and a repair clears only failures that are genuinely older.
    const stated = new Date(envelope.occurredAt);
    const occurredAt = Number.isNaN(stated.getTime()) ? now : stated;
    let skipped = false;

    await this.repository.transaction(async (tx: ExtendedPrismaClient) => {
      // The idempotency marker and the effect commit together, so a crash
      // between them cannot leave the event marked handled with nothing to
      // show for it. A redelivery finds the marker and stops here.
      const fresh = await this.repository.markEventProcessed(tx, envelope.eventId, CONSUMER_NAME);
      if (!fresh) {
        this.logger.debug(`${envelope.eventName} ${envelope.eventId} already applied`);
        return;
      }

      // Locked and re-read inside the transaction: the safety projections add
      // to what the row already holds, and two events for one machine handled
      // at once must not each build on a copy that lacks the other's change.
      await this.repository.lockAssetRef(tx, assetId);
      const current = await this.repository.findAssetRef(assetId, tx);
      const patch = projection.patch(payload, current, now, occurredAt);

      // Narrowed rather than asserted: the guard above already established
      // that one of these is present, and spelling it out here keeps that true
      // if the guard is ever edited.
      const tenant = patch.organizationId ?? current?.organizationId ?? organizationId;
      if (!tenant) {
        skipped = true;
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

    return skipped ? 'SKIPPED' : undefined;
  }
}

/** The later of two instants, either of which may be missing. */
function later(a: Date | null | undefined, b: Date): Date {
  return a && a > b ? a : b;
}

/** Reads a string field, tolerating the absence the loose schema allows. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export { PROJECTIONS, CONSUMER_NAME };
