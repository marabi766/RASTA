import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import {
  UnprocessableEventError,
  createSystemContext,
  invalidPayloadError,
  isRetryDelivery,
  requireEnvelopeTenant,
  runWithContext,
  type EventConsumer,
  type EventDelivery,
  type EventHandler,
} from '@rasta/nest-common';
import {
  UNCONFIGURED_TRANSFER_RECORD_SOURCE,
  type TransferRecordSource,
} from '../fleet/transfer-record';
import {
  UNCONFIGURED_ASSET_SNAPSHOT_SOURCE,
  UNCONFIGURED_MAINTENANCE_STATE_SOURCE,
  type AssetSnapshotSource,
  type MaintenanceStateSource,
} from './replica-sources';
import { FLEET_TOPIC, SERVICE_NAME } from '../config/env';
import { FleetRepository } from '../fleet/fleet.repository';
import {
  INSPECTION_BLOCK_REASON,
  UNKNOWN_COVERAGE,
  parseCover,
  unresolvedLapses,
  withRecordedPolicy,
  type InsuranceCover,
} from '../fleet/dispatch-blocks';
import {
  CONSUMED_EVENTS,
  CONSUMED_PAYLOADS,
  FLEET_EVENTS,
  assetTransferredSchema,
  validateFleetPayload,
  type ConsumedEventName,
} from '../fleet/events';
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
 * One event also acts on fleet's own rows: `ASSET_TRANSFERRED` ends every
 * active assignment on the machine, in the same transaction as the replica
 * update. asset-service refuses to transfer an `ASSIGNED` machine, but an
 * assignment made here before asset-service consumed `ASSET_ASSIGNED` is not
 * visible to that check, and would otherwise survive into the new owner's
 * tenure with the old owner's driver still in charge.
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
      // Any assignment still open on it is ended by the handler, below.
      status: 'REGISTERED',
      // The insurance state is deliberately left as it is. The policy follows
      // the vehicle: the previous owner's policy counts for the new owner
      // until its own validTo, lapses included (docs/24 Q-66, project owner's
      // decision 2026-09-25).
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
      // A policy without its coverage, id or dates cannot answer anything.
      // `handle` dead-letters such an event before its marker (audit L7-26),
      // so the lapse stays in force and a corrected replay is still applied;
      // this guard only narrows the types and never guesses a validity.
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

/**
 * The events that set the replica's state (status, owner, the in-maintenance
 * flag). On `<topic>.retry` these are refreshed from their owners instead of
 * applied (D-039). The safety events are absent on purpose: an older failure
 * or lapse is still one that must be seen, and they carry their own
 * order-insensitive rules.
 */
const STATE_EVENTS: ReadonlySet<string> = new Set([
  CONSUMED_EVENTS.ASSET_CREATED,
  CONSUMED_EVENTS.ASSET_UPDATED,
  CONSUMED_EVENTS.ASSET_ACTIVATED,
  CONSUMED_EVENTS.ASSET_STATUS_CHANGED,
  CONSUMED_EVENTS.ASSET_TRANSFERRED,
  CONSUMED_EVENTS.ASSET_DECOMMISSIONED,
  CONSUMED_EVENTS.MAINTENANCE_STARTED,
  CONSUMED_EVENTS.MAINTENANCE_COMPLETED,
]);

/** The events whose in-maintenance flag maintenance-service owns. */
const MAINTENANCE_EVENTS: ReadonlySet<string> = new Set([
  CONSUMED_EVENTS.MAINTENANCE_STARTED,
  CONSUMED_EVENTS.MAINTENANCE_COMPLETED,
]);

/** What a refreshed replica must not take from the payload; everything else in a patch is order-insensitive. */
function withoutStateFields(patch: AssetRefPatch): AssetRefPatch {
  const {
    organizationId: _organizationId,
    name: _name,
    assetType: _assetType,
    assetTag: _assetTag,
    status: _status,
    inMaintenance: _inMaintenance,
    ...rest
  } = patch;
  return rest;
}

