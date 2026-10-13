import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DLQ_REASONS, RETRY_TOPIC_SUFFIX, type EventEnvelope } from '@rasta/contracts';
import {
  HANDLER_MESSAGE_MAX,
  UnprocessableEventError,
  createSystemContext,
  deadLetterHeaders,
  envelopeHeaders,
  invalidPayloadError,
  isRetryDelivery,
  replicaOwnerMismatchError,
  requireEnvelopeTenant,
  runWithContext,
  safeLogText,
  type EventConsumer,
  type EventDelivery,
  type EventHandler,
} from '@rasta/nest-common';
import { dlqMessagesTotal } from '@rasta/observability';
import {
  UNCONFIGURED_TRANSFER_RECORD_SOURCE,
  type TransferRecordSource,
} from '../fleet/transfer-record';
import {
  UNCONFIGURED_ASSET_SNAPSHOT_SOURCE,
  UNCONFIGURED_INSURANCE_POLICY_SOURCE,
  UNCONFIGURED_MAINTENANCE_STATE_SOURCE,
  type AssetSnapshotSource,
  type InsurancePolicySource,
  type MaintenanceStateSource,
  type PolicyVerdict,
} from './replica-sources';
import {
  ASSET_SYNC_DEAD_LETTER_TOPIC,
  ASSET_SYNC_TOPICS,
  FLEET_TOPIC,
  SERVICE_NAME,
} from '../config/env';
import {
  FleetRepository,
  type DeadLetterOutboxInput,
  type ParkedInsurance,
} from '../fleet/fleet.repository';
import {
  INSPECTION_BLOCK_REASON,
  UNKNOWN_COVERAGE,
  afterTransfer,
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
    eventOrganization: string | undefined,
  ) => AssetRefPatch;
}

/** The fields of the current row a projection may build on. */
interface CurrentAssetRef {
  organizationId: string;
  inspectionBlockedAt: Date | null;
  inspectionResolvedAt: Date | null;
  insuranceLapsedCoverages: string[];
  insuranceLapsedAt: Date | null;
  insuranceCover: unknown;
  ownershipGeneration: number | null;
  retainedCoverages: string[];
  /** Moved by every change to the insurance state, owner or generation (trigger, #240 r10). */
  insuranceRevision: bigint;
  /** Moved by every `insurance:clear-transferred` run that targets the row (#240 r11). */
  insuranceEpoch: bigint;
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
  ownershipGeneration?: number | null;
  retainedCoverages?: string[];
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
    patch: (payload, current) => {
      const retained = strList(payload.retainedCoverages);
      const generation = int(payload.ownershipGeneration);
      return {
        // The machine moved to another organization. Following it matters: a
        // replica that kept the old owner would keep offering the machine in
        // the wrong organization's availability listing.
        organizationId: str(payload.toOrganizationId),
        // Its new owner must re-commission it, exactly as asset-service records.
        // Any assignment still open on it is ended by the handler, below.
        status: 'REGISTERED',
        // The policy follows the vehicle only for the coverages asset-service
        // lets follow it (docs/24 Q-66, INSURANCE_COVERAGES_FOLLOWING_VEHICLE),
        // which the event states. The others' windows are dropped: with a
        // required-coverage dispatch rule a stale window would authorize the
        // new owner. No `retainedCoverages` (an older event) drops them all —
        // fail closed; the re-projection command restores the valid ones.
        // Lapses are left as they are: they only ever withhold.
        insuranceCover: afterTransfer(parseCover(current?.insuranceCover), retained, generation),
        retainedCoverages: retained ?? [],
        // Monotonic (#240 r12): a transfer at or below the replica's generation
        // never reaches this patch (`handle` acknowledges it unapplied). An event
        // that states none (an older one) leaves an unknown generation UNKNOWN
        // (NULL), so the owner check applies, and a known one as it is: never
        // lowered.
        ownershipGeneration:
          generation === undefined
            ? (current?.ownershipGeneration ?? null)
            : Math.max(generation, current?.ownershipGeneration ?? generation),
      };
    },
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

      // Whether the policy is the current owner's and counts is not decided
      // here: `verifiedInsurancePatch` asks asset-service and passes this patch
      // the source's own coverage, window and generation (#240 r7).
      const generation = int(payload.ownershipGeneration);

