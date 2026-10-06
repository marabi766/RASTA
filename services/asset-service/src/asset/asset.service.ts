import { isDeepStrictEqual } from 'node:util';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  DOCUMENT_LOOKUP,
  UNCONFIGURED_DOCUMENT_LOOKUP,
  type DocumentLookup,
} from './document-lookup';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { AssetRepository, isUniqueViolation, type CostSummaryRow } from './asset.repository';
import { ASSET_EVENTS, validateAssetPayload } from './events';
import { ASSET_TOPIC, SERVICE_NAME } from '../config/env';
import { transferClearanceTotal } from '../observability/metrics';
import {
  canTransition,
  explainRefusal,
  openWorkRefusal,
  DISPATCHABLE_STATUSES,
  OPEN_WORK_MESSAGES,
  WITHDRAWAL_TARGETS,
  type OpenWorkCode,
  OPEN_ACTIVITY_STATUSES,
  type AssetStatus,
  type TransitionActor,
} from './lifecycle';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import type { ClaimFence } from './idempotency';
import { storedAmountRefusal } from '../insurance/negative-amount';
import {
  DEFAULT_TRANSFER_INSURANCE_POLICY,
  TRANSFER_INSURANCE_POLICY,
  countsForCurrentOwner,
  currentOwnerPolicyFilter,
  type TransferInsurancePolicy,
} from '../insurance/ownership';
import {
  FLEET_SERVICE,
  TRANSFER_CLEARANCE,
  UNCONFIGURED_TRANSFER_CLEARANCE,
  WORK_OWNERS,
  type ClearanceAnswer,
  type TransferClearance,
} from './transfer-clearance';
import type {
  ActivateAssetDto,
  AssetDossierView,
  AssetLocationView,
  AssetView,
  AttachDocumentDto,
  AttachedDocumentView,
  ChangeStatusDto,
  CreateAssetDto,
  DecommissionDto,
  ListAssetsQuery,
  NearbyQuery,
  RecordLocationDto,
  TimelineCategory,
  TimelineEntryView,
  TimelineQuery,
  TransferAssetDto,
  UpdateAssetDto,
} from './dto';

/** Said when a plain status change asks for what only commissioning may do. */
const ACTIVATE_INSTEAD =
  'A registered asset is commissioned with the activate command, which checks that its dossier is complete.';

@Injectable()
export class AssetService {
  private readonly logger = new Logger(AssetService.name);

  constructor(
    private readonly repository: AssetRepository,
    // Optional so a test can build the service with the repository alone; the
    // application provides it from configuration (docs/24 Q-66).
    @Optional()
    @Inject(TRANSFER_INSURANCE_POLICY)
    private readonly transferInsurance: TransferInsurancePolicy = DEFAULT_TRANSFER_INSURANCE_POLICY,
    // Optional for the same reason. Without one, every transfer is refused
    // (ADR-062): a missing dependency never reads as "nothing is open".
    @Optional()
    @Inject(TRANSFER_CLEARANCE)
    private readonly clearance: TransferClearance = UNCONFIGURED_TRANSFER_CLEARANCE,
    // Optional for the same reason. Without one no document is attached: who
    // owns it cannot be asked, and an unverified document is never attached.
    @Optional()
    @Inject(DOCUMENT_LOOKUP)
    private readonly documentLookup: DocumentLookup = UNCONFIGURED_DOCUMENT_LOOKUP,
  ) {}

  // =========================================================================
  // Reads
  // =========================================================================