/**
 * A refresh holds the asset's lock across up to four short exchanges with the
 * owners (each bounded by its own deadline), so its transaction is given room.
 * Replays are rare operator actions; original deliveries for that asset wait.
 */
const REFRESH_TRANSACTION_TIMEOUT_MS = 30_000;

const CONSUMER_NAME = 'fleet-service.asset-sync';

/** Who ended an assignment nobody ended by hand; the same value as elsewhere. */
const SYSTEM_ACTOR = 'SYSTEM';

/** Stored as the assignment's end notes. Persian: it reaches the user unchanged. */
const TRANSFER_END_NOTES = 'پایان خودکار: ماشین به سازمان دیگری منتقل شد.';

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
    /** Read on a `.retry` delivery only; without them a replay is refused (fail closed, D-039). */
    private readonly assetSource: AssetSnapshotSource = UNCONFIGURED_ASSET_SNAPSHOT_SOURCE,
    private readonly maintenanceSource: MaintenanceStateSource = UNCONFIGURED_MAINTENANCE_STATE_SOURCE,
    /** Whether a stale fence's transfer was recorded (ADR-062 § 3b); read under the lock. */
    private readonly transferRecords: TransferRecordSource = UNCONFIGURED_TRANSFER_RECORD_SOURCE,
  ) {}

  async onModuleInit(): Promise<void> {
    // Null in tests and in any run without a broker. The service stays useful
    // without Kafka; the replica simply stops tracking new machines.
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

  /**
   * Handles one event.
   *
   * Exposed rather than private so a test can drive it directly with a
   * hand-built envelope — the projection rules are worth testing without a
   * broker in the loop.
   */
  async handle(envelope: EventEnvelope, delivery?: EventDelivery): Promise<void | 'SKIPPED'> {
    const projection = PROJECTIONS[envelope.eventName as ConsumedEventName];
    // These topics carry far more than this service cares about — every asset
    // location update, every document attachment. Ignoring the rest is normal
    // operation, not an error, and forward compatibility depends on it
    // (docs/07 § 7.6).
    if (!projection) return 'SKIPPED';

    if (envelope.eventName === CONSUMED_EVENTS.ASSET_TRANSFERRED) {
      // Before any marker or effect: a transfer this service cannot trust is
      // dead-lettered, not applied halfway (review #127 #5).
      assertTransferEnvelope(envelope);
    }

    const contract = CONSUMED_PAYLOADS[envelope.eventName as ConsumedEventName];
    const parsed = contract.schema.safeParse(envelope.payload);
    if (!parsed.success) {
      // An event this service projects, without a field of its producer's
      // contract that the projection uses — no machine, a status change with
      // no status, a policy with no usable window: a producer defect no retry
      // fixes. Dead-lettered at once, before the marker — an inspection
      // failure acknowledged here would leave the machine dispatchable with no
      // trace, and a corrected replay must still be applied (audit L7-26,
      // review #205 r1, docs/07 § 7.6).
      throw invalidPayloadError(envelope, parsed.error, contract.fields);
    }

    const payload = parsed.data as Record<string, unknown>;
    const assetId = payload.assetId as string;

    // The replica is keyed by asset and scoped by the tenant the *envelope*
    // declares — never by a request context, there is none here, and never by
    // the payload (review #205 r1). Taken from the payload and marked
    // processed, a wrong tenant could not be corrected by any replay. So an
    // event with no envelope tenant is refused whatever its payload says and
    // whether or not the machine is already in the replica, and a payload
    // naming another organization is refused as a mismatch: both before the
    // marker and before any write. A transfer's new owner was checked against
    // the envelope above.
    const organizationId = requireEnvelopeTenant(envelope, payload.organizationId);

    // D-039: `<topic>` and `<topic>.retry` are separate streams, so a delivery
    // on `.retry` may be older than events applied since. A state event on it
    // does not apply its payload: inside the transaction, under the same
    // per-asset lock the original deliveries take, the replica is refreshed
    // from the services that own the state — asset-service for the machine,
    // maintenance-service for the in-maintenance flag — and written from that.
    // Read and write under one lock, so no newer event can commit in between
    // and be overwritten. The source is asked as the EVENT's tenant, never the
    // replica's. No answer throws (rolling the marker back: retry, then DLQ)
    // and the stale payload is never applied.
    const replayed =
      delivery !== undefined && isRetryDelivery(delivery) && STATE_EVENTS.has(envelope.eventName);

    const now = new Date();
    // The producer's clock, for ordering. An unreadable timestamp falls back to
    // now, which dates the event as late as possible: a failure then blocks,
    // and a repair clears only failures that are genuinely older.
    const stated = new Date(envelope.occurredAt);
    const occurredAt = Number.isNaN(stated.getTime()) ? now : stated;

    await this.repository.transaction(
      async (tx: ExtendedPrismaClient) => {
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

        // An insurance event from the previous owner's tenant, consumed after the
        // transfer, is applied to the row as it now stands, under its current
        // owner: the policy is the vehicle's, not the organization's (docs/24
        // Q-66). The tenant below comes from the row, never from such an event.
        let patch = projection.patch(payload, current, now, occurredAt);
        const refresh = replayed
          ? await this.readAuthoritativeState(envelope, assetId, organizationId)
          : undefined;
        if (refresh) {
          // The replica fields come from the owners. What stays of the payload's
          // patch is the safety part, which has its own order-insensitive rules
          // (a repair completion still resolves an older inspection failure) —
          // but only for a tenant that still owns the machine: an event from a
          // previous owner is good for the owner change alone.
          patch = refresh.viaTransfer
            ? refresh.patch
            : { ...withoutStateFields(patch), ...refresh.patch };
        }

        // The row's organization: the one an ASSET_CREATED or a transfer
        // states, both already held to the envelope tenant; else the row's own;
        // else, on a first sighting, the envelope tenant.
        const tenant = patch.organizationId ?? current?.organizationId ?? organizationId;

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

        if (refresh) {
          // The snapshot shows the machine under another owner than the replica
          // had: the same owner change ASSET_TRANSFERRED would have made. Only
          // then — a replayed transfer the replica already reflects must not end
          // the new owner's assignments.
          const previousOwner = current?.organizationId;
          if (previousOwner && previousOwner !== refresh.organizationId) {
            await this.endAssignmentsOnTransfer(tx, envelope, assetId, now, occurredAt);
          }
          await this.settleStaleFence(tx, assetId, refresh.organizationId);
        } else if (envelope.eventName === CONSUMED_EVENTS.ASSET_TRANSFERRED) {
          await this.endAssignmentsOnTransfer(tx, envelope, assetId, now, occurredAt);
          // The fence the previous owner placed to clear this transfer
          // (ADR-062). The replica now names the new owner, which refuses the
          // previous one from here on; left in place, the fence would refuse the
          // new owner until it expired.
          const previousOwner = payload.fromOrganizationId;
          if (typeof previousOwner === 'string' && previousOwner.length > 0) {
            await this.repository.dropTransferFences(tx, assetId, previousOwner);
          }
        }
      },
      replayed ? { timeoutMs: REFRESH_TRANSACTION_TIMEOUT_MS } : undefined,
    );
  }

  /**
   * Lifts the fence of an organization that no longer owns the machine — and
   * only that: never the current owner's (ADR-062), and only when asset-service
   * records the transfer that organization made. A fence for a transfer still
   * committing, or one nobody recorded, is left to its own expiry. At most one
   * fence stands on a machine. Runs under the asset's lock.
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
   * The authoritative state a replayed event refreshes the replica from.
   *
   * asset-service's answer for the machine (owner, status, name, type, tag),
   * and — for the two maintenance events — maintenance-service's for the
   * in-maintenance flag, asked of the machine's current owner. asset-service
   * not knowing the machine for the organization the event names is a
   * refusal, not a retry: the answer will not change (SOURCE_UNCONFIRMED).
   * No answer from either throws, so the event is retried and dead-lettered.
   */
  private async readAuthoritativeState(
    envelope: EventEnvelope,
    assetId: string,
    organizationId: string | undefined,
  ): Promise<{ organizationId: string; viaTransfer: boolean; patch: AssetRefPatch }> {
    if (!organizationId) {
      throw new UnprocessableEventError(
        DLQ_REASONS.SOURCE_UNCONFIRMED,
        `${envelope.eventName} ${envelope.eventId} names no organization to ask asset-service for`,
      );
    }
    const snapshot = await this.assetSource.snapshot(organizationId, assetId);
    if (!snapshot) {
      throw new UnprocessableEventError(
        DLQ_REASONS.SOURCE_UNCONFIRMED,
        `asset-service does not confirm ${envelope.eventName} ${envelope.eventId} for the organization it names`,
      );
    }
    // Asked of the machine's current owner; skipped for an event whose tenant
    // no longer owns the machine, which is good for the owner change alone.
    const inMaintenance =
      MAINTENANCE_EVENTS.has(envelope.eventName) && !snapshot.viaTransfer
        ? await this.maintenanceSource.inMaintenance(snapshot.organizationId, assetId)
        : undefined;
    return {
      organizationId: snapshot.organizationId,
      viaTransfer: snapshot.viaTransfer,
      patch: {
        organizationId: snapshot.organizationId,
        name: snapshot.name,
        assetType: snapshot.type,
        assetTag: snapshot.assetTag,
        status: snapshot.status,
        ...(inMaintenance === undefined ? {} : { inMaintenance }),
      },
    };
  }

  /**
   * Ends whatever assignment is still open on a machine that changed owner.
   *
   * Runs under the asset's lock, after the replica already names the new
   * owner and `REGISTERED`: an assignment attempt queued behind the lock sees
   * both and is refused, so nothing new can start between this and commit.
   * A redelivery stops at the `processed_event` marker before reaching here;
   * the guarded update in the repository covers a person ending the same
   * assignment at the same moment.
   *
   * Each release is published like any other `ASSIGNMENT_ENDED`, under the
   * tenant that held the assignment — never the new owner's, which must not
   * learn another organization's driver — with fleet-service as the actor
   * and the transfer event as its cause, so audit-service can tell it from a
   * release someone asked for.
   */
  private async endAssignmentsOnTransfer(
    tx: ExtendedPrismaClient,
    envelope: EventEnvelope,
    assetId: string,
    now: Date,
    occurredAt: Date,
  ): Promise<void> {
    // Dated when the transfer happened, but never later than now: a producer
    // clock running ahead must not end an assignment in the future.
    const at = occurredAt < now ? occurredAt : now;
    const ended = await this.repository.endActiveAssignmentsForAsset(
      tx,
      assetId,
      at,
      SYSTEM_ACTOR,
      'ASSET_UNAVAILABLE',
      TRANSFER_END_NOTES,
    );

    for (const assignment of ended) {
      // The consumer's own context names asset-service, the producer of the
      // transfer, as the caller. The release is this service's act, so the
      // envelope is built in a context that says so.
      const context = createSystemContext({
        correlationId: envelope.correlationId,
        organizationId: assignment.organizationId,
        callerService: SERVICE_NAME,
      });
      await runWithContext(context, () =>
        this.repository.enqueueEvent(tx, {
          aggregateType: 'Assignment',
          aggregateId: assignment.id,
          eventName: FLEET_EVENTS.ASSIGNMENT_ENDED,
          topic: FLEET_TOPIC,
          organizationId: assignment.organizationId,
          causationId: envelope.eventId,
          payload: validateFleetPayload(FLEET_EVENTS.ASSIGNMENT_ENDED, {
            assignmentId: assignment.id,
            assetId,
            driverId: assignment.driverId,
            organizationId: assignment.organizationId,
            startedAt: assignment.startedAt.toISOString(),
            endedAt: assignment.endedAt.toISOString(),
            reason: 'ASSET_UNAVAILABLE',
          }),
        }),
      );
    }

    if (ended.length > 0) {
      this.logger.log(
        `Ended ${ended.length} active assignment(s) on ${assetId} because it was transferred ` +
          `(${envelope.eventId})`,
      );
    }
  }
}

/** The later of two instants, either of which may be missing. */
function later(a: Date | null | undefined, b: Date): Date {
  return a && a > b ? a : b;
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