      const cover = withRecordedPolicy(
        parseCover(current?.insuranceCover),
        coverage,
        generation === undefined
          ? { policyId, validFrom, validTo }
          : { policyId, validFrom, validTo, generation },
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

/**
 * The ordinary state events, which change a row the event's tenant must own
 * (review #205 r2): every state event but the two that set the owner —
 * `ASSET_CREATED` and `ASSET_TRANSFERRED`, both held to the envelope tenant.
 * The safety events are not here: an insurance event from the previous owner
 * after a transfer applies to the vehicle (docs/24 Q-66), and a failed
 * inspection only ever withdraws the machine.
 */
const OWNER_CHECKED_EVENTS: ReadonlySet<string> = new Set(
  [...STATE_EVENTS].filter(
    (eventName) =>
      eventName !== CONSUMED_EVENTS.ASSET_CREATED &&
      eventName !== CONSUMED_EVENTS.ASSET_TRANSFERRED,
  ),
);

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
 * The default for the one transaction that still holds an asset's lock across
 * exchanges with the owners — a replayed state event's refresh, which makes up
 * to three, each bounded by its own deadline — and for the insurance decisions
 * that may wait on that lock behind it (#240 r10: they ask nobody themselves).
 * `FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS`, checked at startup against the
 * upstream timeout and the consumer's session timeout (`assetSyncBudgetProblem`,
 * #240 r11). Replays are rare operator actions; but what waits on the lock
 * behind one may FAIL rather than wait — an ordinary delivery or an HTTP
 * request's transaction has Prisma's 5 s (known limitation,
 * docs/runbooks/replay-dlq.md). 14.2 s since #240 r12, so that the start waits
 * and the reads before a transaction fit the session too.
 */
export const DEFAULT_TRANSACTION_TIMEOUT_MS = 14_200;

/**
 * How long every asset-sync transaction may wait to start — for a pool
 * connection — and how long the reads an `INSURANCE_RECORDED` makes before its
 * transaction may take together (#240 r12). Prisma's own `maxWait` (2 s) was
 * outside the delivery budget; this one is in it.
 * `FLEET_ASSET_SYNC_TRANSACTION_MAX_WAIT_MS`.
 */
export const DEFAULT_TRANSACTION_MAX_WAIT_MS = 500;

const CONSUMER_NAME = 'fleet-service.asset-sync';

/** Who ended an assignment nobody ended by hand; the same value as elsewhere. */
const SYSTEM_ACTOR = 'SYSTEM';

/** The reason recorded on a window the transfer revokes (`availability_window.revoke_reason`). */
const WINDOW_REVOKE_REASON = 'ASSET_TRANSFERRED';

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

/**
 * The parked-insurance sweep's bounds (#240 r8; `FLEET_INSURANCE_PARKED_*`).
 * Exhausted events are dead-lettered through the outbox to
 * `rasta.fleet.v1.dlq` (#240 r9).
 */
export interface ParkingOptions {
  readonly minAgeSeconds: number;
  readonly maxAttempts: number;
  readonly sweepIntervalMs: number;
  readonly batchSize: number;
  /**
   * The `service` label those dead letters are counted under in
   * `rasta_dlq_messages_total`: the consumer's Kafka client id, the label of its
   * own dead letters, so one alert covers both. `fleet-service` when not given.
   */
  readonly dlqMetricService?: string;
}

export const DEFAULT_PARKING: ParkingOptions = {
  minAgeSeconds: 300,
  maxAttempts: 12,
  sweepIntervalMs: 60_000,
  batchSize: 50,
};

/**
 * What asset-service's answer about an `INSURANCE_RECORDED` means for the
 * replica, decided under the asset's lock: store the source's window, drop the
 * event (the policy does not count, or the answer is older than the replica),
 * or park it (the source is about a later owner than the replica has seen).
 */
type InsuranceOutcome =
  | { readonly kind: 'APPLY'; readonly patch: AssetRefPatch }
  | { readonly kind: 'DROP'; readonly reason: string }
  | { readonly kind: 'PARK'; readonly reason: ParkReason };

/** Why an event is (still) parked: the source ahead, or no answer from it. */
type ParkReason = 'NOT_CURRENT_OWNER' | 'SOURCE_AHEAD' | 'NO_ANSWER';

/** What one re-verification of a parked event did. */
export type ParkedOutcome = 'GONE' | 'NOT_DUE' | 'APPLIED' | 'DROPPED' | 'KEPT' | 'DEAD_LETTERED';

/** Where INSURANCE_RECORDED is published (ASSET_SYNC_TOPICS); a parked event without a delivery is dead-lettered as from here. */
const INSURANCE_TOPIC = 'rasta.insurance.v1';

/**
 * Where asset-service's answer stands against the replica it is applied to, by
 * ownership generation. With the replica's generation unknown only the owner
 * can be compared; any disagreement then, or at an equal generation, is treated
 * as the source being ahead (the transfer has not been consumed): retried, never
 * guessed.
 */
function sourceOrder(
  verdict: { organizationId: string; ownershipGeneration: number },
  replica: { organizationId: string; ownershipGeneration?: number | null },
): 'SAME' | 'AHEAD' | 'BEHIND' {
  const known = replica.ownershipGeneration;
  if (known !== null && known !== undefined) {
    if (verdict.ownershipGeneration > known) return 'AHEAD';
    if (verdict.ownershipGeneration < known) return 'BEHIND';
  }
  return verdict.organizationId === replica.organizationId ? 'SAME' : 'AHEAD';
}

@Injectable()
export class AssetSyncConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AssetSyncConsumer.name);
  private consumer?: EventConsumer;
  private sweepTimer?: NodeJS.Timeout;
  private sweeping = false;
  /** A run was asked for while one was running (a transfer made rows due): run again after it. */
  private sweepAgain = false;

  constructor(
    private readonly consumerFactory: EventConsumerFactory | null,
    private readonly repository: FleetRepository,
    /** Read on a `.retry` delivery only; without them a replay is refused (fail closed, D-039). */
    private readonly assetSource: AssetSnapshotSource = UNCONFIGURED_ASSET_SNAPSHOT_SOURCE,
    private readonly maintenanceSource: MaintenanceStateSource = UNCONFIGURED_MAINTENANCE_STATE_SOURCE,
    /** Whether a stale fence's transfer was recorded (ADR-062 § 3b); read under the lock. */
    private readonly transferRecords: TransferRecordSource = UNCONFIGURED_TRANSFER_RECORD_SOURCE,
    /** Asked about every `INSURANCE_RECORDED` before it is applied (ADR-061 § 4); without it none is applied. */
    private readonly insurancePolicies: InsurancePolicySource = UNCONFIGURED_INSURANCE_POLICY_SOURCE,
    /** The parked-insurance sweep (#240 r8). */
    private readonly parking: ParkingOptions = DEFAULT_PARKING,
    /** `FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS` (#240 r9). */
    private readonly transactionTimeoutMs: number = DEFAULT_TRANSACTION_TIMEOUT_MS,
    /** `FLEET_ASSET_SYNC_TRANSACTION_MAX_WAIT_MS` (#240 r12). */
    private readonly transactionMaxWaitMs: number = DEFAULT_TRANSACTION_MAX_WAIT_MS,
  ) {
    // RastaDeadLetterMessagePublished alerts on an increase, which a series born
    // at one never shows: each topic a parked event can come from starts at zero.
    for (const topic of ASSET_SYNC_TOPICS) {
      for (const source of [topic, `${topic}${RETRY_TOPIC_SUFFIX}`]) {
        dlqMessagesTotal.inc(
          {
            service: this.dlqMetricService,
            topic: source,
            reason: DLQ_REASONS.PARKED_VERIFICATION_EXHAUSTED,
          },
          0,
        );
      }
    }
  }

  private get dlqMetricService(): string {
    return this.parking.dlqMetricService ?? SERVICE_NAME;
  }

  async onModuleInit(): Promise<void> {
    // Null in tests and in any run without a broker. The service stays useful
    // without Kafka; the replica simply stops tracking new machines.
    if (!this.consumerFactory) {
      this.logger.warn('Asset sync consumer disabled — no Kafka broker configured');
      return;
    }
    this.consumer = this.consumerFactory((envelope, delivery) => this.handle(envelope, delivery));
    await this.consumer.start();
    // Only with a consumer: without one nothing is parked. Every instance
    // sweeps; rows are decided under their machine's lock and re-checked there,
    // so two never decide one.
    this.sweepTimer = setInterval(() => void this.runSweep(), this.parking.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
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

    // An INSURANCE_RECORDED is verified at asset-service BEFORE the transaction,
    // with no lock held (#240 r10): the replica is read, the source asked, and the
    // answer decided under the lock only if the replica's insurance revision and
    // epoch (r11) have not moved meanwhile. Writers that take the lock never wait
    // on the network.
    const verified =
      envelope.eventName === CONSUMED_EVENTS.INSURANCE_RECORDED
        ? await this.askAboutRecordedPolicy(
            envelope.eventId,
            payload,
            assetId,
            organizationId,
            delivery,
          )
        : undefined;

    const now = new Date();
    const occurredAt = producerInstant(envelope, now);

    // Whether this delivery moved the machine to another owner: a transfer, or a
    // replay whose refreshed snapshot shows one. The machine's parked insurance
    // events are made due in its transaction, and the sweep decides them (#240 r10).
    let parkedMadeDue = 0;

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
        const current = await this.repository.findAssetRefUnscoped(assetId, tx);

        // An ordinary state event changes a row its tenant must own. One whose
        // (envelope and payload) tenant is not the replica's owner is refused
        // here, under the lock, before any write; the throw rolls the marker
        // back with the transaction, so the corrected event with the same id
        // is still applied (review #205 r2). A `.retry` delivery is not
        // checked here: it writes the owners' answer, asked as this tenant.
        if (
          !replayed &&
          current &&
          OWNER_CHECKED_EVENTS.has(envelope.eventName) &&
          current.organizationId !== organizationId
        ) {
          throw replicaOwnerMismatchError(envelope);
        }

        // The replica's ownership generation only rises (#240 r12). A transfer at
        // or below it — the original of one a replay's refresh already moved past,
        // or a replay of it — is history: applied, it would hand the machine back
        // to an earlier owner and keep the later owner's windows (which its
        // generation leaves standing) for it. Acknowledged, nothing changed.
        if (envelope.eventName === CONSUMED_EVENTS.ASSET_TRANSFERRED) {
          const stated = int(payload.ownershipGeneration);
          const known = current?.ownershipGeneration ?? null;
          if (stated !== undefined && known !== null && stated <= known) {
            this.logger.log(
              `ASSET_TRANSFERRED ${envelope.eventId} of ${assetId} ignored: its ownership generation ` +
                `${stated} is not after the replica's ${known}; owner and insurance left as they are`,
            );
            return;
          }
        }

        // An insurance event from the previous owner's tenant, consumed after the
        // transfer, is applied to the row as it now stands, under its current
        // owner: the policy is the vehicle's, not the organization's (docs/24
        // Q-66). The tenant below comes from the row, never from such an event.
        let patch: AssetRefPatch;
        if (verified) {
          if (verified === 'ALREADY_HANDLED') {
            // Marked when it was read, unmarked since (its parked row was
            // dead-lettered): nothing was asked, so nothing is decided here.
            throw new Error(
              `INSURANCE_RECORDED ${envelope.eventId}: no longer marked handled; verified again`,
            );
          }
          if (!sameInsuranceState(current, verified.read)) {
            // The answer is about a replica that no longer stands — the windows
            // were cleared, a transfer or another policy committed meanwhile. It
            // is discarded; the throw rolls the marker back and the event is
            // verified again from the start (#240 r10).
            throw new Error(
              `INSURANCE_RECORDED ${envelope.eventId}: the insurance state of ${assetId} changed ` +
                'while asset-service was asked; verified again',
            );
          }
          const outcome = this.decideRecordedPolicy(
            verified,
            envelope.eventId,
            payload,
            current,
            now,
            occurredAt,
            organizationId,
          );
          if (outcome.kind === 'PARK') {
            // The source is about an owner the replica has not seen: parked with
            // the marker, applied by nothing until the source is asked again
            // (#240 r8). The replica row is left as it is.
            await this.park(tx, envelope, delivery, assetId, organizationId, outcome.reason);
            return;
          }
          patch = outcome.kind === 'APPLY' ? outcome.patch : {};
        } else {
          patch = projection.patch(payload, current, now, occurredAt, organizationId);
        }
        const refresh = replayed
          ? await this.readAuthoritativeState(envelope, assetId, organizationId, delivery)
          : undefined;
        if (refresh) {
          const known = current?.ownershipGeneration ?? null;
          if (
            known !== null &&
            (refresh.transferGeneration < known ||
              (refresh.transferGeneration === known &&
                current?.organizationId !== refresh.organizationId))
          ) {
            // asset-service's answer is about an earlier tenure than the replica
            // has seen, or names another owner at the same one: written, it would
            // lower the generation or move the owner without one (#240 r12). Not
            // written; retried, then dead-lettered.
            throw new Error(
              `${envelope.eventName} ${envelope.eventId}: asset-service's ownership generation ` +
                `${refresh.transferGeneration} of ${assetId} does not follow the replica's ${known}`,
            );
          }
          // The replica fields come from the owners. What stays of the payload's
          // patch is the safety part, which has its own order-insensitive rules
          // (a repair completion still resolves an older inspection failure) —
          // but only for a tenant that still owns the machine: an event from a
          // previous owner is good for the owner change alone. The generation is
          // the source's too (#240 r12): a transfer at or below it, consumed
          // later, is then recognised as history.
          patch = {
            ...(refresh.viaTransfer
              ? refresh.patch
              : { ...withoutStateFields(patch), ...refresh.patch }),
            ownershipGeneration: refresh.transferGeneration,
          };
          // The snapshot shows a tenure this replica missed the transfer to — a
          // new owner, or a later generation of the same one (A→B→A). It does not
          // state the coverages that follow the vehicle, so none is retained:
          // only windows recorded under the snapshot's generation or a later one
          // (the current tenure's own) stay. Fail closed, as for an older
          // transfer; the re-projection command restores the valid windows.
          if (
            current &&
            (current.organizationId !== refresh.organizationId ||
              (known !== null && refresh.transferGeneration > known))
          ) {
            patch = {
              ...patch,
              insuranceCover: afterTransfer(
                parseCover(current.insuranceCover),
                undefined,
                refresh.transferGeneration,
              ),
              retainedCoverages: [],
            };
          }
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
            await this.revokeWindowsOnTransfer(tx, envelope, assetId, previousOwner, now);
            parkedMadeDue = await this.repository.markParkedInsuranceDue(tx, assetId);
          }
          await this.settleStaleFence(tx, assetId, refresh.organizationId, delivery);
        } else if (envelope.eventName === CONSUMED_EVENTS.ASSET_TRANSFERRED) {
          // The machine's parked insurance events may be about this owner: made
          // due, never decided here. Deciding them asks asset-service once each,
          // which a Kafka handler must not wait on (#240 r10).
          parkedMadeDue = await this.repository.markParkedInsuranceDue(tx, assetId);
          await this.endAssignmentsOnTransfer(tx, envelope, assetId, now, occurredAt);
          await this.revokeWindowsOnTransfer(
            tx,
            envelope,
            assetId,
            payload.fromOrganizationId as string,
            now,
          );
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
      // Every one waits at most the configured time to start (#240 r12); the
      // ordinary ones keep Prisma's 5 s timeout.
      replayed || envelope.eventName === CONSUMED_EVENTS.INSURANCE_RECORDED
        ? { timeoutMs: this.transactionTimeoutMs, maxWaitMs: this.transactionMaxWaitMs }
        : { maxWaitMs: this.transactionMaxWaitMs },
    );

    // Committed: the sweep, outside this handler, decides what the transfer made
    // due — now rather than at its next tick. Not awaited.
    if (parkedMadeDue > 0) this.requestSweep();
  }

  /**
   * One run of the parked-insurance sweep (#240 r8, r10): a bounded batch of
   * events a transfer made due, then of those parked, and last tried, at least
   * the configured age ago, oldest first. Each is re-verified at the source; one
   * still unverified after the maximum attempts is dead-lettered as
   * `PARKED_VERIFICATION_EXHAUSTED`. Exposed so a test can run it without the
   * timer.
   */
  async sweepParked(): Promise<Record<ParkedOutcome, number>> {
    const counts: Record<ParkedOutcome, number> = {
      GONE: 0,
      NOT_DUE: 0,
      APPLIED: 0,
      DROPPED: 0,
      KEPT: 0,
      DEAD_LETTERED: 0,
    };
    const due = await this.repository.listDueParkedInsurance(
      this.parking.minAgeSeconds,
      this.parking.batchSize,
    );
    for (const row of due) {
      try {
        counts[await this.reverifyParked(row.eventId, row.assetId)] += 1;
      } catch (error) {
        this.logger.warn(
          `Parked INSURANCE_RECORDED ${row.eventId} of ${row.assetId} not decided by the sweep; ` +
            `tried again on a later run (${describe(error)})`,
        );
      }
    }
    return counts;
  }

  /**
   * A sweep run now, not awaited: a transfer made parked events due. Only where
   * the timer runs (a started consumer); elsewhere — a test driving `handle` —
   * the caller runs {@link sweepParked} itself.
   */
  private requestSweep(): void {
    if (!this.sweepTimer) return;
    void this.runSweep();
  }

  /**
   * The timer's run, and a requested one: never two at once on one instance —
   * one asked for meanwhile runs right after — and never a thrown error.
   */
  private async runSweep(): Promise<void> {
    if (this.sweeping) {
      this.sweepAgain = true;
      return;
    }
    this.sweeping = true;
    try {
      do {
        this.sweepAgain = false;
        const counts = await this.sweepParked();
        if (counts.APPLIED + counts.DROPPED + counts.DEAD_LETTERED > 0) {
          this.logger.log(
            `Parked insurance sweep: ${counts.APPLIED} applied, ${counts.DROPPED} dropped, ` +
              `${counts.KEPT} still parked, ${counts.DEAD_LETTERED} dead-lettered`,
          );
        }
      } while (this.sweepAgain);
    } catch (error) {
      this.logger.warn(
        `Parked insurance sweep failed; tried again on its next run (${describe(error)})`,
      );
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Parks an `INSURANCE_RECORDED` in the delivery's transaction, after its
   * marker (#240 r8). Stored under the envelope's tenant, with where it came
   * from so a dead letter of it is one the replay tool accepts.
   */
  private async park(
    tx: ExtendedPrismaClient,
    envelope: EventEnvelope,
    delivery: EventDelivery | undefined,
    assetId: string,
    organizationId: string,
    reason: ParkReason,
  ): Promise<void> {
    await this.repository.parkInsuranceEvent(tx, {
      eventId: envelope.eventId,
      assetId,
      organizationId,
      correlationId: envelope.correlationId,
      envelope,
      messageKey: delivery?.key ?? null,
      sourceTopic: delivery?.topic ?? INSURANCE_TOPIC,
      sourcePartition: delivery?.partition ?? null,
      sourceOffset: delivery?.offset ?? null,
      reason,
    });
    this.logger.log(
      `INSURANCE_RECORDED ${envelope.eventId} parked (${reason}): asset-service answers for a later ` +
        `owner of ${assetId} than the replica has seen; made due when the transfer is consumed`,
    );
  }

  /**
   * Decides one parked event (#240 r8–r10). The same verification and the same
   * generation fence as a live delivery ({@link decideInsurance}): applied with
   * the source's window, or removed when the source says the policy does not
   * count or its answer is older than the replica, or kept with one more attempt
   * counted. Nothing is ever applied unverified.
   *
   * Three steps, and asset-service is asked in none of the transactions (r9): a
   * transaction that waited on the source could expire before it recorded the
   * attempt, and the attempts would then never advance. So the row and the
   * replica — its insurance revision included — are read under the machine's
   * lock; the source is asked with no transaction open (a source with no answer
   * counts as an attempt); and the decision is taken in a second short
   * transaction that re-checks, under the lock, that nobody tried the row
   * meanwhile and that the replica's insurance revision, epoch (r11), owner and
   * generation are still those the source was asked about (r10).
   *
   * A row whose attempts reached the maximum is dead-lettered in that decision's
   * transaction: the dead letter is enqueued in the outbox, and the row and the
   * event's marker are deleted (r9, ADR-021). The relay publishes it once that
   * commits — so a replay of it is applied — and never if it rolls back, when the
   * row and the marker stay.
   */
  private async reverifyParked(eventId: string, assetId: string): Promise<ParkedOutcome> {
    const read = await this.repository.transaction(
      async (tx: ExtendedPrismaClient): Promise<ParkedRead | ParkedOutcome> => {
        await this.repository.lockAssetRef(tx, assetId);
        const row = await this.repository.findParkedInsurance(
          tx,
          eventId,
          this.parking.minAgeSeconds,
        );
        if (!row) return 'GONE';
        if (!row.due) return 'NOT_DUE';
        const parsed = CONSUMED_PAYLOADS[CONSUMED_EVENTS.INSURANCE_RECORDED].schema.safeParse(
          (row.envelope as EventEnvelope).payload,
        );
        if (!parsed.success) {
          // Validated before it was parked; a row that no longer parses names
          // nothing the source can be asked about.
          await this.repository.deleteParkedInsurance(tx, eventId);
          this.logger.warn(
            `Parked INSURANCE_RECORDED ${eventId} removed: its payload no longer parses`,
          );
          return 'DROPPED';
        }
        const current = await this.repository.findAssetRefUnscoped(assetId, tx);
        return { row, payload: parsed.data as Record<string, unknown>, current };
      },
      { timeoutMs: this.transactionTimeoutMs, maxWaitMs: this.transactionMaxWaitMs },
    );
    if (typeof read === 'string') return read;

    // No transaction is open while the source is asked.
    const question = insuranceQuestion(read.payload, read.current, read.row.organizationId);
    let answer: PolicyVerdict | 'NO_ANSWER' | undefined;
    if (question.kind === 'ASK') {
      try {
        answer = await this.insurancePolicies.verify(
          question.organizationId,
          question.assetId,
          question.policyId,
        );
      } catch (error) {
        this.logger.warn(
          `Parked INSURANCE_RECORDED ${eventId}: no answer from asset-service (${describe(error)})`,
        );
        answer = 'NO_ANSWER';
      }
    }

    let lettered: { sourceTopic: string; attempts: number; last: ParkReason } | undefined;
    const outcome = await this.repository.transaction(
      async (tx: ExtendedPrismaClient): Promise<ParkedOutcome> => {
        await this.repository.lockAssetRef(tx, assetId);
        const row = await this.repository.findParkedInsurance(
          tx,
          eventId,
          this.parking.minAgeSeconds,
        );
        if (!row) return 'GONE';
        // Another run (a sweep on another instance) tried it while the source
        // was asked: its decision stands, this answer is not counted.
        if (row.attempts !== read.row.attempts) return 'NOT_DUE';
        const current = await this.repository.findAssetRefUnscoped(assetId, tx);
        if (!sameInsuranceState(current, read.current)) {
          // The replica's insurance state changed meanwhile — a transfer, a
          // refresh, `insurance:clear-transferred`, another policy — so the answer
          // is about a replica that no longer stands (r10). Discarded, no attempt
          // counted: the row stays parked and due, and the next run asks again.
          this.logger.log(
            `Parked INSURANCE_RECORDED ${eventId}: the insurance state of ${assetId} changed while ` +
              'the source was asked; decided again later',
          );
          return 'KEPT';
        }

        const now = new Date();
        const decided: InsuranceOutcome =
          question.kind === 'DROP'
            ? { kind: 'DROP', reason: question.reason }
            : answer === 'NO_ANSWER' || answer === undefined
              ? { kind: 'PARK', reason: 'NO_ANSWER' }
              : this.decideInsurance(
                  PROJECTIONS[CONSUMED_EVENTS.INSURANCE_RECORDED],
                  eventId,
                  read.payload,
                  answer,
                  current,
                  now,
                  producerInstant(row.envelope as EventEnvelope, now),
                  row.organizationId,
                );

        if (decided.kind === 'APPLY') {
          await this.repository.upsertAssetRef(tx, {
            ...decided.patch,
            id: assetId,
            organizationId: current?.organizationId ?? row.organizationId,
            sourceEvent: CONSUMED_EVENTS.INSURANCE_RECORDED,
          });
          await this.repository.deleteParkedInsurance(tx, eventId);
          this.logger.log(
            `Parked INSURANCE_RECORDED ${eventId} verified and applied to ${assetId}`,
          );
          return 'APPLIED';
        }
        if (decided.kind === 'DROP') {
          await this.repository.deleteParkedInsurance(tx, eventId);
          this.logger.log(
            `Parked INSURANCE_RECORDED ${eventId} removed, nothing applied (${decided.reason})`,
          );
          return 'DROPPED';
        }

        const attempts = await this.repository.recordParkedAttempt(tx, eventId, decided.reason);
        if (attempts >= this.parking.maxAttempts) {
          // One transaction: the dead letter is published exactly when the row
          // and the marker are gone (r9).
          await this.repository.enqueueDeadLetter(
            tx,
            this.parkedDeadLetter(row, attempts, decided.reason),
          );
          await this.repository.deleteParkedInsurance(tx, eventId);
          await this.repository.unmarkEventProcessed(tx, eventId, CONSUMER_NAME);
          lettered = { sourceTopic: row.sourceTopic, attempts, last: decided.reason };
          return 'DEAD_LETTERED';
        }
        return 'KEPT';
      },
      { timeoutMs: this.transactionTimeoutMs, maxWaitMs: this.transactionMaxWaitMs },
    );

    if (lettered) {
      // Counted once committed: the relay publishes what the outbox holds.
      dlqMessagesTotal.inc({
        service: this.dlqMetricService,
        topic: lettered.sourceTopic,
        reason: DLQ_REASONS.PARKED_VERIFICATION_EXHAUSTED,
      });
      this.logger.error(
        `Parked INSURANCE_RECORDED ${eventId} of ${assetId} dead-lettered ` +
          `(${DLQ_REASONS.PARKED_VERIFICATION_EXHAUSTED}) after ${lettered.attempts} attempts; ` +
          `last: ${lettered.last}`,
      );
    }
    return outcome;
  }

  /**
   * A parked event's dead letter, as the producer published it: the original
   * envelope under the key the record carried, with the platform headers and
   * why, from where and after how many attempts (the consumer's own DLQ
   * headers, {@link deadLetterHeaders}).
   */
  private parkedDeadLetter(
    row: ParkedInsurance,
    attempts: number,
    lastReason: ParkReason,
  ): DeadLetterOutboxInput {
    const envelope = row.envelope as EventEnvelope;
    const headers = deadLetterHeaders(envelopeHeaders(envelope), {
      reason: DLQ_REASONS.PARKED_VERIFICATION_EXHAUSTED,
      originalTopic: row.sourceTopic,
      ...(row.sourcePartition === null ? {} : { originalPartition: row.sourcePartition }),
      ...(row.sourceOffset === null ? {} : { originalOffset: row.sourceOffset }),
      attempts,
      // Fixed text and identifiers; the event and machine ids are the sender's,
      // so the whole is made safe for a header (S-09).
      detail: safeLogText(
        `Parked verification exhausted (${DLQ_REASONS.PARKED_VERIFICATION_EXHAUSTED}): ` +
          `INSURANCE_RECORDED ${row.eventId} for ${row.assetId} still unverified after ` +
          `${attempts} attempts (last: ${lastReason})`,
        HANDLER_MESSAGE_MAX,
      ),
      producer: this.dlqMetricService,
      failedAt: new Date(),
    });
    return {
      topic: ASSET_SYNC_DEAD_LETTER_TOPIC,
      // The publisher's partition key (D-040), which the replay goes out under.
      key: row.messageKey ?? envelope.streamKey ?? envelope.aggregateId,
      envelope,
      headers: Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name, String(value)]),
      ),
      organizationId: row.organizationId,
    };
  }

  /**
   * What an `INSURANCE_RECORDED` does — from what asset-service confirms, never
   * from the event alone (ADR-061 § 4, #240 r6–r8).
   *
   * Whatever route delivered the event (live, `.retry`, a dead-letter replay, a
   * re-projection), it is a statement about the past: after the following list
   * is narrowed, or from a previous tenure (A→B→A), it can name a policy that
   * no longer counts. So the policy is asked about, and only a policy that
   * counts for the CURRENT owner under asset-service's CURRENT rule is stored —
   * with the window and generation the source states.
   *
   * **No permanent decision is made without the source.** Every event is
   * verified, however old its generation or foreign its tenant looks from the
   * replica: a policy the current rule counts must never be lost to a guess made
   * from a retained list (a legacy transfer retains none). A source that says
   * the policy does not count, or does not know it, ends the event (DROP:
   * acknowledged, reason logged). No answer throws: on a live delivery the marker
   * rolls back, the event is retried, and nothing is applied unverified.
   *
   * The source is asked as the owner the replica shows, and answers the current
   * owner only. `NOT_CURRENT_OWNER` means the asset has moved on and this replica
   * has not consumed the transfer yet: not a verdict on the policy. The topics
   * carry no order between them, so retrying for a second and dead-lettering
   * lost a valid policy (#240 r8): the event is PARKED, made due when the
   * transfer is consumed, and verified again by the sweep.
   *
   * No lock is held while the source is asked, live or parked (#240 r9, r10):
   * the replica is read first, its insurance revision with it; the source is
   * asked with no transaction open; and the answer is decided under the lock
   * only if that revision — moved by every change to the windows, the retained
   * list, the lapses, the owner or the generation — and the invalidation epoch
   * — moved by every `insurance:clear-transferred` that targets the machine, even
   * one with nothing to empty (r11) — still stand. Otherwise the
   * answer is discarded and the event verified again: a live delivery fails and
   * is retried with its marker rolled back, a parked one stays parked. A live
   * delivery's marker and effect still commit together, in its transaction.
   *
   * This method is the live delivery's first two steps: the replica as it
   * stands, then the source's answer — or, for a redelivery of a handled event,
   * nothing asked at all. No answer throws: the event is retried, nothing written.
   * The two reads together take at most the transaction's start wait (#240 r12),
   * so the delivery budget bounds them; slower, the attempt fails and is retried.
   */
  private async askAboutRecordedPolicy(
    eventId: string,
    payload: Record<string, unknown>,
    assetId: string,
    eventOrganization: string | undefined,
    delivery: EventDelivery | undefined,
  ): Promise<LiveAnswer> {
    const before = await withinDeadline(
      this.transactionMaxWaitMs,
      `INSURANCE_RECORDED ${eventId}: reading the replica of ${assetId}`,
      async () =>
        (await this.repository.isEventProcessed(eventId, CONSUMER_NAME))
          ? ('ALREADY_HANDLED' as const)
          : { read: await this.repository.findAssetRefUnscoped(assetId) },
    );
    if (before === 'ALREADY_HANDLED') return before;
    const { read } = before;
    const question = insuranceQuestion(payload, read, eventOrganization);
    if (question.kind === 'DROP') return { read, outcome: question };
    const verdict = await asking(delivery, () =>
      this.insurancePolicies.verify(question.organizationId, question.assetId, question.policyId),
    );
    return { read, verdict };
  }

  /**
   * The live delivery's decision, in its transaction under the lock, on the
   * replica as it stands there — which {@link handle} has already found to be
   * at the insurance revision the source was asked about.
   */
  private decideRecordedPolicy(
    answer: Exclude<LiveAnswer, 'ALREADY_HANDLED'>,
    eventId: string,
    payload: Record<string, unknown>,
    current: CurrentAssetRef | null,
    now: Date,
    occurredAt: Date,
    eventOrganization: string | undefined,
  ): InsuranceOutcome {
    if ('outcome' in answer) return answer.outcome;
    return this.decideInsurance(
      PROJECTIONS[CONSUMED_EVENTS.INSURANCE_RECORDED],
      eventId,
      payload,
      answer.verdict,
      current,
      now,
      occurredAt,
      eventOrganization,
    );
  }

  /**
   * What asset-service's answer means for the replica as it stands, read under
   * the machine's lock. The answer is a snapshot: a transfer can commit at the
   * source before this transaction does. So the source's ownership generation
   * and owner are compared with the replica's — equal, apply; the source ahead,
   * park (the transfer event will arrive, and the policy is then verified
   * again); the source behind, the answer is stale and the event dropped.
   */
  private decideInsurance(
    projection: Projection,
    eventId: string,
    payload: Record<string, unknown>,
    verdict: PolicyVerdict,
    current: CurrentAssetRef | null,
    now: Date,
    occurredAt: Date,
    eventOrganization: string | undefined,
  ): InsuranceOutcome {
    const policyId = str(payload.policyId);
    if (!verdict.counts) {
      if (verdict.reason === 'NOT_CURRENT_OWNER')
        return { kind: 'PARK', reason: 'NOT_CURRENT_OWNER' };
      this.logger.log(
        `INSURANCE_RECORDED ${eventId} ignored: asset-service says policy ${policyId} ` +
          `does not count (${verdict.reason})`,
      );
      return { kind: 'DROP', reason: verdict.reason };
    }

    if (current) {
      const order = sourceOrder(verdict, current);
      if (order === 'AHEAD') return { kind: 'PARK', reason: 'SOURCE_AHEAD' };
      if (order === 'BEHIND') {
        this.logger.log(
          `INSURANCE_RECORDED ${eventId} ignored: the answer for policy ${policyId} is older ` +
            `than the replica (ownership generation ${verdict.ownershipGeneration})`,
        );
        return { kind: 'DROP', reason: 'SOURCE_BEHIND' };
      }
    }

    // The event's own coverage, window and generation are replaced by the
    // source's. The replica's owner and generation stay the transfer events' to
    // set: this only ever adds a window the source stands behind.
    return {
      kind: 'APPLY',
      patch: projection.patch(
        {
          ...payload,
          coverage: verdict.coverage,
          validFrom: verdict.validFrom,
          validTo: verdict.validUntil,
          ownershipGeneration: verdict.ownershipGeneration,
        },
        current,
        now,
        occurredAt,
        eventOrganization,
      ),
    };
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
    delivery: EventDelivery | undefined,
  ): Promise<void> {
    const fence = await this.repository.findTransferFence(assetId, tx);
    if (!fence || fence.organizationId === currentOwner) return;
    const answer = await asking(delivery, () =>
      this.transferRecords.resolve(fence.organizationId, assetId, fence.fenceId),
    );
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
   * The snapshot's ownership generation comes back with it (#240 r12).
   */
  private async readAuthoritativeState(
    envelope: EventEnvelope,
    assetId: string,
    organizationId: string | undefined,
    delivery: EventDelivery | undefined,
  ): Promise<{
    organizationId: string;
    viaTransfer: boolean;
    transferGeneration: number;
    patch: AssetRefPatch;
  }> {
    if (!organizationId) {
      throw new UnprocessableEventError(
        DLQ_REASONS.SOURCE_UNCONFIRMED,
        `${envelope.eventName} ${envelope.eventId} names no organization to ask asset-service for`,
      );
    }
    const snapshot = await asking(delivery, () =>
      this.assetSource.snapshot(organizationId, assetId),
    );
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
        ? await asking(delivery, () =>
            this.maintenanceSource.inMaintenance(snapshot.organizationId, assetId),
          )
        : undefined;
    return {
      organizationId: snapshot.organizationId,
      viaTransfer: snapshot.viaTransfer,
      transferGeneration: snapshot.transferGeneration,
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
   * Revokes the availability windows the previous owner declared in the lag
   * between asset-service committing the transfer and this service learning of
   * it (review #225 round 1, finding 4).
   *
   * Fleet has no synchronous dependency on asset-service, so until this event
   * is applied the replica still names the previous owner, who can declare on a
   * machine that is no longer theirs. Declarations take the asset's lock and
   * re-read its owner under it, so everything after this commit is refused; this
   * withdraws what committed before it. Every live window of the departing
   * owner is revoked, not only those declared in the lag: an open-ended
   * unavailable window declared earlier would otherwise outlive the transfer and
   * block the machine again when it returns to that owner (A→B→A). The row stays
   * as that organization's own history, which the new owner never sees (queries
   * are tenant-scoped).
   *
   * Each withdrawal is published like a person's revoke, under the tenant that
   * made the declaration, with fleet-service as the actor and the transfer
   * event as its cause. The residual lag window is documented in docs/04 § fleet.
   */
  private async revokeWindowsOnTransfer(
    tx: ExtendedPrismaClient,
    envelope: EventEnvelope,
    assetId: string,
    previousOwner: string,
    now: Date,
  ): Promise<void> {
    const revoked = await this.repository.revokeWindowsAfterTransfer(
      tx,
      assetId,
      previousOwner,
      now,
      SYSTEM_ACTOR,
      WINDOW_REVOKE_REASON,
    );

    for (const window of revoked) {
      const context = createSystemContext({
        correlationId: envelope.correlationId,
        organizationId: window.organizationId,
        callerService: SERVICE_NAME,
      });
      await runWithContext(context, () =>
        this.repository.enqueueEvent(tx, {
          aggregateType: 'AvailabilityWindow',
          aggregateId: window.id,
          eventName: FLEET_EVENTS.AVAILABILITY_CHANGED,
          topic: FLEET_TOPIC,
          organizationId: window.organizationId,
          causationId: envelope.eventId,
          payload: validateFleetPayload(FLEET_EVENTS.AVAILABILITY_CHANGED, {
            assetId,
            organizationId: window.organizationId,
            // As for a person's revoke: the fleet's own objection is withdrawn.
            available: true,
            reason: 'Declaration withdrawn: the machine was transferred to another organization',
            from: now.toISOString(),
            to: null,
          }),
        }),
      );
    }

    if (revoked.length > 0) {
      this.logger.log(
        `Revoked ${revoked.length} availability window(s) on ${assetId} declared after it was ` +
          `transferred (${envelope.eventId})`,
      );
    }
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

/** What the first step of a parked event's re-verification read under the lock (#240 r9). */
interface ParkedRead {
  readonly row: ParkedInsurance;
  readonly payload: Record<string, unknown>;
  readonly current: CurrentAssetRef | null;
}

/** Whom to ask about an `INSURANCE_RECORDED`'s policy, or why it names nothing to ask about. */
type InsuranceQuestion =
  | {
      readonly kind: 'ASK';
      readonly organizationId: string;
      readonly assetId: string;
      readonly policyId: string;
    }
  | { readonly kind: 'DROP'; readonly reason: string };

/** The source is asked as the owner the replica shows, else as the event's tenant. */
function insuranceQuestion(
  payload: Record<string, unknown>,
  current: CurrentAssetRef | null,
  eventOrganization: string | undefined,
): InsuranceQuestion {
  const coverage = str(payload.coverage);
  const policyId = str(payload.policyId);
  const assetId = str(payload.assetId);
  if (!coverage || !policyId || !assetId) return { kind: 'DROP', reason: 'INCOMPLETE' };
  const asked = current?.organizationId ?? eventOrganization;
  if (!asked) return { kind: 'DROP', reason: 'NO_OWNER' };
  return { kind: 'ASK', organizationId: asked, assetId, policyId };
}

/**
 * A live `INSURANCE_RECORDED`'s first two steps (#240 r10): the replica as read
 * before the source was asked, with the source's verdict or the outcome decided
 * without asking; or, for an event already handled when it was read, nothing.
 */
type LiveAnswer =
  | 'ALREADY_HANDLED'
  | { readonly read: CurrentAssetRef | null; readonly verdict: PolicyVerdict }
  | { readonly read: CurrentAssetRef | null; readonly outcome: InsuranceOutcome };

/**
 * Whether two reads of the replica show the same insurance state: the same
 * insurance revision (#240 r10), invalidation epoch (r11), owner and ownership
 * generation. The revision moves with any change to the state; the epoch with
 * every `insurance:clear-transferred` that targets the row, including one that
 * found nothing to empty and so changed no value the revision counts. The owner
 * and generation are compared too, so the check does not rest on the trigger
 * alone.
 */
function sameInsuranceState(a: CurrentAssetRef | null, b: CurrentAssetRef | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.insuranceRevision === b.insuranceRevision &&
    a.insuranceEpoch === b.insuranceEpoch &&
    a.organizationId === b.organizationId &&
    (a.ownershipGeneration ?? null) === (b.ownershipGeneration ?? null)
  );
}

/**
 * The producer's clock, for ordering. An unreadable timestamp falls back to now,
 * which dates the event as late as possible: a failure then blocks, and a repair
 * clears only failures that are genuinely older.
 */
function producerInstant(envelope: EventEnvelope, now: Date): Date {
  const stated = new Date(envelope.occurredAt);
  return Number.isNaN(stated.getTime()) ? now : stated;
}

/**
 * One question to another service during a delivery, with the consumer's
 * heartbeat before and after it (#240 r12): kafkajs does not heartbeat while a
 * handler runs, so a delivery that asks several times keeps its member in the
 * group by itself rather than by the startup arithmetic alone. The heartbeat
 * neither waits nor throws. A sweep has no delivery and no heartbeat.
 */
async function asking<T>(delivery: EventDelivery | undefined, call: () => Promise<T>): Promise<T> {
  delivery?.heartbeat?.();
  try {
    return await call();
  } finally {
    delivery?.heartbeat?.();
  }
}

/**
 * `work`, or a failure once `ms` have passed (#240 r12). Bounds reads that have
 * no deadline of their own — a pool connection can be waited for far longer —
 * so they fit the delivery budget; what is abandoned only reads.
 */
async function withinDeadline<T>(ms: number, what: string, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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

/** A non-negative integer field, or undefined. */
function int(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** A list of non-empty strings, or undefined when the field is absent or not one. */
function strList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** Reads a string field, tolerating the absence the loose schema allows. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export { PROJECTIONS, CONSUMER_NAME };