  async get(id: string): Promise<AssetView> {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);
    return toView(asset);
  }

  /**
   * The caller's organization may see this asset now — the rule {@link get}
   * applies — or `404`, exactly as for one that does not exist. An
   * idempotent replay passes this before it answers (`ReplayGuard`): a stored
   * 201 must not outlive the asset leaving the caller's tenant.
   */
  async assertVisible(id: string): Promise<void> {
    if (!(await this.repository.findById(id))) throw RastaError.notFound('Asset', id);
  }

  async list(query: ListAssetsQuery) {
    const result = await this.repository.list(query);
    return {
      items: result.items.map(toView),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  async nearby(query: NearbyQuery) {
    const organizationId = getOrganizationId();
    const rows = await this.repository.findNearby(organizationId, query);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      assetTag: row.asset_tag,
      type: row.type,
      status: row.status,
      distanceMeters: Math.round(row.distance_meters),
    }));
  }

  async timeline(id: string, query: TimelineQuery) {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);

    const result = await this.repository.listTimeline(id, query);
    return {
      items: result.items.map(toTimelineView),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  /**
   * The electronic dossier (پرونده الکترونیکی).
   *
   * This is the endpoint the product document's fleet chapter is really about:
   * one place that answers what this machine is, whether it may be dispatched
   * today, what it has cost, and what has happened to it.
   *
   * The compliance block is the part with teeth. It is computed live from
   * dates rather than read from a cached flag, because "is this legal to send
   * out right now" must not depend on a background job having run recently.
   */
  async dossier(id: string): Promise<AssetDossierView> {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);

    const [policy, inspection, costRows, transferCount, recent, organization] = await Promise.all([
      this.findCountingPolicy(id),
      this.repository.findLatestInspection(id),
      this.repository.costSummary(id, asset.organizationId),
      this.repository.countTransfers(id),
      this.repository.listTimeline(id, { limit: 10 } as TimelineQuery),
      this.repository.findOrganizationRef(asset.organizationId),
    ]);

    const documents = await this.repository.client.assetDocumentRef.findMany({
      where: { assetId: id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    const currentLocation = await this.repository.client.assetLocation.findFirst({
      where: { assetId: id, isCurrent: true },
    });

    const blockers = this.complianceBlockers(asset.status as AssetStatus, policy, inspection);

    return {
      asset: toView(asset),
      organizationName: organization?.name ?? null,
      currentLocation: currentLocation
        ? {
            id: currentLocation.id,
            siteName: currentLocation.siteName,
            addressLine: currentLocation.addressLine,
            coordinate: await this.repository.readCoordinate(
              currentLocation.id,
              asset.organizationId,
            ),
            source: currentLocation.source,
            recordedAt: currentLocation.recordedAt.toISOString(),
          }
        : null,

      compliance: {
        operable: blockers.length === 0,
        blockers,
        activeInsurance: policy
          ? {
              id: policy.id,
              policyNumber: policy.policyNumber,
              insurerName: policy.insurerName,
              coverage: policy.coverage,
              premiumMinor: policy.premiumMinor?.toString() ?? null,
              insuredValueMinor: policy.insuredValueMinor?.toString() ?? null,
              validFrom: policy.validFrom.toISOString(),
              validTo: policy.validTo.toISOString(),
              status: policy.status,
              daysUntilExpiry: daysUntil(policy.validTo),
            }
          : null,
        latestInspection: inspection
          ? {
              id: inspection.id,
              certificateNo: inspection.certificateNo,
              centerName: inspection.centerName,
              inspectedAt: inspection.inspectedAt.toISOString(),
              validTo: inspection.validTo.toISOString(),
              result: inspection.result,
              notes: inspection.notes,
              daysUntilExpiry: daysUntil(inspection.validTo),
            }
          : null,
      },

      costs: summariseCosts(costRows),

      documents: documents.map((doc) => ({
        id: doc.id,
        documentId: doc.documentId,
        kind: doc.kind,
        title: doc.title,
        issuedAt: doc.issuedAt?.toISOString() ?? null,
        expiresAt: doc.expiresAt?.toISOString() ?? null,
      })),

      recentActivity: recent.items.map(toTimelineView),
      transferCount,
    };
  }

  /**
   * Every reason this asset cannot be dispatched right now.
   *
   * All of them, not just the first: an operator who fixes one blocker should
   * not have to re-request the dossier to discover the next.
   */
  private complianceBlockers(
    status: AssetStatus,
    policy: { validTo: Date } | null,
    inspection: { validTo: Date; result: string } | null,
  ): string[] {
    const blockers: string[] = [];

    if (!DISPATCHABLE_STATUSES.includes(status)) {
      blockers.push(`Asset status is ${status}`);
    }
    if (!policy) {
      blockers.push('No insurance policy is currently in force');
    }
    if (!inspection) {
      blockers.push('No technical inspection on record');
    } else if (inspection.result === 'FAILED') {
      blockers.push('The most recent technical inspection failed');
    } else if (inspection.validTo <= new Date()) {
      blockers.push('The technical inspection certificate has expired');
    }

    return blockers;
  }

  // =========================================================================
  // Writes
  // =========================================================================

  /**
   * Registers an asset. Under an Idempotency-Key, `fence` is the caller's claim
   * on it (#169): checked and locked as the transaction's first statement,
   * completed with this asset's view as its last — so the claim, the asset,
   * its location, its outbox row and the response to replay commit together.
   * `POST /v1/assets` always passes one; the parameter is optional only for
   * in-process callers such as the integration suites' fixtures.
   */
  async create(dto: CreateAssetDto, fence?: ClaimFence<AssetView>): Promise<AssetView> {
    const organizationId = getOrganizationId();

    if (dto.serialNumber) {
      const existing = await this.repository.findBySerialNumber(dto.serialNumber);
      if (existing) {
        // Deliberately says nothing about who holds it. A serial number check
        // that names the other organization would leak another tenant's fleet
        // to anyone willing to guess serials.
        throw RastaError.alreadyExists('Asset');
      }
    }

    if (dto.assetTag) {
      const clash = await this.repository.findByAssetTag(organizationId, dto.assetTag);
      if (clash) throw RastaError.alreadyExists('Asset');
    }

    const id = `${ID_PREFIXES.asset}_${ulid()}`;
    const actor = getContext().userId ?? 'SYSTEM';

    return this.repository.transaction(async (tx) => {
      // Under an Idempotency-Key (#169) the claim is locked by its token
      // before anything else, so a registration whose claim lapsed and was
      // re-taken by a retry commits nothing.
      if (fence) await fence.hold(tx);

      // The lookups above are for a readable refusal. Under a concurrent
      // create, both requests pass them, and the unique indexes decide.
      let asset;
      try {
        asset = await tx.asset.create({
          data: {
            id,
            organizationId,
            name: dto.name,
            type: dto.type,
            assetTag: dto.assetTag ?? null,
            manufacturer: dto.manufacturer ?? null,
            model: dto.model ?? null,
            serialNumber: dto.serialNumber ?? null,
            manufactureYear: dto.manufactureYear ?? null,
            specifications: dto.specifications as object,
            // Registration alone does not make an asset usable. It becomes
            // ACTIVE only once its dossier is complete, which is the check in
            // `activate`.
            status: 'REGISTERED',
            createdBy: actor,
            updatedBy: actor,
          },
        });
      } catch (error) {
        rethrowUniqueAsAlreadyExists(error);
      }

      if (dto.location) {
        await this.insertLocation(tx, id, organizationId, {
          ...dto.location,
          source: 'MANUAL',
        } as RecordLocationDto);
      }

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Asset',
        aggregateId: id,
        eventName: ASSET_EVENTS.ASSET_CREATED,
        topic: ASSET_TOPIC,
        organizationId,
        payload: validateAssetPayload(ASSET_EVENTS.ASSET_CREATED, {
          assetId: id,
          organizationId,
          name: dto.name,
          type: dto.type,
          assetTag: dto.assetTag ?? null,
          serialNumber: dto.serialNumber ?? null,
          status: 'REGISTERED',
        }),
      });

      await this.appendTimeline(tx, {
        assetId: id,
        organizationId,
        eventName: ASSET_EVENTS.ASSET_CREATED,
        sourceEventId: `local-${id}-created`,
        category: 'LIFECYCLE',
        title: 'ثبت دارایی',
        description: `${dto.name} در ناوگان ثبت شد`,
        occurredAt: new Date(),
      });

      // Last: the response to replay commits with the asset and its outbox
      // row, or none of them does.
      const view = toView(asset);
      return fence ? fence.complete(tx, view) : view;
    });
  }

  async update(id: string, dto: UpdateAssetDto): Promise<AssetView> {
    const { expectedVersion, ...fields } = dto;

    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);

    if (asset.status === 'DECOMMISSIONED') {
      throw RastaError.invalidStateTransition(
        'Asset',
        asset.status,
        asset.status,
        'A decommissioned asset is a historical record and cannot be edited',
      );
    }

    // The edit was made against a version that is no longer current: somebody
    // else's edit landed first, and applying this one would put back what they
    // changed. Decided before anything else so the answer does not depend on
    // what the fields happen to hold.
    if (asset.version !== expectedVersion) {
      throw RastaError.optimisticLockFailed('Asset', id);
    }

    // What this request really changes, not what it names: a field sent with
    // the value it already has is not a change, and `ASSET_UPDATED` must not say
    // it was (consumers read `changedFields` to decide what to refresh).
    const changes = changedAssetFields(asset, fields);
    const changedFields = Object.keys(changes);
    if (changedFields.length === 0) return toView(asset);

    if (changes.assetTag) {
      const clash = await this.repository.findByAssetTag(asset.organizationId, changes.assetTag);
      if (clash && clash.id !== id) throw RastaError.alreadyExists('Asset');
    }

    const actor = getContext().userId ?? 'SYSTEM';

    const updated = await this.repository.transaction(async (tx) => {
      // Guarded on the row, not only on the read above: a decommission that
      // commits in between must not be followed by an edit (audit L3-07), and
      // an edit that commits in between must not be overwritten by one made
      // against the version before it.
      let count: number;
      try {
        ({ count } = await tx.asset.updateMany({
          where: {
            id,
            deletedAt: null,
            status: { not: 'DECOMMISSIONED' },
            version: expectedVersion,
          },
          data: {
            ...(changes.name !== undefined ? { name: changes.name } : {}),
            ...('assetTag' in changes ? { assetTag: changes.assetTag } : {}),
            ...('manufacturer' in changes ? { manufacturer: changes.manufacturer } : {}),
            ...('model' in changes ? { model: changes.model } : {}),
            ...('manufactureYear' in changes ? { manufactureYear: changes.manufactureYear } : {}),
            ...(changes.specifications !== undefined
              ? { specifications: changes.specifications as object }
              : {}),
            updatedBy: actor,
            version: { increment: 1 },
          },
        }));
      } catch (error) {
        rethrowUniqueAsAlreadyExists(error);
      }
      if (count === 0) throw RastaError.optimisticLockFailed('Asset', id);

      const row = await this.reread(tx, id);

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Asset',
        aggregateId: id,
        eventName: ASSET_EVENTS.ASSET_UPDATED,
        topic: ASSET_TOPIC,
        organizationId: asset.organizationId,
        aggregateVersion: row.version,
        payload: validateAssetPayload(ASSET_EVENTS.ASSET_UPDATED, {
          assetId: id,
          organizationId: asset.organizationId,
          changedFields,
        }),
      });

      return row;
    });

    return toView(updated);
  }

  /**
   * Commissions the asset.
   *
   * The invariant the product document implies and this enforces: an asset is
   * not usable until its file is complete. Activating a machine with no
   * insurance would put the organization in breach the moment it left the
   * yard, so the refusal lists precisely what is missing.
   */
  async activate(id: string, dto: ActivateAssetDto): Promise<AssetView> {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);

    this.assertVersion(asset, dto.expectedVersion);
    this.assertTransition(asset.status as AssetStatus, 'ACTIVE', 'USER');

    await this.assertCommissioningDossier(id);

    const commissionedAt = dto.commissionedAt ? new Date(dto.commissionedAt) : new Date();
    const actor = getContext().userId ?? 'SYSTEM';

    const updated = await this.repository.transaction(async (tx) => {
      const row = await this.compareAndSet(
        tx,
        id,
        asset.status,
        {
          status: 'ACTIVE',
          commissionedAt,
          updatedBy: actor,
        },
        { version: dto.expectedVersion },
      );

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Asset',
        aggregateId: id,
        eventName: ASSET_EVENTS.ASSET_ACTIVATED,
        topic: ASSET_TOPIC,
        organizationId: asset.organizationId,
        payload: validateAssetPayload(ASSET_EVENTS.ASSET_ACTIVATED, {
          assetId: id,
          organizationId: asset.organizationId,
          commissionedAt: commissionedAt.toISOString(),
        }),
      });

      await this.appendTimeline(tx, {
        assetId: id,
        organizationId: asset.organizationId,
        eventName: ASSET_EVENTS.ASSET_ACTIVATED,
        sourceEventId: `local-${id}-activated-${commissionedAt.getTime()}`,
        category: 'LIFECYCLE',
        title: 'ورود به ناوگان',
        description: 'دارایی فعال و آماده بهره‌برداری شد',
        occurredAt: commissionedAt,
      });

      return row;
    });

    return toView(updated);
  }

  /**
   * What "commissioned for the current owner" means (#234 round 1): the CURRENT owner holds the
   * commissioning dossier now — an insurance policy that counts for it (Q-66: the previous owner's
   * in-force policy follows the vehicle) **and** an ownership title or registration card that is its
   * own row (`organization_id` is the current owner's; the previous owner's references stay with
   * it, Q-99, so they never satisfy this). The check is made on every user transition into an
   * operable state from an asset the current owner has not commissioned: REGISTERED → ACTIVE
   * (`activate`) and OUT_OF_SERVICE → ACTIVE, which is how a transferred asset could otherwise
   * be put into service without its own paperwork (REGISTERED → OUT_OF_SERVICE → ACTIVE). IDLE →
   * ACTIVE needs none: IDLE is reachable only from ACTIVE, so an IDLE asset was commissioned by the
   * owner it has now (a transfer always lands in REGISTERED).
   */
  private async assertCommissioningDossier(id: string): Promise<void> {
    const [policy, ownershipDoc] = await Promise.all([
      this.findCountingPolicy(id),
      this.repository.client.assetDocumentRef.findFirst({
        where: {
          assetId: id,
          deletedAt: null,
          kind: { in: ['OWNERSHIP_TITLE', 'REGISTRATION_CARD'] },
        },
      }),
    ]);

    const missing: string[] = [];
    if (!policy) missing.push('an insurance policy currently in force');
    if (!ownershipDoc) missing.push('an ownership title or registration card');

    if (missing.length > 0) {
      throw RastaError.businessRule(
        `The asset cannot be activated without ${missing.join(' and ')}.`,
        { rule: 'INCOMPLETE_DOSSIER', assetId: id, missing },
      );
    }
  }

  async changeStatus(id: string, dto: ChangeStatusDto): Promise<AssetView> {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);

    this.assertVersion(asset, dto.expectedVersion);

    // Commissioning is `activate`, which refuses an asset whose dossier is
    // incomplete. The table allows REGISTERED → ACTIVE for a user, so without
    // this the plain status route was a way round that check.
    if (asset.status === 'REGISTERED' && dto.status === 'ACTIVE') {
      throw RastaError.invalidStateTransition('Asset', 'REGISTERED', 'ACTIVE', ACTIVATE_INSTEAD);
    }

    this.assertTransition(asset.status as AssetStatus, dto.status as AssetStatus, 'USER');

    // Returning from OUT_OF_SERVICE is a way into service like any other: an asset the current owner
    // has not commissioned (one that came from a transfer and was withdrawn before it was ever
    // activated) goes through the same dossier check as `activate`.
    if (asset.status === 'OUT_OF_SERVICE' && dto.status === 'ACTIVE') {
      await this.assertCommissioningDossier(id);
    }

    const write = (assertWithinDeadline: () => void = () => undefined) =>
      this.repository.transaction(async (tx) => {
        const row = await this.writeStatusChange(
          tx,
          id,
          asset,
          dto.status,
          dto.reason,
          dto.expectedVersion,
        );
        // Still inside the transaction: too late rolls it back.
        assertWithinDeadline();
        return row;
      });

    // Leaving service: the owners of the machine's work are asked first (Q-94).
    const updated = WITHDRAWAL_TARGETS.includes(dto.status as AssetStatus)
      ? await this.withWithdrawalClearance(id, asset, dto.status as AssetStatus, write)
      : await write();
    return toView(updated);
  }

  async decommission(id: string, dto: DecommissionDto): Promise<AssetView> {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);

    this.assertVersion(asset, dto.expectedVersion);
    this.assertTransition(asset.status as AssetStatus, 'DECOMMISSIONED', 'USER');

    const decommissionedAt = dto.decommissionedAt ? new Date(dto.decommissionedAt) : new Date();
    const actor = getContext().userId ?? 'SYSTEM';

    // Leaving for good: the owners of the machine's work are asked first (Q-94).
    const updated = await this.withWithdrawalClearance(
      id,
      asset,
      'DECOMMISSIONED',
      (assertWithinDeadline) =>
        this.repository.transaction(async (tx) => {
          const row = await this.compareAndSet(
            tx,
            id,
            asset.status,
            {
              status: 'DECOMMISSIONED',
              decommissionedAt,
              decommissionedReason: dto.reason,
              updatedBy: actor,
            },
            { version: dto.expectedVersion },
          );

          await this.repository.enqueueEvent(tx, {
            aggregateType: 'Asset',
            aggregateId: id,
            eventName: ASSET_EVENTS.ASSET_DECOMMISSIONED,
            topic: ASSET_TOPIC,
            organizationId: asset.organizationId,
            payload: validateAssetPayload(ASSET_EVENTS.ASSET_DECOMMISSIONED, {
              assetId: id,
              organizationId: asset.organizationId,
              reason: dto.reason,
              decommissionedAt: decommissionedAt.toISOString(),
            }),
          });

          await this.appendTimeline(tx, {
            assetId: id,
            organizationId: asset.organizationId,
            eventName: ASSET_EVENTS.ASSET_DECOMMISSIONED,
            sourceEventId: `local-${id}-decommissioned-${decommissionedAt.getTime()}`,
            category: 'LIFECYCLE',
            title: 'اسقاط',
            description: dto.reason,
            occurredAt: decommissionedAt,
          });

          // Still inside the transaction: too late rolls it back.
          assertWithinDeadline();
          return row;
        }),
    );

    return toView(updated);
  }

  /**
   * Transfers ownership.
   *
   * The identity is untouched — same id, same history, same timeline. Only the
   * tenant column moves. That is the whole point of ADR-012: a machine that
   * changes hands is the same machine, and its maintenance record must not be
   * orphaned by the paperwork.
   */
  async transfer(id: string, dto: TransferAssetDto): Promise<AssetView> {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);

    if (asset.organizationId === dto.toOrganizationId) {
      throw RastaError.businessRule('The asset already belongs to that organization', {
        rule: 'SAME_ORGANIZATION',
      });
    }

    if (asset.status === 'DECOMMISSIONED') {
      throw RastaError.invalidStateTransition(
        'Asset',
        asset.status,
        asset.status,
        'A decommissioned asset cannot be transferred',
      );
    }

    // An open assignment or repair belongs to the current owner and would stay
    // behind with them (audit L3-03). Refused rather than closed from here:
    // fleet-service and maintenance-service own that work, and this service
    // has no business ending it on their behalf. This check is the cheap,
    // readable one; the owners are asked below (ADR-062).
    if (OPEN_ACTIVITY_STATUSES.includes(asset.status as AssetStatus)) {
      throw RastaError.businessRule(
        `The asset is ${asset.status}. End the assignment or repair before transferring it.`,
        { rule: 'OPEN_OPERATIONAL_ACTIVITY', status: asset.status },
      );
    }

    const destination = await this.repository.findOrganizationRef(dto.toOrganizationId);
    if (!destination) {
      throw RastaError.notFound('Organization', dto.toOrganizationId);
    }
    if (destination.status !== 'ACTIVE') {
      throw RastaError.businessRule(
        'The receiving organization is not active and cannot take ownership',
        { rule: 'INACTIVE_DESTINATION', status: destination.status },
      );
    }

    const transferId = `TRF_${ulid()}`;
    const actor = getContext().userId ?? 'SYSTEM';
    const from = asset.organizationId;

    // Read before the first question is sent, so the time counted here is
    // never shorter than a fence's real age: no clock needs to agree with
    // another service's (ADR-062 § 3).
    const askedAt = this.clearance.now();
    await this.clearTransfer(id, from, transferId);
    const deadlineMs = (this.clearance.fenceTtlSeconds * 1000) / 2;

    // Set as the transaction callback's last step. An error before it rolls
    // the transfer back for certain; an error after it (the COMMIT failing or
    // its acknowledgement lost) leaves the outcome unknown, and an unknown
    // outcome keeps the fences: the owners resolve them against this
    // service's record once they expire (ADR-062 § 3b), never by guessing.
    const boundary = { reached: false };

    try {
      return await this.commitTransfer(
        id,
        asset.status,
        from,
        dto,
        transferId,
        actor,
        () => {
          if (this.clearance.now() - askedAt >= deadlineMs) {
            throw RastaError.invalidStateTransition(
              'Asset',
              asset.status,
              'TRANSFERRED',
              'The transfer took too long to confirm and was not recorded. Try again.',
            );
          }
        },
        () => {
          boundary.reached = true;
        },
      );
    } catch (error) {
      if (!boundary.reached) await this.releaseFences(id, from, transferId);
      throw error;
    }
  }

  /**
   * Asks every owner of the machine's work, at once, whether any is open
   * (ADR-062). Each owner that finds none fences the machine.
   *
   * Every owner must answer clear. On any other outcome the transfer is
   * refused — open work as a business rule naming the owner, anything
   * unanswerable as the owner's error — and every owner is sent the release,
   * not only those that answered clear: an owner whose answer was lost (a
   * timeout, a truncated body) may have committed its fence all the same.
   */
  private async clearTransfer(
    assetId: string,
    organizationId: string,
    transferId: string,
  ): Promise<void> {
    const outcomes = await Promise.allSettled(
      WORK_OWNERS.map((owner) => this.clearance.ask(owner, organizationId, assetId, transferId)),
    );

    for (const [index, outcome] of outcomes.entries()) {
      transferClearanceTotal.inc({
        service: SERVICE_NAME,
        owner: WORK_OWNERS[index],
        outcome: clearanceOutcome(outcome),
      });
    }

    if (outcomes.every((outcome) => outcome.status === 'fulfilled' && outcome.value.clear)) {
      return;
    }

    await this.releaseFences(assetId, organizationId, transferId);

    // Open work first: it is the refusal a person can act on.
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === 'fulfilled' && !outcome.value.clear) {
        throw RastaError.businessRule(
          'The asset still has open work with its current owner. End the assignment or repair before transferring it.',
          {
            rule: 'OPEN_OPERATIONAL_ACTIVITY',
            owner: WORK_OWNERS[index],
            ...outcome.value.open,
          },
        );
      }
    }
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    throw failure?.reason ?? RastaError.internal('Transfer clearance returned no answer');
  }

  /** Sends the idempotent release to every owner; best effort, never throws. */
  private async releaseFences(
    assetId: string,
    organizationId: string,
    transferId: string,
  ): Promise<void> {
    await Promise.all(
      WORK_OWNERS.map((owner) =>
        this.clearance.release(owner, organizationId, assetId, transferId),
      ),
    );
  }

  /**
   * Runs a write that takes the asset out of service, or retires it, only after
   * the owners of its work have said nothing is open (docs/24 Q-94).
   *
   * The asset's own status is not enough: a repair can be started on an
   * OUT_OF_SERVICE asset, which maintenance accepts and this service keeps as
   * OUT_OF_SERVICE, and an assignment committed in fleet-service shows here only
   * once its event is consumed. So fleet-service and maintenance-service are
   * asked, exactly as a transfer asks them (ADR-062): each counts, and when
   * nothing is open fences the machine, so no work starts there while the
   * write commits. Every owner must say clear. Anything else — open work, a
   * conflict, an owner that is down or slow — refuses the command with nothing
   * written, open work as the closed reason (`OPEN_ASSIGNMENT`,
   * `OPEN_MAINTENANCE`) and an unavailable owner as 503 or 504; unavailable
   * never means clear.
   *
   * The write must finish inside half the fence's life — it checks
   * `assertWithinDeadline` as its last step in the transaction, so too late
   * rolls it back — and the fences are lifted afterwards whatever happened. What
   * remains is the lag between the commit and the owners consuming
   * `ASSET_STATUS_CHANGED` / `ASSET_DECOMMISSIONED` (a residual, recorded in
   * docs/24 Q-94).
   */
  private async withWithdrawalClearance<T>(
    id: string,
    asset: { organizationId: string; status: string },
    to: AssetStatus,
    write: (assertWithinDeadline: () => void) => Promise<T>,
  ): Promise<T> {
    // The id's shape is what the owners' fence endpoints accept (`TRF_` + a
    // ULID); this fence is lifted by the release below or by its expiry.
    const fenceId = `TRF_${ulid()}`;
    const from = asset.organizationId;

    const askedAt = this.clearance.now();
    await this.clearForWithdrawal(id, from, fenceId, asset.status as AssetStatus, to);
    const deadlineMs = (this.clearance.fenceTtlSeconds * 1000) / 2;

    try {
      return await write(() => {
        if (this.clearance.now() - askedAt >= deadlineMs) {
          throw RastaError.invalidStateTransition(
            'Asset',
            asset.status,
            to,
            'The change took too long to confirm and was not recorded. Try again.',
          );
        }
      });
    } finally {
      await this.releaseFences(id, from, fenceId);
    }
  }

  /** Asks every owner at once; on anything but all-clear, lifts every fence and refuses. */
  private async clearForWithdrawal(
    assetId: string,
    organizationId: string,
    fenceId: string,
    from: AssetStatus,
    to: AssetStatus,
  ): Promise<void> {
    const outcomes = await Promise.allSettled(
      WORK_OWNERS.map((owner) => this.clearance.ask(owner, organizationId, assetId, fenceId)),
    );

    for (const [index, outcome] of outcomes.entries()) {
      transferClearanceTotal.inc({
        service: SERVICE_NAME,
        owner: WORK_OWNERS[index],
        outcome: clearanceOutcome(outcome),
      });
    }

    if (outcomes.every((outcome) => outcome.status === 'fulfilled' && outcome.value.clear)) {
      return;
    }

    // Every owner is sent the release, not only those that answered clear: one
    // whose answer was lost may have committed its fence all the same.
    await this.releaseFences(assetId, organizationId, fenceId);

    // An owner that could not answer comes first, **before** any open work the
    // other reported: the picture is incomplete, so the caller must be told to
    // try again, not handed a definitive "blocked" that the unanswered owner
    // might contradict or add to. The unavailable answer (503/504) is preferred
    // to a fence conflict (409, retry), which is the milder of the two.
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason as unknown] : [],
    );
    if (failures.length > 0) {
      const unavailable = failures.find(
        (reason) =>
          reason instanceof RastaError &&
          (reason.code === 'UPSTREAM_UNAVAILABLE' || reason.code === 'UPSTREAM_TIMEOUT'),
      );
      throw unavailable ?? failures[0];
    }

    // Every owner answered, and at least one has open work: the refusal a
    // person can act on.
    const open: OpenWorkCode[] = [];
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === 'fulfilled' && !outcome.value.clear) {
        open.push(WORK_OWNERS[index] === FLEET_SERVICE ? 'OPEN_ASSIGNMENT' : 'OPEN_MAINTENANCE');
      }
    }
    if (open.length > 0) throw openWorkError(from, to, open);

    throw RastaError.internal('Withdrawal clearance returned no answer');
  }

  /** The ownership change itself, once every owner of the machine's work has cleared it. */
  private async commitTransfer(
    id: string,
    status: string,
    from: string,
    dto: TransferAssetDto,
    transferId: string,
    actor: string,
    assertWithinDeadline: () => void,
    markCommitBoundary: () => void,
  ): Promise<AssetView> {
    // A transfer is the one operation that legitimately writes rows belonging
    // to another tenant — the transfer record, the asset and its whole history
    // all land in the receiving organization. The tenant guard refuses that by
    // default, and rightly so, which is why the crossing is declared here
    // rather than worked around.
    //
    // What makes it safe is the order: `findById` above ran *scoped*, so the
    // caller has already proven they hold this asset, and the destination has
    // been checked to exist and be active. Only then is scoping lifted, and
    // only for this transaction.
    const updated = await runUnscoped(
      `ownership transfer of ${id} from ${from} to ${dto.toOrganizationId}`,
      () =>
        this.repository.transaction(async (tx) => {
          // First, so the row lock is held for everything below. Matching on
          // the organization as well as the status makes a concurrent transfer
          // a conflict too: this runs unscoped, so nothing else would notice
          // that the asset has already moved.
          const row = await this.compareAndSet(
            tx,
            id,
            status,
            {
              organizationId: dto.toOrganizationId,
              // Ownership changed, so the new owner must re-commission it with
              // their own paperwork. The insurance may be the one that came with
              // the vehicle (docs/24 Q-66).
              status: 'REGISTERED',
              // A new ownership generation, under the row lock this takes.
              // Policies recorded from here on carry it (PR #108 round 2 #5).
              ownershipGeneration: { increment: 1 },
              updatedBy: actor,
            },
            { organizationId: from },
          );

          // Dated by the database, under the row lock just taken, so the
          // transfer and every policy's created_at share one clock (PR #108
          // review #6). A policy write takes the same lock, so it lands
          // before this instant under the old owner, or is refused.
          const transferredAt = await this.repository.databaseClock(tx);

          // An open claim is being decided under the current owner's authority.
          // Moving it would hand that decision to the new owner. Checked under
          // the lock, together with the move.
          if (await this.repository.hasOpenClaims(tx, id)) {
            throw RastaError.businessRule(
              'The asset has an insurance claim that is still open. Decide or settle it before transferring the asset.',
              { rule: 'OPEN_INSURANCE_CLAIM' },
            );
          }

          await tx.assetTransfer.create({
            data: {
              id: transferId,
              assetId: id,
              fromOrganizationId: from,
              toOrganizationId: dto.toOrganizationId,
              // Scoped to the receiving organization, so the transfer shows up in
              // the new owner's history where it is actually useful.
              organizationId: dto.toOrganizationId,
              reason: dto.reason,
              referenceNo: dto.referenceNo ?? null,
              transferredAt,
              transferredBy: actor,
            },
          });

          // The whole history moves with the asset, which is what keeps the
          // dossier intact across a change of owner (ADR-012). That means every
          // asset-owned table, the insurance and inspection record included
          // (audit L3-08), and the earlier transfer records too. A table left
          // out here stays with the previous owner.
          const moved = { where: { assetId: id }, data: { organizationId: dto.toOrganizationId } };
          // The previous owner's documents do NOT go with the asset (docs/24 Q-99, provisional):
          // document-service keeps those files owned by the previous owner, so a reference moved
          // here would be one the new owner cannot read (404), and a later grant would hand it
          // private data nobody decided to share. The references stay the previous owner's rows —
          // its history, reachable by no read path of the new owner — and so do the timeline
          // entries that name them (`DOCUMENT`: the title is in the description). The new owner
          // starts with an empty documents list and attaches its own.
          await tx.assetTimelineEntry.updateMany({
            where: { assetId: id, category: { not: 'DOCUMENT' } },
            data: { organizationId: dto.toOrganizationId },
          });
          await tx.assetLocation.updateMany(moved);
          // A policy or claim holding a negative amount from before the
          // constraints (NOT VALID, L7-36) is refused by the database on any
          // UPDATE of its row: the transfer is refused as a closed 422, not a
          // 500, until an operator corrects it (#222 r1).
          await movingInsurance(id, 'InsurancePolicy', () => tx.insurancePolicy.updateMany(moved));
          await movingInsurance(id, 'InsuranceClaim', () => tx.insuranceClaim.updateMany(moved));
          await tx.technicalInspection.updateMany(moved);
          await tx.assetTransfer.updateMany(moved);

          await this.repository.enqueueEvent(tx, {
            aggregateType: 'Asset',
            aggregateId: id,
            eventName: ASSET_EVENTS.ASSET_TRANSFERRED,
            topic: ASSET_TOPIC,
            organizationId: dto.toOrganizationId,
            payload: validateAssetPayload(ASSET_EVENTS.ASSET_TRANSFERRED, {
              assetId: id,
              fromOrganizationId: from,
              toOrganizationId: dto.toOrganizationId,
              reason: dto.reason,
              referenceNo: dto.referenceNo ?? null,
              transferredAt: transferredAt.toISOString(),
            }),
          });

          await this.appendTimeline(tx, {
            assetId: id,
            organizationId: dto.toOrganizationId,
            eventName: ASSET_EVENTS.ASSET_TRANSFERRED,
            sourceEventId: transferId,
            category: 'TRANSFER',
            title: 'انتقال مالکیت',
            description: dto.reason,
            detail: { fromOrganizationId: from, toOrganizationId: dto.toOrganizationId },
            occurredAt: transferredAt,
          });

          // The fences hold for their TTL. Past half of it, measured from
          // before they were asked for, the transfer is not recorded: the
          // owners may soon let new work start (ADR-062 § 3). Last, after
          // every write, so only the commit itself is left outside the bound.
          assertWithinDeadline();
          markCommitBoundary();

          return row;
        }),
    );

    return toView(updated);
  }

  async recordLocation(id: string, dto: RecordLocationDto): Promise<AssetLocationView> {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);

    const locationId = await this.repository.transaction(async (tx) => {
      // Exclusive, so two recordings on one asset run one after the other.
      // Otherwise both demote the same incumbent and both insert a current row.
      await this.lockOwned(tx, id, asset.organizationId, 'EXCLUSIVE');

      // A partial unique index enforces one current location per asset, so the
      // incumbent has to be demoted before the new row lands.
      await tx.assetLocation.updateMany({
        where: { assetId: id, isCurrent: true },
        data: { isCurrent: false },
      });

      const newId = await this.insertLocation(tx, id, asset.organizationId, dto);

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Asset',
        aggregateId: id,
        eventName: ASSET_EVENTS.ASSET_LOCATION_RECORDED,
        topic: ASSET_TOPIC,
        organizationId: asset.organizationId,
        payload: validateAssetPayload(ASSET_EVENTS.ASSET_LOCATION_RECORDED, {
          assetId: id,
          organizationId: asset.organizationId,
          locationId: newId,
          hasCoordinate: dto.coordinate !== undefined,
          source: dto.source,
        }),
      });

      return newId;
    });

    const row = await this.repository.client.assetLocation.findFirstOrThrow({
      where: { id: locationId },
    });

    return {
      id: row.id,
      siteName: row.siteName,
      addressLine: row.addressLine,
      coordinate: await this.repository.readCoordinate(row.id, row.organizationId),
      source: row.source,
      recordedAt: row.recordedAt.toISOString(),
    };
  }

  /**
   * The document must be one this organization may see, still registered, and —
   * when document-service records an asset as its owner — this asset's.
   * Everything else, including a document of another organization and one that
   * does not exist, is the same `404` a missing document gets: the answer never
   * says which, so it is no oracle for another tenant's ids. An outage is not a
   * `404` and not a pass: it is the upstream error, and nothing is attached.
   *
   * Another organization's document never reaches the owner-reference check:
   * document-service answers `404` to a token scoped to a different owner. A
   * document registered for **another asset** of this organization is refused too,
   * because the reference says "this machine's document" — reuse of one file
   * across machines is a decision nobody has made (a document holds one owner
   * reference), so it is not made here.
   */
  private async assertDocumentIsTheirs(
    organizationId: string,
    assetId: string,
    documentId: string,
  ): Promise<void> {
    const found = await this.documentLookup.find(documentId, organizationId);
    const theirs =
      found !== null &&
      found.id === documentId &&
      found.organizationId === organizationId &&
      found.status === 'REGISTERED' &&
      (found.ownerResourceType !== 'Asset' || found.ownerResourceId === assetId);
    if (!theirs) throw RastaError.notFound('Document', documentId);
  }

  /**
   * Attaches a reference to a document document-service holds. Under an
   * Idempotency-Key, `fence` is the caller's claim on it (#169, as for the two
   * records of `insurance.service.ts`): locked as the transaction's first
   * statement, completed with the reference as its last, so the claim, the
   * reference, its outbox row, its timeline entry and the response to replay
   * commit together, or none of them does. A reference has no natural unique
   * key — the same document may be attached twice — so the key is the only
   * thing that stops a replayed form from attaching it twice.
   */
  async attachDocument(
    id: string,
    dto: AttachDocumentDto,
    fence?: ClaimFence<AttachedDocumentView>,
  ): Promise<AttachedDocumentView> {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);

    // Who owns the document is document-service's to say, asked before anything
    // is written and outside the transaction (a network call holds no lock). A
    // refusal or an outage here releases the idempotency claim, so a corrected
    // retry under the same key runs.
    await this.assertDocumentIsTheirs(asset.organizationId, id, dto.documentId);

    const refId = `ADR_${ulid()}`;
    const actor = getContext().userId ?? 'SYSTEM';

    return this.repository.transaction(async (tx) => {
      // The claim is locked by its token before anything else, so an attach
      // whose claim lapsed and was re-taken by a retry commits nothing.
      if (fence) await fence.hold(tx);
      await this.lockOwned(tx, id, asset.organizationId, 'SHARE');

      const row = await tx.assetDocumentRef.create({
        data: {
          id: refId,
          assetId: id,
          organizationId: asset.organizationId,
          documentId: dto.documentId,
          kind: dto.kind,
          title: dto.title,
          issuedAt: dto.issuedAt ? new Date(dto.issuedAt) : null,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          createdBy: actor,
        },
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Asset',
        aggregateId: id,
        eventName: ASSET_EVENTS.ASSET_DOCUMENT_ATTACHED,
        topic: ASSET_TOPIC,
        organizationId: asset.organizationId,
        payload: validateAssetPayload(ASSET_EVENTS.ASSET_DOCUMENT_ATTACHED, {
          assetId: id,
          organizationId: asset.organizationId,
          documentId: dto.documentId,
          kind: dto.kind,
          expiresAt: dto.expiresAt ?? null,
        }),
      });

      await this.appendTimeline(tx, {
        assetId: id,
        organizationId: asset.organizationId,
        eventName: ASSET_EVENTS.ASSET_DOCUMENT_ATTACHED,
        sourceEventId: refId,
        category: 'DOCUMENT',
        title: 'افزودن مدرک',
        description: dto.title,
        detail: { kind: dto.kind },
        occurredAt: new Date(),
      });

      const view: AttachedDocumentView = {
        id: row.id,
        documentId: row.documentId,
        kind: row.kind,
        title: row.title,
        issuedAt: row.issuedAt?.toISOString() ?? null,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      };
      return fence ? fence.complete(tx, view) : view;
    });
  }

  // =========================================================================
  // Called by event consumers
  // =========================================================================

  /**
   * Applies a status change that another service decided.
   *
   * fleet-service owns assignment and maintenance-service owns repair state.
   * This service records the consequence; it does not adjudicate it, which is
   * why the actor is `EVENT` and the transition table is stricter about what
   * a user may do directly.
   *
   * Runs inside the caller's transaction, the one that records the consumer's
   * dedupe marker. The marker, the timeline entry and the status change then
   * commit together or not at all (AGENTS.md A-09, audit L4-03). A conflict
   * with a concurrent write throws, so the whole transaction rolls back, the
   * marker included, and the redelivered event is judged again against the
   * state that won.
   */
  async applyEventStatusChange(
    tx: ExtendedPrismaClient,
    assetId: string,
    newStatus: AssetStatus,
    reason: string,
  ): Promise<void> {
    const asset = await this.repository.findById(assetId, tx);
    if (!asset) {
      // The event names an asset this service has never seen. Logged rather
      // than thrown: failing here would push a perfectly valid event into a
      // dead-letter topic over a race that resolves itself.
      this.logger.warn(`Ignoring status change for unknown asset ${assetId}`);
      return;
    }

    if (!canTransition(asset.status as AssetStatus, newStatus, 'EVENT')) {
      this.logger.warn(
        `Ignoring ${asset.status} -> ${newStatus} for ${assetId}: not a legal event transition`,
      );
      return;
    }

    await this.writeStatusChange(tx, assetId, asset, newStatus, reason);
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * Refuses a command made against a version that is no longer current, before
   * anything else is judged: a replay of a command that already committed (a
   * form sent twice, a retry after a lost answer) then reads as "the asset has
   * changed" — a 409 the caller can act on — and not as whatever the new state
   * makes of the same words, which for a terminal decommission is a 422 that
   * hides the replay. The write is guarded on the version again, so this is the
   * readable answer and the compare-and-set is the enforcement.
   */
  private assertVersion(asset: { id: string; version: number }, expected: number): void {
    if (asset.version !== expected) throw RastaError.optimisticLockFailed('Asset', asset.id);
  }

  private assertTransition(from: AssetStatus, to: AssetStatus, actor: TransitionActor): void {
    if (canTransition(from, to, actor)) return;

    const message = explainRefusal(from, to, actor);
    const openWork = openWorkRefusal(from, actor);
    if (!openWork) throw RastaError.invalidStateTransition('Asset', from, to, message);

    // Other work is open on the asset (docs/24 Q-94): the refusal carries a
    // closed reason code a client can act on without reading the sentence.
    throw openWorkError(from, to, [openWork.code]);
  }

  /**
   * Writes a status change with its outbox event and timeline entry, in `tx`.
   *
   * `asset.status` is the status the transition was judged against, and the
   * update matches on it (audit L3-07). `expectedVersion`, when the caller has
   * one, is matched too.
   */
  private async writeStatusChange(
    tx: ExtendedPrismaClient,
    id: string,
    asset: { organizationId: string; status: string },
    newStatus: AssetStatus,
    reason: string,
    expectedVersion?: number,
  ) {
    const actor = getContext().userId ?? 'SYSTEM';
    const previousStatus = asset.status;

    const row = await this.compareAndSet(
      tx,
      id,
      previousStatus,
      { status: newStatus, updatedBy: actor },
      // A user's command names the version it was made against; an event from
      // another service has none and is judged on the status alone.
      expectedVersion === undefined ? {} : { version: expectedVersion },
    );

    await this.repository.enqueueEvent(tx, {
      aggregateType: 'Asset',
      aggregateId: id,
      eventName: ASSET_EVENTS.ASSET_STATUS_CHANGED,
      topic: ASSET_TOPIC,
      organizationId: asset.organizationId,
      payload: validateAssetPayload(ASSET_EVENTS.ASSET_STATUS_CHANGED, {
        assetId: id,
        organizationId: asset.organizationId,
        previousStatus,
        newStatus,
        reason,
      }),
    });

    await this.appendTimeline(tx, {
      assetId: id,
      organizationId: asset.organizationId,
      eventName: ASSET_EVENTS.ASSET_STATUS_CHANGED,
      sourceEventId: `local-${id}-status-${Date.now()}`,
      category: 'LIFECYCLE',
      title: `تغییر وضعیت به ${newStatus}`,
      description: reason,
      detail: { previousStatus, newStatus },
      occurredAt: new Date(),
    });

    return row;
  }

  /**
   * Whether a policy counts for the asset's current owner (docs/24 Q-66). One
   * rule for activation, the dossier and claims (src/insurance/ownership.ts).
   */
  async policyCountsForCurrentOwner(
    assetId: string,
    policy: { coverage: string; ownershipGeneration: number },
  ): Promise<boolean> {
    const generation = await this.repository.ownershipGeneration(assetId);
    return countsForCurrentOwner(policy, generation, this.transferInsurance);
  }

  /** The in-force policy that counts for the current owner, if any. */
  private async findCountingPolicy(assetId: string) {
    const generation = await this.repository.ownershipGeneration(assetId);
    return this.repository.findActivePolicy(
      assetId,
      new Date(),
      currentOwnerPolicyFilter(generation, this.transferInsurance),
    );
  }

  /**
   * Compare-and-set on the status a decision was made from, then the fresh row.
   *
   * Zero rows means the asset changed since it was read, whether to another
   * status, to another owner or out of existence. The request fails with a
   * conflict instead of writing over that change. In particular, nothing
   * overwrites a DECOMMISSIONED row (audit L3-07).
   */
  private async compareAndSet(
    tx: ExtendedPrismaClient,
    id: string,
    expectedStatus: string,
    data: Record<string, unknown>,
    where: { organizationId?: string; version?: number } = {},
  ) {
    const changed = await this.repository.compareAndSetStatus(tx, id, expectedStatus, data, where);
    if (changed === 0) throw RastaError.optimisticLockFailed('Asset', id);
    return this.reread(tx, id);
  }

  private async reread(tx: ExtendedPrismaClient, id: string) {
    const row = await this.repository.findById(id, tx);
    if (!row) throw RastaError.optimisticLockFailed('Asset', id);
    return row;
  }

  /**
   * Locks the asset before a record is hung off it under `organizationId`.
   *
   * Refuses when the asset is no longer that organization's. A transfer that
   * committed after the caller's read would otherwise leave the new record
   * with the previous owner (audit L3-08).
   */
  private async lockOwned(
    tx: ExtendedPrismaClient,
    id: string,
    organizationId: string,
    mode: 'SHARE' | 'EXCLUSIVE',
  ): Promise<void> {
    const locked = await this.repository.lockAsset(tx, id, organizationId, mode);
    if (!locked) throw RastaError.notFound('Asset', id);
  }

  private async insertLocation(
    tx: ExtendedPrismaClient,
    assetId: string,
    organizationId: string,
    dto: RecordLocationDto,
  ): Promise<string> {
    const locationId = `ALC_${ulid()}`;
    const actor = getContext().userId ?? 'SYSTEM';

    await tx.assetLocation.create({
      data: {
        id: locationId,
        assetId,
        organizationId,
        siteName: dto.siteName ?? null,
        addressLine: dto.addressLine ?? null,
        source: dto.source ?? 'MANUAL',
        isCurrent: true,
        recordedBy: actor,
      },
    });

    if (dto.coordinate) {
      await this.repository.setLocationPoint(
        tx,
        locationId,
        organizationId,
        dto.coordinate.latitude,
        dto.coordinate.longitude,
      );
    }

    return locationId;
  }

  /**
   * Appends a line to the dossier.
   *
   * Tolerates a duplicate rather than failing: the unique index on
   * `sourceEventId` is what makes an event replay safe, and hitting it means
   * the line is already there — which is success, not an error.
   */
  async appendTimeline(
    tx: ExtendedPrismaClient,
    entry: {
      assetId: string;
      organizationId: string;
      eventName: string;
      sourceEventId: string;
      sourceService?: string;
      category: TimelineCategory;
      title: string;
      description?: string;
      amountMinor?: bigint | null;
      detail?: Record<string, unknown>;
      occurredAt: Date;
    },
  ): Promise<void> {
    try {
      await tx.assetTimelineEntry.create({
        data: {
          id: `ATL_${ulid()}`,
          assetId: entry.assetId,
          organizationId: entry.organizationId,
          eventName: entry.eventName,
          sourceService: entry.sourceService ?? 'asset-service',
          sourceEventId: entry.sourceEventId,
          category: entry.category,
          title: entry.title,
          description: entry.description ?? null,
          amountMinor: entry.amountMinor ?? null,
          detail: (entry.detail ?? {}) as object,
          occurredAt: entry.occurredAt,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return;
      throw error;
    }
  }
}

/**
 * Turns a unique-index violation into the same refusal the pre-checks give.
 *
 * The pre-checks give a readable error in the common case. Under a concurrent
 * create or rename they both pass, and the index is what refuses.
 */
/** The metric label for one owner's answer (ADR-062). */
/**
 * The refusal for a command that open work stops (docs/24 Q-94): 409
 * INVALID_STATE_TRANSITION whose `details` carry one closed code per kind of
 * work, on the `status` path. Nothing a client typed goes in it, in the
 * response or in the logged context (S-09).
 */
/**
 * Moves an asset's policies or claims to the new owner, refusing with a closed
 * 422 when one of them holds a negative amount the database will not keep. The
 * move writes only `organizationId`, so a refused amount is always a stored
 * one, never the caller's.
 */
async function movingInsurance(
  assetId: string,
  type: 'InsurancePolicy' | 'InsuranceClaim',
  move: () => Promise<unknown>,
): Promise<void> {
  try {
    await move();
  } catch (error) {
    throw storedAmountRefusal(error, {}, { type, assetId }) ?? error;
  }
}

function openWorkError(from: string, to: string, codes: readonly OpenWorkCode[]): RastaError {
  const message = codes.map((code) => OPEN_WORK_MESSAGES[code]).join(' ');
  return new RastaError('INVALID_STATE_TRANSITION', message, {
    details: codes.map((code) => ({ path: 'status', message: OPEN_WORK_MESSAGES[code], code })),
    internalContext: { aggregate: 'Asset', from, to, reason: codes.join(',') },
  });
}

function clearanceOutcome(
  outcome: PromiseSettledResult<ClearanceAnswer>,
): 'clear' | 'open_work' | 'conflict' | 'unavailable' {
  if (outcome.status === 'fulfilled') return outcome.value.clear ? 'clear' : 'open_work';
  const reason: unknown = outcome.reason;
  return reason instanceof RastaError && reason.code === 'INVALID_STATE_TRANSITION'
    ? 'conflict'
    : 'unavailable';
}

function rethrowUniqueAsAlreadyExists(error: unknown): never {
  if (isUniqueViolation(error)) throw RastaError.alreadyExists('Asset');
  throw error;
}

// ---------------------------------------------------------------------------
// View mapping — explicit whitelists, so a new column is never exposed by
// accident
// ---------------------------------------------------------------------------

interface AssetRow {
  id: string;
  organizationId: string;
  assetTag: string | null;
  name: string;
  type: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  manufactureYear: number | null;
  status: string;
  commissionedAt: Date | null;
  decommissionedAt: Date | null;
  specifications: unknown;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

type AssetFieldChanges = Partial<
  Pick<
    UpdateAssetDto,
    'name' | 'assetTag' | 'manufacturer' | 'model' | 'manufactureYear' | 'specifications'
  >
>;

/**
 * The fields of an edit whose value differs from the row's. `null` is a value
 * (it clears the field) and `undefined` is absence, so a key is present in the
 * result exactly when the edit would change it.
 */
function changedAssetFields(
  current: AssetRow,
  edit: Omit<UpdateAssetDto, 'expectedVersion'>,
): AssetFieldChanges {
  const changes: AssetFieldChanges = {};
  if (edit.name !== undefined && edit.name !== current.name) changes.name = edit.name;
  if (edit.assetTag !== undefined && edit.assetTag !== current.assetTag) {
    changes.assetTag = edit.assetTag;
  }
  if (edit.manufacturer !== undefined && edit.manufacturer !== current.manufacturer) {
    changes.manufacturer = edit.manufacturer;
  }
  if (edit.model !== undefined && edit.model !== current.model) changes.model = edit.model;
  if (edit.manufactureYear !== undefined && edit.manufactureYear !== current.manufactureYear) {
    changes.manufactureYear = edit.manufactureYear;
  }
  if (
    edit.specifications !== undefined &&
    !isDeepStrictEqual(edit.specifications, current.specifications ?? {})
  ) {
    changes.specifications = edit.specifications;
  }
  return changes;
}

function toView(asset: AssetRow): AssetView {
  return {
    id: asset.id,
    organizationId: asset.organizationId,
    assetTag: asset.assetTag,
    name: asset.name,
    type: asset.type,
    manufacturer: asset.manufacturer,
    model: asset.model,
    serialNumber: asset.serialNumber,
    manufactureYear: asset.manufactureYear,
    status: asset.status,
    commissionedAt: asset.commissionedAt?.toISOString() ?? null,
    decommissionedAt: asset.decommissionedAt?.toISOString() ?? null,
    specifications: (asset.specifications ?? {}) as Record<string, unknown>,
    version: asset.version,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
  };
}

interface TimelineRow {
  id: string;
  eventName: string;
  sourceService: string;
  category: string;
  title: string;
  description: string | null;
  amountMinor: bigint | null;
  detail: unknown;
  occurredAt: Date;
}

function toTimelineView(entry: TimelineRow): TimelineEntryView {
  return {
    id: entry.id,
    eventName: entry.eventName,
    sourceService: entry.sourceService,
    category: entry.category,
    title: entry.title,
    description: entry.description,
    // Money crosses the wire as a string so large rial amounts survive JSON
    // intact (ADR-022).
    amountMinor: entry.amountMinor?.toString() ?? null,
    detail: (entry.detail ?? {}) as Record<string, unknown>,
    occurredAt: entry.occurredAt.toISOString(),
  };
}

/** Negative once the date has passed, so a client can say "expired 3 days ago". */
function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

function summariseCosts(rows: CostSummaryRow[]): AssetDossierView['costs'] {
  const byCategory = new Map(rows.map((r) => [r.category, r]));

  const maintenance = BigInt(byCategory.get('MAINTENANCE')?.total_minor ?? '0');
  const cost = BigInt(byCategory.get('COST')?.total_minor ?? '0');
  const total = rows.reduce((sum, row) => sum + BigInt(row.total_minor), 0n);
  const entryCount = rows.reduce((sum, row) => sum + row.entry_count, 0);

  return {
    totalMinor: total.toString(),
    maintenanceMinor: maintenance.toString(),
    partsAndOrdersMinor: cost.toString(),
    entryCount,
  };
}
